import { randomUUID } from 'node:crypto';
import { Prisma, type Request as FlowRequest, type RequestStatus } from '@prisma/client';
import { createRequestSchema, createVmParameters, updateDraftSchema, powerParameters, transitions } from '../../../packages/contracts/src/index.js';
import { createMetadataSchema, DemoAdapter } from '../../../packages/adapters/src/index.js';
import { db } from './db.js';
import { AppError, authorize, can, ensure, hash, json, type Actor } from './security.js';

export type Tx = Prisma.TransactionClient;
export const adapter = new DemoAdapter();
export const userSelect = { id:true,email:true,name:true } as const;
export async function lockRequest(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM "Request" WHERE id = ${id} FOR UPDATE`;
  const request = await tx.request.findUnique({where:{id}});
  ensure(request,404,'NOT_FOUND','Request tidak ditemukan');
  return request;
}
export async function audit(tx: Tx, request: FlowRequest, action: string, actorId: string|null, details: unknown = {}, runId?: string) {
  return tx.auditEvent.create({data:{teamId:request.teamId,environment:request.environment,requestId:request.id,actorId,action,details:json(details),correlationId:request.correlationId,source:request.source,runId}});
}
export async function transition(tx: Tx, request: FlowRequest, next: RequestStatus, actorId: string|null, details: unknown = {}) {
  ensure(transitions[request.status].includes(next),409,'INVALID_TRANSITION',`Transisi ${request.status} ke ${next} tidak diizinkan`);
  const changed = await tx.request.updateMany({where:{id:request.id,status:request.status,version:request.version},data:{status:next}});
  ensure(changed.count===1,409,'CONCURRENT_CHANGE','Request telah berubah');
  await audit(tx,request,next,actorId,details);
  return { ...request,status:next };
}
const reservedStatuses: RequestStatus[] = ['DRAFT','AWAITING_APPROVAL','APPROVED','SCHEDULED','QUEUED','RUNNING','VERIFYING','REQUIRES_REVIEW'];
export function targetLockKey(request: Pick<FlowRequest,'action'|'parameters'|'resourceId'>) {
  if (request.action==='CREATE_VM') return `create:demo:${createVmParameters.parse(request.parameters).name}`;
  ensure(request.resourceId,422,'INVALID_TARGET','Resource target wajib tersedia');
  return `resource:${request.resourceId}`;
}
async function lockCreateTarget(tx: Tx, parameters: unknown) {
  const p = createVmParameters.parse(parameters);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`create:demo:${p.name}`}, 0))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:demo:${p.teamId}`}, 0))`;
  await tx.$queryRaw`SELECT t.id FROM "Template" t, "SizeProfile" s, "NetworkProfile" n WHERE t.id=${p.templateId} AND s.id=${p.sizeId} AND n.id=${p.networkId} FOR SHARE OF t,s,n`;
}
async function createMetadata(tx: Tx, parameters: unknown) {
  const p = createVmParameters.parse(parameters);
  const [template,size,network] = await Promise.all([
    tx.template.findUnique({where:{id:p.templateId}}),tx.sizeProfile.findUnique({where:{id:p.sizeId}}),tx.networkProfile.findUnique({where:{id:p.networkId}}),
  ]);
  ensure(template?.enabled,422,'INVALID_TEMPLATE','Template tidak tersedia');
  ensure(size,422,'INVALID_SIZE','Ukuran tidak tersedia');
  ensure(network && network.teamId===p.teamId,422,'INVALID_NETWORK','Network harus tersedia pada team yang sama');
  return createMetadataSchema.parse({parameters:p,template,size,network});
}
export async function validateTarget(tx: Tx, actor: Actor, action: FlowRequest['action'], resourceId: string|null, parameters: unknown, schedule: Date|null, enforceFuture = true, requestId?: string) {
  const service = await tx.serviceDefinition.findUnique({where:{action}});
  ensure(service?.enabled,503,'NOT_CONFIGURED','Layanan belum tersedia');
  ensure(process.env.APP_MODE==='DEMO',503,'NOT_CONFIGURED','Connected belum dikonfigurasi; tidak ada fallback');
  if (schedule && enforceFuture) ensure(schedule.getTime()>Date.now(),422,'PAST_SCHEDULE','Jadwal harus di masa depan (WIB)');
  if (action==='CREATE_VM') {
    const p = createVmParameters.parse(parameters);
    ensure(!resourceId,422,'INVALID_TARGET','Create VM tidak menerima resource yang sudah ada');
    authorize(actor,p,['REQUESTER']);
    await lockCreateTarget(tx,p);
    const create = await createMetadata(tx,p);
    const owner = await tx.user.findUnique({where:{email:p.owner},include:{assignments:true}});
    ensure(owner && can(owner,p.teamId,p.environment,['REQUESTER']),422,'INVALID_OWNER','Owner harus akun requester aktif dalam scope yang sama');
    const existing = await tx.resource.findUnique({where:{adapterId_name:{adapterId:'demo',name:p.name}}});
    const reserved = await tx.request.findFirst({where:{action:'CREATE_VM',id:requestId?{not:requestId}:undefined,status:{in:reservedStatuses},parameters:{path:['name'],equals:p.name}}});
    ensure(!existing && !reserved,409,'NAME_CONFLICT','Nama VM sudah digunakan atau dipesan');
    const quota = await tx.resource.aggregate({where:{adapterId:'demo',teamId:p.teamId},_count:{_all:true},_sum:{cpu:true}});
    ensure(quota._count._all<50 && (quota._sum.cpu??0)+create.size.cpu<=200,422,'QUOTA_EXCEEDED','Kuota demo per team: 50 VM dan 200 CPU');
    const precheck = adapter.precheck(action,null,{create});
    ensure(precheck.ready,422,'PRECHECK_FAILED','Precheck create tidak terpenuhi');
    return {resource:null,create,teamId:p.teamId,environment:p.environment,precheck,service};
  }
  powerParameters.parse(parameters);
  const resource = resourceId ? await tx.resource.findUnique({where:{id:resourceId}}) : null;
  ensure(resource,422,'INVALID_TARGET','Pilih VM dari katalog');
  authorize(actor,resource,['REQUESTER']);
  ensure(resource.environment!=='PRODUCTION',403,'PRODUCTION_DENIED','Perubahan production tidak diizinkan pada MVP');
  ensure(resource.adapterId==='demo',503,'NOT_CONFIGURED','Adapter target belum terhubung');
  const precheck = adapter.precheck(action,resource);
  ensure(precheck.ready,422,'PRECHECK_FAILED','Precheck resource tidak terpenuhi');
  return {resource,create:null,teamId:resource.teamId,environment:resource.environment,precheck,service};
}
export async function snapshotFor(tx: Tx, request: FlowRequest) {
  const resource = request.action!=='CREATE_VM' && request.resourceId ? await tx.resource.findUniqueOrThrow({where:{id:request.resourceId}}) : null;
  const service = await tx.serviceDefinition.findUniqueOrThrow({where:{action:request.action}});
  return json({
    action:request.action,target:resource?{id:resource.id,externalId:resource.externalId,adapterId:resource.adapterId,teamId:resource.teamId,environment:resource.environment,healthRequired:resource.healthRequired,...(request.action==='RESTART_VM'?{guestRebootSupported:resource.guestRebootSupported}:{})}:null,
    ...(request.action==='CREATE_VM'?{create:await createMetadata(tx,request.parameters)}:{}),
    teamId:request.teamId,environment:request.environment,parameters:request.parameters,reason:request.reason,
    scheduledAt:request.scheduledAt?.toISOString()??null,serviceVersion:service.version,verifierContract:service.verifierContract,
  });
}
export async function createDraft(actor: Actor, payload: unknown, key: string, parentRequestId?: string) {
  const input = createRequestSchema.parse(payload);
  ensure(key.length>=8 && key.length<=128,400,'IDEMPOTENCY_REQUIRED','Idempotency-Key wajib 8–128 karakter');
  const idempotencyKey = `${actor.id}:${key}`;
  const payloadHash = hash(input);
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`;
    const existing = await tx.request.findUnique({where:{idempotencyKey}});
    if (existing) {
      authorize(actor,existing,['REQUESTER']);
      ensure(existing.payloadHash===payloadHash,409,'IDEMPOTENCY_CONFLICT','Idempotency-Key digunakan dengan payload berbeda');
      return existing;
    }
    const scheduledAt = input.scheduledAt?new Date(input.scheduledAt):null;
    const target = await validateTarget(tx,actor,input.action,input.resourceId??null,json(input.parameters),scheduledAt);
    const request = await tx.request.create({data:{requesterId:actor.id,teamId:target.teamId,environment:target.environment,action:input.action,resourceId:input.resourceId,reason:input.reason,parameters:json(input.parameters),scheduledAt,idempotencyKey,payloadHash,parentRequestId}});
    await audit(tx,request,'DRAFT_CREATED',actor.id);
    return request;
  });
}
export async function updateDraft(actor: Actor, id: string, payload: unknown) {
  const patch = updateDraftSchema.parse(payload);
  if (!Object.hasOwn(payload as object,'parameters')) delete patch.parameters;
  return db.$transaction(async tx => {
    const request = await lockRequest(tx,id);
    authorize(actor,request,['REQUESTER']);
    ensure(request.requesterId===actor.id,403,'FORBIDDEN','Hanya pemohon dapat mengubah draft');
    ensure(request.status==='DRAFT',409,'IMMUTABLE_SNAPSHOT','Snapshot sudah dibekukan; buat salinan request baru');
    const scheduledAt = patch.scheduledAt===undefined?request.scheduledAt:patch.scheduledAt?new Date(patch.scheduledAt):null;
    const resourceId = patch.resourceId??request.resourceId;
    const parameters = patch.parameters===undefined?request.parameters:json(patch.parameters);
    const target = await validateTarget(tx,actor,request.action,resourceId,parameters,scheduledAt,true,request.id);
    const changed = await tx.request.update({where:{id},data:{reason:patch.reason,resourceId,parameters:json(parameters),scheduledAt,teamId:target.teamId,environment:target.environment,version:{increment:1}}});
    await audit(tx,changed,'DRAFT_UPDATED',actor.id);
    return changed;
  });
}
export async function submitRequest(actor: Actor, id: string) {
  return db.$transaction(async tx => {
    let request = await lockRequest(tx,id);
    authorize(actor,request,['REQUESTER']);
    ensure(request.requesterId===actor.id,403,'FORBIDDEN','Hanya pemohon dapat mengajukan');
    ensure(request.status==='DRAFT',409,'INVALID_TRANSITION','Request bukan draft');
    const target = await validateTarget(tx,actor,request.action,request.resourceId,request.parameters,request.scheduledAt,true,request.id);
    const snapshot = await snapshotFor(tx,request);
    request = await tx.request.update({where:{id},data:{snapshot:json(snapshot),snapshotHash:hash(snapshot),precheck:json(target.precheck)}});
    return transition(tx,request,'AWAITING_APPROVAL',actor.id,{snapshotHash:request.snapshotHash,version:request.version,precheck:target.precheck});
  });
}
export async function decideRequest(actor: Actor, id: string, decision: 'APPROVE'|'REJECT', reason: string) {
  return db.$transaction(async tx => {
    let request = await lockRequest(tx,id);
    authorize(actor,request,['APPROVER']);
    ensure(request.requesterId!==actor.id,403,'SELF_APPROVAL','Tidak dapat menyetujui request sendiri');
    ensure(request.status==='AWAITING_APPROVAL',409,'INVALID_TRANSITION','Keputusan hanya untuk request menunggu approval');
    ensure(request.snapshotHash===hash(await snapshotFor(tx,request)),409,'SNAPSHOT_MISMATCH','Snapshot berubah; buat request baru');
    const expiresAt = new Date(Date.now()+Number(process.env.APPROVAL_TTL_MINUTES??1440)*60_000);
    ensure(decision==='REJECT' || !request.scheduledAt || request.scheduledAt<expiresAt,422,'APPROVAL_EXPIRY','Jadwal melewati masa berlaku approval; buat salinan dengan jadwal baru');
    await tx.approval.create({data:{requestId:id,requestVersion:request.version,snapshotHash:request.snapshotHash!,actorId:actor.id,decision,reason,expiresAt}});
    if (decision==='REJECT') return transition(tx,request,'REJECTED',actor.id,{reason});
    request = await transition(tx,request,'APPROVED',actor.id,{reason,expiresAt});
    request = await transition(tx,request,request.scheduledAt && request.scheduledAt>new Date()?'SCHEDULED':'QUEUED',actor.id);
    await tx.executionRun.create({data:{requestId:id,status:request.status,availableAt:request.scheduledAt??new Date()}});
    return request;
  });
}
export async function cancelRequest(actor: Actor, id: string) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "ExecutionRun" WHERE "requestId"=${id} FOR UPDATE`;
    const request = await lockRequest(tx,id);
    authorize(actor,request,['REQUESTER']);
    ensure(request.requesterId===actor.id,403,'FORBIDDEN','Hanya pemohon dapat membatalkan');
    ensure(['DRAFT','AWAITING_APPROVAL','APPROVED','SCHEDULED','QUEUED'].includes(request.status),409,'CANNOT_CANCEL','Eksekusi sudah dimulai atau request sudah selesai');
    const cancelled = await transition(tx,request,'CANCELLED',actor.id);
    await tx.executionRun.updateMany({where:{requestId:id,dispatchPhase:'NOT_DISPATCHED'},data:{status:'CANCELLED',finishedAt:new Date()}});
    return cancelled;
  });
}
export async function cloneRequest(actor: Actor,id: string,key: string) {
  const request = await db.request.findUnique({where:{id}});
  ensure(request,404,'NOT_FOUND','Request tidak ditemukan');
  authorize(actor,request,['REQUESTER']);
  ensure(request.status!=='REQUIRES_REVIEW',409,'RECONCILIATION_REQUIRED','Rekonsiliasi hasil tidak pasti sebelum membuat permintaan ulang');
  const parameters = request.action==='CREATE_VM' ? {...createVmParameters.parse(request.parameters),name:`${createVmParameters.parse(request.parameters).name.slice(0,26)}-copy-${hash({id,actorId:actor.id,key}).slice(0,8)}`} : request.parameters;
  return createDraft(actor,{action:request.action,resourceId:request.action==='CREATE_VM'?undefined:request.resourceId??undefined,reason:request.reason,parameters,scheduledAt:null},key,id);
}
export async function validateExecution(tx: Tx, request: FlowRequest) {
  if (request.action==='CREATE_VM') await lockCreateTarget(tx,request.parameters);
  const requester = await tx.user.findUnique({where:{id:request.requesterId},include:{assignments:true}});
  const approval = await tx.approval.findUnique({where:{requestId_requestVersion:{requestId:request.id,requestVersion:request.version}},include:{actor:{include:{assignments:true}}}});
  ensure(requester,403,'ACTOR_INVALID','Akun pemohon tidak tersedia');
  ensure(approval && approval.decision==='APPROVE' && approval.actorId!==request.requesterId,403,'APPROVAL_INVALID','Approval tidak sah');
  ensure(approval.expiresAt>new Date(),410,'APPROVAL_EXPIRED','Approval kedaluwarsa');
  authorize(approval.actor,request,['APPROVER']);
  ensure(approval.snapshotHash===request.snapshotHash && request.snapshotHash===hash(await snapshotFor(tx,request)) && hash(request.snapshot)===request.snapshotHash,409,'SNAPSHOT_MISMATCH','Snapshot approval tidak cocok');
  ensure(!request.scheduledAt || request.scheduledAt<=new Date(),409,'NOT_DUE','Jadwal belum tiba');
  return validateTarget(tx,requester,request.action,request.resourceId,request.parameters,request.scheduledAt,false,request.id);
}
export function errorInfo(error: unknown) {
  return error instanceof AppError?{code:error.code,message:error.message}:{code:'EXECUTION_ERROR',message:'Eksekusi gagal; periksa konfigurasi atau observasi target'};
}
export const newOperationId = () => `demo-op-${randomUUID()}`;
