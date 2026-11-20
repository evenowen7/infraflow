import { randomUUID } from 'node:crypto';
import type { ExecutionRun, Request as FlowRequest, RequestStatus } from '@prisma/client';
import { z } from 'zod';
import { createMetadataSchema, observation, type ExecutionContext } from '../../../packages/adapters/src/index.js';
import { db } from '../../api/src/db.js';
import { adapter, audit, errorInfo, lockRequest, newOperationId, targetLockKey, transition, validateExecution, type Tx } from '../../api/src/workflow.js';
import { authorize, ensure, hash, json, type Actor } from '../../api/src/security.js';

const leaseMs = () => Number(process.env.WORKER_LEASE_SECONDS??30)*1000;
export async function runEvent(tx: Tx, runId: string, kind: string, message: string, payload: unknown = {}) {
  return tx.runEvent.create({data:{runId,kind,message,payload:json(payload)}});
}
async function finish(tx: Tx, run: ExecutionRun, request: FlowRequest, status: RequestStatus, precheck: unknown, postcheck: unknown, verified: boolean) {
  await transition(tx,request,status,null,{runId:run.id,postcheck});
  await tx.executionRun.update({where:{id:run.id},data:{status,finishedAt:new Date(),leaseExpiresAt:null,leaseOwner:null}});
  await tx.evidence.create({data:{runId:run.id,mode:'DEMO',outcome:status,verified,precheck:json(precheck),postcheck:json(postcheck),correlationId:request.correlationId}});
  await runEvent(tx,run.id,status,status==='REQUIRES_REVIEW'?'Hasil belum pasti; resource dikunci sampai rekonsiliasi':`Hasil verifikasi: ${status}`,postcheck);
  if (status!=='REQUIRES_REVIEW') await tx.resourceLock.deleteMany({where:{runId:run.id}});
  if (request.ticketId) {
    await tx.externalTicket.update({where:{id:request.ticketId},data:{syncStatus:'PENDING'}});
    await tx.outboxEvent.upsert({where:{dedupeKey:`${run.id}:${status}`},update:{},create:{ticketId:request.ticketId,dedupeKey:`${run.id}:${status}`,payload:json({mode:'DEMO',requestId:request.id,runId:run.id,correlationId:request.correlationId,status,verified,postcheck})}});
  }
}
export async function claimRun(owner: string): Promise<string|null> {
  return db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{id:string;requestId:string}[]>`
      SELECT r.id, r."requestId" FROM "ExecutionRun" r JOIN "Request" q ON q.id=r."requestId"
      WHERE r.status IN ('QUEUED','SCHEDULED') AND q.status IN ('QUEUED','SCHEDULED') AND r."availableAt"<=NOW()
      AND NOT EXISTS (
        SELECT 1 FROM "ResourceLock" l JOIN "ExecutionRun" lr ON lr.id=l."runId" JOIN "Request" lq ON lq.id=lr."requestId"
        WHERE l.key = CASE WHEN q.action='CREATE_VM' THEN 'create:demo:' || (q.parameters->>'name') ELSE 'resource:' || q."resourceId" END
        OR (q."resourceId" IS NOT NULL AND lq."resourceId"=q."resourceId")
      )
      ORDER BY r."createdAt" FOR UPDATE OF r SKIP LOCKED LIMIT 1`;
    const row = rows[0];
    if (!row) return null;
    const request = await lockRequest(tx,row.requestId);
    if (!['QUEUED','SCHEDULED'].includes(request.status)) return null;
    const key = targetLockKey(request);
    if (request.resourceId) await tx.$queryRaw`SELECT id FROM "Resource" WHERE id=${request.resourceId} FOR UPDATE`;
    const inserted = await tx.$executeRaw`INSERT INTO "ResourceLock" (key,"runId","acquiredAt") VALUES (${key},${row.id},NOW()) ON CONFLICT DO NOTHING`;
    if (!inserted) return null;
    await transition(tx,request,'RUNNING',null,{worker:owner});
    await tx.executionRun.update({where:{id:row.id},data:{status:'RUNNING',leaseOwner:owner,leaseExpiresAt:new Date(Date.now()+leaseMs()),startedAt:new Date()}});
    await runEvent(tx,row.id,'CLAIMED','Worker mengambil job dan resource lock secara atomik',{owner,correlationId:request.correlationId});
    return row.id;
  });
}
async function lockOwnedRun(tx: Tx, id: string, owner: string) {
  await tx.$queryRaw`SELECT id FROM "ExecutionRun" WHERE id=${id} FOR UPDATE`;
  const run = await tx.executionRun.findUniqueOrThrow({where:{id}});
  ensure(run.leaseOwner===owner && run.leaseExpiresAt && run.leaseExpiresAt>new Date(),409,'LEASE_LOST','Worker kehilangan lease; dispatch diblokir');
  return run;
}
const beforeSchema = z.object({id:z.string(),externalId:z.string(),adapterId:z.string(),bootMarker:z.string().nullable()});
const intentSchema = z.object({operationId:z.string(),before:beforeSchema.nullable()});
const dispatchedSchema = z.object({operationId:z.string(),resourceId:z.string()});
const snapshotSchema = z.object({action:z.string(),parameters:z.unknown(),teamId:z.string(),environment:z.string(),target:z.object({id:z.string(),externalId:z.string(),adapterId:z.string()}).nullable(),create:createMetadataSchema.optional()});
async function verifyRun(tx: Tx, run: ExecutionRun, request: FlowRequest) {
  const resource = request.resourceId?await tx.resource.findUnique({where:{id:request.resourceId}}):null;
  if (request.action==='POWER_ON_VM') return adapter.verify(request.action,resource);
  const events = await tx.runEvent.findMany({where:{runId:run.id,kind:{in:['DISPATCHING','DISPATCHED']}}});
  const intents = events.filter(e=>e.kind==='DISPATCHING');
  const dispatches = events.filter(e=>e.kind==='DISPATCHED');
  const intent = intentSchema.safeParse(intents[0]?.payload);
  const dispatched = dispatchedSchema.safeParse(dispatches[0]?.payload);
  const snapshot = snapshotSchema.safeParse(request.snapshot);
  const approval = await tx.approval.findUnique({where:{requestId_requestVersion:{requestId:request.id,requestVersion:request.version}}});
  const bound = snapshot.success && hash(request.snapshot)===request.snapshotHash && approval?.snapshotHash===request.snapshotHash && approval.decision==='APPROVE' && snapshot.data.action===request.action && hash(snapshot.data.parameters)===hash(request.parameters) && snapshot.data.teamId===request.teamId && snapshot.data.environment===request.environment;
  const context: ExecutionContext = {
    operationId:run.externalOperationId,before:intent.success?intent.data.before:null,create:snapshot.success?snapshot.data.create:null,
    dispatched:bound && intents.length===1 && dispatches.length===1 && intent.success && dispatched.success && run.dispatchPhase==='DISPATCHED' && run.externalOperationId===intent.data.operationId && run.externalOperationId===dispatched.data.operationId && request.resourceId===dispatched.data.resourceId,
  };
  if (request.action==='RESTART_VM') context.dispatched = context.dispatched && snapshot.success && snapshot.data.target?.id===context.before?.id && snapshot.data.target?.externalId===context.before?.externalId && snapshot.data.target?.adapterId===context.before?.adapterId;
  else context.dispatched = context.dispatched && snapshot.success && snapshot.data.target===null && !!context.create && hash(context.create.parameters)===hash(request.parameters);
  return adapter.verify(request.action,resource,context);
}
export async function executeRun(id: string, owner: string) {
  try {
    const proceed = await db.$transaction(async tx => {
      const run = await lockOwnedRun(tx,id,owner);
      const request = await lockRequest(tx,run.requestId);
      ensure(run.dispatchPhase==='NOT_DISPATCHED' && request.status==='RUNNING',409,'DISPATCH_BLOCKED','Operasi sudah dikirim atau status berubah');
      const target = await validateExecution(tx,request);
      await lockOwnedRun(tx,id,owner);
      if (request.action==='POWER_ON_VM' && target.resource?.powerState==='poweredOn') {
        const verification = adapter.verify(request.action,target.resource);
        await finish(tx,run,request,verification.verified?'COMPLETED_NOOP':'FAILED',target.precheck,verification,verification.verified);
        return false;
      }
      const operationId = newOperationId();
      await tx.executionRun.update({where:{id},data:{dispatchPhase:'DISPATCHING',externalOperationId:operationId,leaseExpiresAt:new Date(Date.now()+leaseMs())}});
      await runEvent(tx,id,'DISPATCHING','Intent dispatch disimpan sebelum mutasi',{precheck:target.precheck,operationId,before:target.resource?observation(target.resource):null});
      return true;
    });
    if (!proceed) return;
    const dispatched = await db.$transaction(async tx => {
      const run = await lockOwnedRun(tx,id,owner);
      const request = await lockRequest(tx,run.requestId);
      ensure(run.dispatchPhase==='DISPATCHING' && request.status==='RUNNING',409,'DISPATCH_BLOCKED','Dispatch phase tidak sesuai');
      const target = await validateExecution(tx,request);
      await lockOwnedRun(tx,id,owner);
      const lock = await tx.resourceLock.findUnique({where:{key:targetLockKey(request)}});
      ensure(lock?.runId===id,409,'LOCK_LOST','Lock target tidak dimiliki worker');
      await tx.runEvent.updateMany({where:{runId:id,kind:'DISPATCHING'},data:{payload:json({precheck:target.precheck,operationId:run.externalOperationId,before:target.resource?observation(target.resource):null})}});
      const result = await adapter.dispatch(tx,request,target.resource,run.externalOperationId!,{create:target.create});
      const linkedRequest = {...request,resourceId:result.resourceId};
      if (request.action==='CREATE_VM') await tx.resourceLock.update({where:{runId:id},data:{key:`resource:${result.resourceId}`}});
      await tx.executionRun.update({where:{id},data:{dispatchPhase:'DISPATCHED'}});
      await runEvent(tx,id,'DISPATCHED','Demo adapter menyimpan perubahan VM di PostgreSQL',{operationId:result.operationId,resourceId:result.resourceId,mode:'DEMO'});
      if (target.resource?.scenario==='SECRET_LOG') await runEvent(tx,id,'ADAPTER_LOG','Fixture authorization: Bearer example-secret-token password=sample-password',{token:'sample-token',nested:{privateKey:'fixture-private-key'}});
      if (result.uncertain) {
        await finish(tx,run,linkedRequest,'REQUIRES_REVIEW',target.precheck,{code:'DISPATCH_TIMEOUT',message:'Timeout sesudah dispatch; tidak ada pengiriman ulang otomatis'},false);
        return false;
      }
      await transition(tx,linkedRequest,'VERIFYING',null,{operationId:result.operationId});
      await tx.executionRun.update({where:{id},data:{status:'VERIFYING',leaseExpiresAt:new Date(Date.now()+leaseMs())}});
      await runEvent(tx,id,'VERIFYING','Memeriksa observed power state, guest, dan service health');
      return true;
    });
    if (!dispatched) return;
    await db.$transaction(async tx => {
      const run = await lockOwnedRun(tx,id,owner);
      const request = await lockRequest(tx,run.requestId);
      ensure(request.status==='VERIFYING',409,'INVALID_TRANSITION','Request tidak sedang diverifikasi');
      const verification = await verifyRun(tx,run,request);
      await finish(tx,run,request,verification.verified?'SUCCEEDED':'FAILED',request.precheck,verification,verification.verified);
    });
  } catch (error) {
    const info = errorInfo(error);
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ExecutionRun" WHERE id=${id} FOR UPDATE`;
      const run = await tx.executionRun.findUniqueOrThrow({where:{id}});
      if (run.leaseOwner!==owner || !['RUNNING','VERIFYING'].includes(run.status)) return;
      const request = await lockRequest(tx,run.requestId);
      const status = run.dispatchPhase!=='NOT_DISPATCHED'?'REQUIRES_REVIEW':info.code==='APPROVAL_EXPIRED'?'EXPIRED':'FAILED';
      await finish(tx,run,request,status,request.precheck,info,false);
    });
  }
}
export async function recoverExpiredLeases() {
  return db.$transaction(async tx => {
    const runs = await tx.$queryRaw<ExecutionRun[]>`SELECT * FROM "ExecutionRun" WHERE status IN ('RUNNING','VERIFYING') AND "leaseExpiresAt"<NOW() FOR UPDATE SKIP LOCKED`;
    for (const run of runs) {
      const request = await lockRequest(tx,run.requestId);
      await finish(tx,run,request,'REQUIRES_REVIEW',request.precheck,{code:'WORKER_LEASE_EXPIRED',dispatchPhase:run.dispatchPhase,message:'Worker terputus. Tidak ada automatic redispatch; operator harus memeriksa target.'},false);
    }
    return runs.length;
  });
}
export async function expireScheduledApprovals() {
  const expired = await db.executionRun.findMany({where:{status:{in:['QUEUED','SCHEDULED']},request:{approvals:{some:{decision:'APPROVE',expiresAt:{lte:new Date()}}}}},select:{requestId:true}});
  for (const item of expired) await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ExecutionRun" WHERE "requestId"=${item.requestId} FOR UPDATE`;
    const request = await lockRequest(tx,item.requestId);
    if (!['QUEUED','SCHEDULED'].includes(request.status)) return;
    await transition(tx,request,'EXPIRED',null);
    await tx.executionRun.updateMany({where:{requestId:request.id,status:{in:['QUEUED','SCHEDULED']}},data:{status:'EXPIRED',finishedAt:new Date()}});
  });
}
export async function reconcileRun(actor: Actor,id: string,reason: string,outcome: 'CONFIRMED_SUCCEEDED'|'CONFIRMED_FAILED') {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ExecutionRun" WHERE id=${id} FOR UPDATE`;
    const run = await tx.executionRun.findUnique({where:{id}});
    ensure(run,404,'NOT_FOUND','Run tidak ditemukan');
    const request = await lockRequest(tx,run.requestId);
    authorize(actor,request,['OPERATOR']);
    ensure(request.status==='REQUIRES_REVIEW',409,'INVALID_TRANSITION','Rekonsiliasi hanya untuk hasil tidak pasti');
    ensure(process.env.APP_MODE==='DEMO',503,'NOT_CONFIGURED','Rekonsiliasi connected belum tersedia');
    const verification = await verifyRun(tx,run,request);
    if (outcome==='CONFIRMED_SUCCEEDED') ensure(verification.verified,422,'VERIFICATION_FAILED','Observasi belum memenuhi kontrak verifier');
    else ensure(!verification.verified || run.dispatchPhase==='NOT_DISPATCHED',422,'OBSERVATION_CONFLICT','Observasi menunjukkan hasil sukses; keputusan gagal tidak cocok');
    await audit(tx,request,'RECONCILIATION',actor.id,{reason,outcome,observation:verification},id);
    await finish(tx,run,request,outcome==='CONFIRMED_SUCCEEDED'?'SUCCEEDED':'FAILED',request.precheck,{reason,outcome,verification,operatorId:actor.id},outcome==='CONFIRMED_SUCCEEDED');
    return tx.executionRun.findUniqueOrThrow({where:{id}});
  });
}
export async function processOutbox() {
  return db.$transaction(async tx => {
    const rows = await tx.$queryRaw<{id:string;ticketId:string;requestStatus:RequestStatus}[]>`
      SELECT e.id, e."ticketId", q.status AS "requestStatus" FROM "OutboxEvent" e JOIN "Request" q ON q."ticketId"=e."ticketId"
      WHERE e.status='PENDING' AND e."availableAt"<=NOW() ORDER BY e."createdAt" FOR UPDATE OF q SKIP LOCKED LIMIT 1`;
    const row = rows[0];
    if (!row) return false;
    await tx.$queryRaw`SELECT id FROM "ExternalTicket" WHERE id=${row.ticketId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "OutboxEvent" WHERE id=${row.id} FOR UPDATE`;
    const event = await tx.outboxEvent.findUniqueOrThrow({where:{id:row.id},include:{ticket:true}});
    if (event.status!=='PENDING') return false;
    if (z.object({status:z.string()}).parse(event.payload).status!==row.requestStatus) {
      await tx.outboxEvent.update({where:{id:event.id},data:{status:'SUPERSEDED',lastError:'Digantikan oleh hasil request yang lebih baru; tidak dikirim'}});
      return true;
    }
    const attempts = event.attempts+1;
    if (event.ticket.simulateSyncFailure) {
      await tx.outboxEvent.update({where:{id:event.id},data:{attempts,status:attempts>=3?'FAILED':'PENDING',lastError:'Simulator service desk tidak tersedia',availableAt:new Date(Date.now()+attempts*1000)}});
      await tx.externalTicket.update({where:{id:event.ticketId},data:{syncStatus:attempts>=3?'FAILED':'PENDING',syncAttempts:{increment:1}}});
    } else {
      await tx.outboxEvent.update({where:{id:event.id},data:{attempts,status:'SYNCED',lastError:null}});
      await tx.externalTicket.update({where:{id:event.ticketId},data:{syncStatus:'SYNCED',result:json(event.payload),syncAttempts:{increment:1}}});
    }
    return true;
  });
}
export async function tick(owner: string = randomUUID()) {
  await recoverExpiredLeases();
  await expireScheduledApprovals();
  const id = await claimRun(owner);
  if (id) await executeRun(id,owner);
  await processOutbox();
  return id;
}
