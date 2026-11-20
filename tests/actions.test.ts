import { randomUUID } from 'node:crypto';
import type { Action, Prisma } from '@prisma/client';
import supertest from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { app } from '../apps/api/src/app.js';
import { db } from '../apps/api/src/db.js';
import { hash } from '../apps/api/src/security.js';
import { adapter, snapshotFor } from '../apps/api/src/workflow.js';
import { claimRun, executeRun, tick } from '../apps/worker/src/engine.js';
import { createdExternalId } from '../packages/adapters/src/index.js';
import { seed } from '../prisma/seed.js';

type Auth = { cookie: string; csrf: string };
type Payload = { action: Action; resourceId?: string; reason: string; parameters: Record<string,unknown>; scheduledAt?: string };
const createParameters = (changes: Record<string,unknown> = {}) => ({name:'created-service',templateId:'ubuntu-24',sizeId:'medium',networkId:'net-platform',teamId:'team-platform',owner:'requester@demo.infraflow.test',environment:'DEV',...changes});
const payload = (action: Action = 'CREATE_VM', changes: Partial<Payload> = {}): Payload => ({action,...(action==='CREATE_VM'?{}:{resourceId:'vm-2'}),reason:'Approved nonproduction action integration verification',parameters:action==='CREATE_VM'?createParameters():{},...changes});
async function login(account = 'requester'): Promise<Auth> {
  const response = await supertest(app).post('/api/auth/login').set('Origin',process.env.APP_ORIGIN!).send({email:`${account}@demo.infraflow.test`,password:process.env.DEMO_PASSWORD}).expect(200);
  const cookie = (response.headers['set-cookie'] as unknown as string[]).find(value=>value.startsWith('infraflow_session='));
  expect(Boolean(cookie?.includes('HttpOnly') && cookie.includes('SameSite=Strict'))).toBe(true);
  expect(typeof response.body.csrfToken==='string' && response.body.csrfToken.length>=32).toBe(true);
  return {cookie:cookie!.split(';')[0]!,csrf:response.body.csrfToken as string};
}
function api(auth: Auth, method: 'get'|'post'|'patch', path: string, body?: object) {
  const call = supertest(app)[method](path).set('Cookie',auth.cookie);
  if (method!=='get') call.set('Origin',process.env.APP_ORIGIN!).set('X-CSRF-Token',auth.csrf);
  if (body) call.send(body);
  return call;
}
function create(auth: Auth, body: Payload, key = randomUUID()) {
  return api(auth,'post','/api/requests',body).set('Idempotency-Key',key);
}
async function queued(body = payload()) {
  const requester = await login();
  const approver = await login('approver');
  const draft = await create(requester,body).expect(201);
  const submitted = await api(requester,'post',`/api/requests/${draft.body.id}/submit`).expect(200);
  await api(approver,'post',`/api/requests/${draft.body.id}/decision`,{decision:'APPROVE',reason:'Reviewed the exact frozen action and configuration'}).expect(200);
  const flow = await db.request.findUniqueOrThrow({where:{id:draft.body.id as string}});
  const run = await db.executionRun.findUniqueOrThrow({where:{requestId:flow.id}});
  expect(submitted.body.snapshotHash).toBe(hash(flow.snapshot));
  return {flow,run,requester,approver};
}
const resource = (id = 'vm-2') => db.resource.findUniqueOrThrow({where:{id}});
const execution = (id: string) => db.executionRun.findUniqueOrThrow({where:{id},include:{events:true,evidence:true}});
const reconcile = (auth: Auth, id: string, outcome = 'CONFIRMED_SUCCEEDED') => api(auth,'post',`/api/runs/${id}/reconcile`,{outcome,reason:'Operator independently reviewed the action-specific dispatch and observation proof'});
async function notDispatched(id: string, code?: string) {
  const run = await execution(id);
  expect(run).toMatchObject({status:'FAILED',dispatchPhase:'NOT_DISPATCHED',externalOperationId:null});
  expect(run.events.some(event=>['DISPATCHING','DISPATCHED'].includes(event.kind))).toBe(false);
  expect(run.evidence).toHaveLength(1);
  expect(run.evidence[0]).toMatchObject({verified:false,outcome:'FAILED',...(code?{postcheck:{code}}:{})});
  expect(await db.resourceLock.count({where:{runId:id}})).toBe(0);
}

describe('RESTART_VM and CREATE_VM integration',()=>{
  it('gracefully reboots exactly once and exports boot-marker and dispatch proof',async()=>{
    const before = await resource();
    const {flow,run,requester} = await queued(payload('RESTART_VM'));
    expect(flow.snapshot).toMatchObject({action:'RESTART_VM',target:{id:before.id,healthRequired:true,guestRebootSupported:true}});
    expect(await tick('reboot-worker')).toBe(run.id);
    const after = await resource();
    expect(after).toMatchObject({powerState:'poweredOn',guestState:'ready',serviceHealthy:true,mutationCount:1});
    expect(after.bootMarker).not.toBe(before.bootMarker);
    const result = await execution(run.id);
    expect(result).toMatchObject({status:'SUCCEEDED',dispatchPhase:'DISPATCHED'});
    expect(result.events.filter(event=>event.kind==='DISPATCHING')).toHaveLength(1);
    expect(result.events.find(event=>event.kind==='DISPATCHING')?.payload).toMatchObject({operationId:result.externalOperationId,before:{id:before.id,bootMarker:before.bootMarker}});
    expect(result.evidence[0]).toMatchObject({verified:true,postcheck:{checks:{dispatchProof:true,sameTarget:true,bootMarkerChanged:true,guestReady:true,serviceHealthy:true},proof:{operationId:result.externalOperationId,before:{bootMarker:before.bootMarker}}}});
    const exported = await api(requester,'get',`/api/requests/${flow.id}/evidence`).expect(200);
    expect(exported.headers['content-disposition']).toContain('attachment;');
    expect(exported.body.runs[0].evidence[0].postcheck.observation.bootMarker).toBe(after.bootMarker);
    expect(await tick('repeat-reboot')).toBeNull();
    await executeRun(run.id,'reboot-worker');
    expect(await resource()).toEqual(after);
    expect(await db.resourceLock.count()).toBe(0);
  });

  it.each([
    ['unsupported guest',{guestRebootSupported:false}],['powered off',{powerState:'poweredOff'}],
    ['guest not ready',{guestState:'stopped'}],['unconfigured health',{healthRequired:false}],
    ['unhealthy service',{serviceHealthy:false}],['unknown boot marker',{bootMarker:null}],
  ] satisfies [string,Prisma.ResourceUncheckedUpdateInput][])('rejects restart precheck for %s without any hard reset',async(_name,change)=>{
    await db.resource.update({where:{id:'vm-2'},data:change});
    const before = await resource();
    const response = await create(await login(),payload('RESTART_VM')).expect(422);
    expect(response.body.code).toBe('PRECHECK_FAILED');
    expect(await resource()).toEqual(before);
    expect(await db.request.count()).toBe(0);
    expect(await tick('unsupported-reboot')).toBeNull();
  });

  it.each(['POWER_ON_VM','RESTART_VM'] as const)('rejects forged %s parameters rather than allowing a reset or bypass',async action=>{
    const auth = await login();
    for (const parameters of [{guestRebootSupported:true},{force:true},{hardReset:true},{script:'reboot now'},{serviceHealthy:true}]) {
      expect((await create(auth,payload(action,{resourceId:'vm-3',parameters})).expect(422)).body.code).toBe('VALIDATION_ERROR');
    }
    expect((await create(auth,payload('RESTART_VM',{resourceId:'vm-3'})).expect(422)).body.code).toBe('PRECHECK_FAILED');
    expect((await resource('vm-3')).mutationCount).toBe(0);
    expect(await db.request.count()).toBe(0);
  });

  it('rechecks guest support against the approved snapshot before dispatch',async()=>{
    const {run} = await queued(payload('RESTART_VM'));
    await db.resource.update({where:{id:'vm-2'},data:{guestRebootSupported:false}});
    const before = await resource();
    await tick('revoked-guest-support');
    await notDispatched(run.id,'SNAPSHOT_MISMATCH');
    expect(await resource()).toEqual(before);
  });

  it('fails verification when an otherwise healthy reboot leaves its boot marker unchanged',async()=>{
    const before = await resource();
    const {run} = await queued(payload('RESTART_VM'));
    const dispatch = adapter.dispatch.bind(adapter);
    vi.spyOn(adapter,'dispatch').mockImplementationOnce(async(tx,request,target,operationId,context)=>{
      const result = await dispatch(tx,request,target,operationId,context);
      await tx.resource.update({where:{id:target!.id},data:{bootMarker:before.bootMarker}});
      return result;
    });
    await tick('unchanged-boot-marker');
    const result = await execution(run.id);
    expect(result).toMatchObject({status:'FAILED',dispatchPhase:'DISPATCHED'});
    expect(result.evidence[0]).toMatchObject({verified:false,postcheck:{checks:{poweredOn:true,serviceHealthy:true,bootMarkerChanged:false}}});
    expect((await resource()).mutationCount).toBe(1);
    expect(result.events.some(event=>['SUCCEEDED','COMPLETED_NOOP'].includes(event.kind))).toBe(false);
  });

  it('fails restart verification on the existing service failure fixture',async()=>{
    await db.resource.update({where:{id:'vm-2'},data:{scenario:'VERIFY_FAIL'}});
    const {run} = await queued(payload('RESTART_VM'));
    await tick('reboot-health-failure');
    expect((await execution(run.id)).evidence[0]).toMatchObject({outcome:'FAILED',verified:false,postcheck:{checks:{bootMarkerChanged:true,serviceHealthy:false}}});
    expect((await resource()).mutationCount).toBe(1);
  });

  it('creates only after independent approval with exact catalog specs, immutable snapshot and linked identity evidence',async()=>{
    const requester = await login();
    const draft = await create(requester,payload()).expect(201);
    expect(draft.body).toMatchObject({resourceId:null,status:'DRAFT'});
    expect(await tick('create-before-submit')).toBeNull();
    const submitted = await api(requester,'post',`/api/requests/${draft.body.id}/submit`).expect(200);
    expect(submitted.body.snapshot).toMatchObject({target:null,parameters:createParameters(),create:{parameters:createParameters(),template:{id:'ubuntu-24',enabled:true,os:'Ubuntu 24.04'},size:{id:'medium',cpu:4,ramGb:8,diskGb:80},network:{id:'net-platform',cidr:'192.0.2.0/24',teamId:'team-platform'}}});
    expect(await tick('create-before-approval')).toBeNull();
    expect(await db.resource.count()).toBe(12);
    await db.roleAssignment.create({data:{userId:'user-requester',teamId:'team-platform',role:'APPROVER',environments:['DEV']}});
    expect((await api(requester,'post',`/api/requests/${draft.body.id}/decision`,{decision:'APPROVE',reason:'Cannot self approve this VM'}).expect(403)).body.code).toBe('SELF_APPROVAL');
    await api(await login('approver'),'post',`/api/requests/${draft.body.id}/decision`,{decision:'APPROVE',reason:'Reviewed exact provisioning specifications'}).expect(200);
    const runId = await tick('create-approved');
    const run = await execution(runId!);
    const flow = await db.request.findUniqueOrThrow({where:{id:draft.body.id as string}});
    expect(flow).toMatchObject({status:'SUCCEEDED',snapshotHash:submitted.body.snapshotHash,snapshot:submitted.body.snapshot});
    expect(flow.resourceId).not.toBeNull();
    const vm = await resource(flow.resourceId!);
    expect(vm).toMatchObject({externalId:createdExternalId(run.externalOperationId!),name:'created-service',adapterId:'demo',teamId:'team-platform',owner:'requester@demo.infraflow.test',environment:'DEV',templateId:'ubuntu-24',networkId:'net-platform',cpu:4,ramGb:8,diskGb:80,powerState:'poweredOn',guestState:'ready',serviceHealthy:true,bootMarker:`${run.externalOperationId}:boot`,mutationCount:1,scenario:'NORMAL'});
    expect(vm.externalId).toMatch(/^demo-created-[0-9a-f-]{36}$/);
    expect(await db.resource.count()).toBe(13);
    expect(hash(await db.$transaction(tx=>snapshotFor(tx,flow)))).toBe(flow.snapshotHash);
    expect(run.events.find(event=>event.kind==='DISPATCHING')?.payload).toMatchObject({before:null,operationId:run.externalOperationId});
    expect(run.events.find(event=>event.kind==='DISPATCHED')?.payload).toMatchObject({resourceId:vm.id,operationId:run.externalOperationId});
    expect(run.evidence[0]).toMatchObject({outcome:'SUCCEEDED',verified:true,correlationId:flow.correlationId,postcheck:{checks:{dispatchProof:true,externalId:true,specificationMatch:true,bootstrapReady:true},observation:{id:vm.id,externalId:vm.externalId,cpu:4,ramGb:8,diskGb:80}}});
    const exported = await api(requester,'get',`/api/requests/${flow.id}/evidence`).expect(200);
    expect(exported.body.snapshot.target).toBeNull();
    expect(exported.body.resource.id).toBe(vm.id);
    expect(exported.body.runs[0].evidence[0].verified).toBe(true);
    expect(await tick('create-again')).toBeNull();
    await executeRun(run.id,'create-approved');
    expect(await db.resource.count()).toBe(13);
    expect(await resource(vm.id)).toEqual(vm);
  });

  it.each([
    ['missing template',{templateId:'missing'},'INVALID_TEMPLATE'],['missing size',{sizeId:'missing'},'INVALID_SIZE'],
    ['missing network',{networkId:'missing'},'INVALID_NETWORK'],['cross-team network',{networkId:'net-data'},'INVALID_NETWORK'],
    ['missing owner',{owner:'missing@demo.infraflow.test'},'INVALID_OWNER'],['approver owner',{owner:'approver@demo.infraflow.test'},'INVALID_OWNER'],
    ['cross-team owner',{owner:'requester2@demo.infraflow.test'},'INVALID_OWNER'],['production',{environment:'PRODUCTION'},'VALIDATION_ERROR'],
    ['arbitrary sizing',{cpu:64},'VALIDATION_ERROR'],['arbitrary script',{bootstrapScript:'unsafe'},'VALIDATION_ERROR'],
  ])('rejects create with %s',async(_name,changes,code)=>{
    const response = await create(await login(),payload('CREATE_VM',{parameters:createParameters(changes as Record<string,unknown>)})).expect(422);
    expect(response.body.code).toBe(code);
    expect(await db.request.count()).toBe(0);
    expect(await db.resource.count()).toBe(12);
  });

  it.each(['disabled-template','inactive-owner','owner-environment','requester-scope','existing-resource'] as const)('enforces create %s constraints',async variant=>{
    const requester = await login();
    let parameters = createParameters();
    if (variant==='disabled-template') await db.template.update({where:{id:'ubuntu-24'},data:{enabled:false}});
    if (variant==='inactive-owner' || variant==='owner-environment') {
      await db.user.create({data:{id:'scoped-owner',email:'scoped@demo.infraflow.test',name:'Scoped Owner',passwordHash:'unused',active:variant!=='inactive-owner',assignments:{create:{teamId:'team-platform',role:'REQUESTER',environments:variant==='owner-environment'?['TEST']:['DEV']}}}});
      parameters = createParameters({owner:'scoped@demo.infraflow.test'});
    }
    if (variant==='requester-scope') parameters = createParameters({teamId:'team-data',networkId:'net-data',owner:'requester2@demo.infraflow.test'});
    const response = await create(requester,payload('CREATE_VM',{parameters,...(variant==='existing-resource'?{resourceId:'vm-1'}:{})})).expect(variant==='requester-scope'?403:422);
    expect(response.body.code).toBe(variant==='disabled-template'?'INVALID_TEMPLATE':variant==='requester-scope'?'FORBIDDEN':variant==='existing-resource'?'INVALID_TARGET':'INVALID_OWNER');
    expect(await db.request.count()).toBe(0);
    expect(await db.resource.count()).toBe(12);
  });

  it('reserves names adapter-wide across teams, serializes racing drafts, and releases cancelled reservations',async()=>{
    const requester = await login();
    const dataVm = await resource('vm-10');
    expect((await create(requester,payload('CREATE_VM',{parameters:createParameters({name:dataVm.name})})).expect(409)).body.code).toBe('NAME_CONFLICT');
    const calls = await Promise.all(Array.from({length:5},()=>create(requester,payload())));
    expect(calls.map(response=>response.status).sort()).toEqual([201,409,409,409,409]);
    expect(await db.request.count()).toBe(1);
    const flow = await db.request.findFirstOrThrow();
    await api(requester,'patch',`/api/requests/${flow.id}`,{reason:'Updated rationale retaining my own reserved name'}).expect(200);
    await api(requester,'post',`/api/requests/${flow.id}/submit`).expect(200);
    expect((await create(requester,payload()).expect(409)).body.code).toBe('NAME_CONFLICT');
    await api(requester,'post',`/api/requests/${flow.id}/cancel`).expect(200);
    await create(requester,payload()).expect(201);
    expect(await db.resource.count()).toBe(12);
  });

  it('deduplicates identical concurrent create drafts by idempotency key',async()=>{
    const requester = await login();
    const key = randomUUID();
    const responses = await Promise.all(Array.from({length:4},()=>create(requester,payload(),key)));
    expect(responses.map(response=>response.status)).toEqual([201,201,201,201]);
    expect(new Set(responses.map(response=>response.body.id)).size).toBe(1);
    expect(await db.request.count()).toBe(1);
  });

  it('uses separate create identity locks and skips a locked same-name job rather than resource:null',async()=>{
    const first = await queued();
    const second = await queued(payload('CREATE_VM',{parameters:createParameters({name:'second-service'})}));
    const [a,b] = await Promise.all([claimRun('create-a'),claimRun('create-b')]);
    expect(new Set([a,b])).toEqual(new Set([first.run.id,second.run.id]));
    const locks = await db.resourceLock.findMany();
    expect(locks.map(lock=>lock.key).sort()).toEqual(['create:demo:created-service','create:demo:second-service']);
    const duplicate = await db.request.create({data:{requesterId:first.flow.requesterId,teamId:first.flow.teamId,environment:first.flow.environment,action:'CREATE_VM',reason:'Simulated legacy queued request with the same reserved name',parameters:first.flow.parameters!,status:'QUEUED',idempotencyKey:randomUUID(),payloadHash:'fixture'}});
    await db.executionRun.create({data:{requestId:duplicate.id,status:'QUEUED'}});
    expect(await claimRun('skip-same-name')).toBeNull();
    expect(await db.resourceLock.findUnique({where:{key:'resource:null'}})).toBeNull();
    await db.request.update({where:{id:duplicate.id},data:{status:'CANCELLED'}});
    await db.executionRun.updateMany({where:{requestId:duplicate.id},data:{status:'CANCELLED'}});
    await Promise.all([executeRun(a!,'create-a'),executeRun(b!,'create-b')]);
    expect((await execution(first.run.id)).status).toBe('SUCCEEDED');
    expect((await execution(second.run.id)).status).toBe('SUCCEEDED');
    expect(await db.resource.count()).toBe(14);
    const created = await db.resource.findMany({where:{externalId:{startsWith:'demo-created-'}}});
    expect(new Set(created.map(vm=>vm.externalId)).size).toBe(2);
    expect(created.every(vm=>vm.mutationCount===1)).toBe(true);
  });

  it.each(['template','size','network'] as const)('blocks %s catalog drift after approval without dispatch',async variant=>{
    const {run} = await queued();
    if (variant==='template') await db.template.update({where:{id:'ubuntu-24'},data:{os:'Unapproved replacement image'}});
    if (variant==='size') await db.sizeProfile.update({where:{id:'medium'},data:{cpu:8,ramGb:16,diskGb:160}});
    if (variant==='network') await db.networkProfile.update({where:{id:'net-platform'},data:{cidr:'10.99.0.0/24'}});
    await tick('catalog-drift');
    await notDispatched(run.id,'SNAPSHOT_MISMATCH');
    expect(await db.resource.count()).toBe(12);
  });

  it('rejects approval itself when template configuration changed since submission',async()=>{
    const requester = await login();
    const response = await create(requester,payload()).expect(201);
    await api(requester,'post',`/api/requests/${response.body.id}/submit`).expect(200);
    await db.template.update({where:{id:'ubuntu-24'},data:{os:'Changed after submission'}});
    const approval = await api(await login('approver'),'post',`/api/requests/${response.body.id}/decision`,{decision:'APPROVE',reason:'Cannot approve changed catalog configuration'}).expect(409);
    expect(approval.body.code).toBe('SNAPSHOT_MISMATCH');
    expect(await db.executionRun.count()).toBe(0);
  });

  it('rechecks owner scope at execution',async()=>{
    await db.user.create({data:{id:'new-owner',email:'owner@demo.infraflow.test',name:'VM Owner',passwordHash:'unused',assignments:{create:{teamId:'team-platform',role:'REQUESTER',environments:['DEV']}}}});
    const {run} = await queued(payload('CREATE_VM',{parameters:createParameters({owner:'owner@demo.infraflow.test'})}));
    await db.user.update({where:{id:'new-owner'},data:{active:false}});
    await tick('owner-disabled');
    await notDispatched(run.id,'INVALID_OWNER');
    expect(await db.resource.count()).toBe(12);
  });

  it.each(['count','cpu'] as const)('enforces demo team %s quota at draft validation',async variant=>{
    if (variant==='count') await db.resource.createMany({data:Array.from({length:41},(_,i)=>({externalId:`quota-vm-${i}`,name:`quota-vm-${i}`,teamId:'team-platform',owner:'requester@demo.infraflow.test',environment:'DEV' as const,cpu:1,ramGb:1,diskGb:1,networkId:'net-platform'}))});
    else await db.resource.update({where:{id:'vm-1'},data:{cpu:182}});
    expect((await create(await login(),payload()).expect(422)).body.code).toBe('QUOTA_EXCEEDED');
    expect(await db.request.count()).toBe(0);
    expect(await db.resource.count({where:{externalId:{startsWith:'demo-created-'}}})).toBe(0);
  });

  it('serializes final quota validation and mutation across competing names',async()=>{
    const first = await queued(payload('CREATE_VM',{parameters:createParameters({sizeId:'small'})}));
    const second = await queued(payload('CREATE_VM',{parameters:createParameters({name:'second-service',sizeId:'small'})}));
    await db.resource.update({where:{id:'vm-1'},data:{cpu:182}});
    const [a,b] = await Promise.all([claimRun('quota-a'),claimRun('quota-b')]);
    expect(new Set([a,b])).toEqual(new Set([first.run.id,second.run.id]));
    await Promise.all([executeRun(a!,'quota-a'),executeRun(b!,'quota-b')]);
    const runs = await db.executionRun.findMany();
    expect(runs.filter(run=>run.status==='SUCCEEDED')).toHaveLength(1);
    const denied = runs.find(run=>run.status!=='SUCCEEDED')!;
    expect(['FAILED','REQUIRES_REVIEW']).toContain(denied.status);
    expect((await execution(denied.id)).evidence[0]).toMatchObject({verified:false,postcheck:{code:'QUOTA_EXCEEDED'}});
    expect((await db.resource.aggregate({where:{teamId:'team-platform'},_sum:{cpu:true}}))._sum.cpu).toBe(200);
    expect(await db.resource.count({where:{externalId:{startsWith:'demo-created-'}}})).toBe(1);
    expect(await db.runEvent.count({where:{kind:'DISPATCHED'}})).toBe(1);
  });

  it.each([
    ['external identity',{externalId:'demo-created-wrong-operation'}],['CPU specification',{cpu:99}],
    ['owner identity',{owner:'approver@demo.infraflow.test'}],['template',{templateId:'debian-12'}],
    ['network',{networkId:'net-test'}],['bootstrap marker',{bootMarker:'unrelated-boot'}],
  ] satisfies [string,Prisma.ResourceUncheckedUpdateInput][])('fails create verification for mismatched %s even if powered on',async(_name,change)=>{
    const {run} = await queued();
    const dispatch = adapter.dispatch.bind(adapter);
    vi.spyOn(adapter,'dispatch').mockImplementationOnce(async(tx,request,target,operationId,context)=>{
      const result = await dispatch(tx,request,target,operationId,context);
      await tx.resource.update({where:{id:result.resourceId},data:change});
      return result;
    });
    await tick('create-verifier-mismatch');
    const result = await execution(run.id);
    expect(result).toMatchObject({status:'FAILED',dispatchPhase:'DISPATCHED'});
    expect(result.evidence[0]).toMatchObject({verified:false,postcheck:{verified:false,checks:{poweredOn:true}}});
    expect(result.events.some(event=>event.kind==='SUCCEEDED')).toBe(false);
    expect(await db.resource.count()).toBe(13);
    expect(await db.resourceLock.count()).toBe(0);
  });

  it.each(['RESTART_VM','CREATE_VM'] as const)('retains %s timeout locks and reconciles dispatch proof without repeating mutation',async action=>{
    if (action==='RESTART_VM') await db.resource.update({where:{id:'vm-2'},data:{scenario:'TIMEOUT_AFTER_DISPATCH'}});
    const {flow,run} = await queued(payload(action));
    if (action==='CREATE_VM') {
      const dispatch = adapter.dispatch.bind(adapter);
      vi.spyOn(adapter,'dispatch').mockImplementationOnce(async(...args)=>({...await dispatch(...args),uncertain:true}));
    }
    await tick('uncertain-action');
    expect(await execution(run.id)).toMatchObject({status:'REQUIRES_REVIEW',dispatchPhase:'DISPATCHED'});
    const linked = await db.request.findUniqueOrThrow({where:{id:flow.id}});
    const before = await resource(linked.resourceId!);
    expect(before.mutationCount).toBe(1);
    expect(await db.resourceLock.count({where:{runId:run.id}})).toBe(1);
    if (action==='CREATE_VM') {
      expect((await db.resourceLock.findUniqueOrThrow({where:{runId:run.id}})).key).toBe(`resource:${before.id}`);
      await api(await login('operator'),'post',`/api/resources/${before.id}/scenario`,{scenario:'VERIFY_FAIL'}).expect(409);
      expect((await create(await login(),payload()).expect(409)).body.code).toBe('NAME_CONFLICT');
      const power = await queued(payload('POWER_ON_VM',{resourceId:before.id}));
      expect(await claimRun('create-target-still-locked')).toBeNull();
      expect((await execution(power.run.id)).status).toBe('QUEUED');
    }
    for (const worker of ['uncertain-action','retry-action']) {
      expect(await tick(worker)).toBeNull();
      await executeRun(run.id,worker);
    }
    const operator = await login('operator');
    expect((await reconcile(operator,run.id,'CONFIRMED_FAILED').expect(422)).body.code).toBe('OBSERVATION_CONFLICT');
    expect((await reconcile(operator,run.id).expect(200)).body.status).toBe('SUCCEEDED');
    expect(await resource(before.id)).toEqual(before);
    expect(await db.resource.count()).toBe(action==='CREATE_VM'?13:12);
    expect(await db.runEvent.count({where:{runId:run.id,kind:'DISPATCHED'}})).toBe(1);
    const result = await execution(run.id);
    expect(result.evidence.map(e=>e.outcome).sort()).toEqual(['REQUIRES_REVIEW','SUCCEEDED']);
    expect(result.evidence.find(e=>e.verified)?.postcheck).toMatchObject({verification:{checks:{dispatchProof:true,...(action==='CREATE_VM'?{externalId:true,specificationMatch:true,bootstrapReady:true}:{bootMarkerChanged:true})}}});
    expect(await db.resourceLock.count({where:{runId:run.id}})).toBe(0);
  });

  it.each(['RESTART_VM','CREATE_VM'] as const)('recovers expired %s intent without dispatch and refuses success without proof',async action=>{
    const {run} = await queued(payload(action));
    const before = await resource();
    expect(await claimRun('crashed-action')).toBe(run.id);
    await db.executionRun.update({where:{id:run.id},data:{dispatchPhase:'DISPATCHING',externalOperationId:`demo-op-${randomUUID()}`,leaseExpiresAt:new Date(Date.now()-1000)}});
    expect(await tick('recover-action')).toBeNull();
    expect(await execution(run.id)).toMatchObject({status:'REQUIRES_REVIEW',dispatchPhase:'DISPATCHING'});
    expect(await db.resourceLock.count({where:{runId:run.id}})).toBe(1);
    const operator = await login('operator');
    expect((await reconcile(operator,run.id).expect(422)).body.code).toBe('VERIFICATION_FAILED');
    expect(await db.resourceLock.count({where:{runId:run.id}})).toBe(1);
    await executeRun(run.id,'crashed-action');
    expect(await tick('retry-recovered-action')).toBeNull();
    expect(await resource()).toEqual(before);
    expect(await db.resource.count()).toBe(12);
    expect((await reconcile(operator,run.id,'CONFIRMED_FAILED').expect(200)).body.status).toBe('FAILED');
    expect(await db.resourceLock.count()).toBe(0);
    expect(await db.runEvent.count({where:{kind:'DISPATCHED'}})).toBe(0);
  });

  it.each(['RESTART_VM','CREATE_VM'] as const)('rejects reconciled %s success if committed dispatch evidence is absent',async action=>{
    const {run} = await queued(payload(action));
    const dispatch = adapter.dispatch.bind(adapter);
    vi.spyOn(adapter,'dispatch').mockImplementationOnce(async(...args)=>({...await dispatch(...args),uncertain:true}));
    await tick('dispatch-with-lost-proof');
    const linked = await db.request.findUniqueOrThrow({where:{id:run.requestId}});
    const before = await resource(linked.resourceId!);
    await db.runEvent.deleteMany({where:{runId:run.id,kind:'DISPATCHED'}});
    expect((await reconcile(await login('operator'),run.id).expect(422)).body.code).toBe('VERIFICATION_FAILED');
    expect((await execution(run.id)).status).toBe('REQUIRES_REVIEW');
    expect(await db.resourceLock.count()).toBe(1);
    expect(await resource(before.id)).toEqual(before);
  });

  it('clones create into an editable unique-name draft with stable idempotency and no inherited approval',async()=>{
    const {flow,requester}=await queued();await tick('clone-source');const key=randomUUID();
    const first=await api(requester,'post',`/api/requests/${flow.id}/clone`,{}).set('Idempotency-Key',key).expect(201);
    const replay=await api(requester,'post',`/api/requests/${flow.id}/clone`,{}).set('Idempotency-Key',key).expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(first.body).toMatchObject({status:'DRAFT',resourceId:null,parentRequestId:flow.id,snapshotHash:null});
    expect(first.body.parameters.name).toMatch(/^created-service-copy-[a-f0-9]{8}$/);
    await api(requester,'patch',`/api/requests/${first.body.id}`,{parameters:createParameters({name:'renamed-clone'})}).expect(200);
    expect(await db.approval.count({where:{requestId:first.body.id as string}})).toBe(0);
    expect(await db.executionRun.count({where:{requestId:first.body.id as string}})).toBe(0);
  });
  it('keeps seeds repeatable without resetting passwords, VM mutations, catalog edits, or power snapshot version',async()=>{
    const before = await db.user.findMany({orderBy:{id:'asc'}});
    await db.resource.update({where:{id:'vm-2'},data:{bootMarker:'retained-boot',mutationCount:7}});
    await db.template.update({where:{id:'ubuntu-24'},data:{os:'Retained catalog customization'}});
    await db.serviceDefinition.updateMany({data:{enabled:false}});
    const vm = await resource();
    await seed();
    expect(await db.user.findMany({orderBy:{id:'asc'}})).toEqual(before);
    expect(await resource()).toEqual(vm);
    expect(await db.resource.count()).toBe(12);
    expect(await db.template.count()).toBe(3);
    expect(await db.sizeProfile.count()).toBe(3);
    expect(await db.networkProfile.count()).toBe(3);
    expect((await db.template.findUniqueOrThrow({where:{id:'ubuntu-24'}})).os).toBe('Retained catalog customization');
    const services = await db.serviceDefinition.findMany();
    expect(services.every(service=>service.enabled && service.version===1)).toBe(true);
    expect(await login()).toBeDefined();
  });
});
