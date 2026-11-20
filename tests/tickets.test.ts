import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { describe,expect,it } from 'vitest';
import { app } from '../apps/api/src/app.js';
import { db } from '../apps/api/src/db.js';
import { signDemoWebhook } from '../apps/api/src/tickets.js';
import { executeRun,processOutbox,tick } from '../apps/worker/src/engine.js';

type Auth={cookie:string;csrf:string};
async function login(name:string):Promise<Auth>{
  const response=await supertest(app).post('/api/auth/login').set('Origin',process.env.APP_ORIGIN!).send({email:`${name}@demo.infraflow.test`,password:process.env.DEMO_PASSWORD}).expect(200);
  return {cookie:(response.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!,csrf:response.body.csrfToken};
}
function api(auth:Auth,method:'get'|'post',path:string,body?:unknown){
  const call=supertest(app)[method](path).set('Cookie',auth.cookie);
  if(method==='post')call.set('Origin',process.env.APP_ORIGIN!).set('X-CSRF-Token',auth.csrf);
  if(body!==undefined)call.send(body as object);return call;
}
const payload=()=>({provider:'DEMO_DESK',eventId:randomUUID(),externalTicketId:`TICKET-${randomUUID()}`,revision:'1',requesterEmail:'requester@demo.infraflow.test',action:'POWER_ON_VM',targetExternalId:'demo-vm-001',reason:'Menyiapkan layanan demo melalui tiket terstruktur',approvalSource:'PORTAL'});
function webhook(body:object,seconds=0,signature?:string){
  const raw=JSON.stringify(body);const stamp=String(Math.floor(Date.now()/1000)+seconds);
  return supertest(app).post('/api/webhooks/demo').set('Content-Type','application/json').set('X-InfraFlow-Timestamp',stamp).set('X-InfraFlow-Signature',signature??signDemoWebhook(Buffer.from(raw),stamp)).send(raw);
}
async function approve(id:string){const auth=await login('approver');await api(auth,'post',`/api/requests/${id}/decision`,{decision:'APPROVE',reason:'Telah meninjau snapshot dan scope tiket demo'}).expect(200);}

describe('service desk simulator durable inbox/outbox',()=>{
  it('authenticates signed ingress, ignores approved claim and requires local independent approval',async()=>{
    const event=payload();const result=await webhook({...event,approved:true}).expect(200);
    const request=await db.request.findUniqueOrThrow({where:{id:result.body.requestId}});
    expect(request).toMatchObject({status:'AWAITING_APPROVAL',source:'DEMO_DESK',sourceRevision:'1',requesterId:'user-requester'});
    expect(await db.approval.count()).toBe(0);expect(await db.executionRun.count()).toBe(0);
    expect(await tick('unapproved-ticket')).toBeNull();
    await approve(request.id);await tick('approved-ticket');
    const completed=await db.request.findUniqueOrThrow({where:{id:request.id},include:{ticket:true,runs:{include:{evidence:true}}}});
    expect(completed.status).toBe('SUCCEEDED');expect(completed.ticket?.syncStatus).toBe('SYNCED');
    expect(completed.runs[0]?.evidence[0]).toMatchObject({verified:true,correlationId:request.correlationId});
    expect(completed.ticket?.result).toMatchObject({status:'SUCCEEDED',verified:true,mode:'DEMO',correlationId:request.correlationId});
  });
  it('deduplicates simultaneous and subsequent webhook replays without new request, run or effect',async()=>{
    const body=payload();const results=await Promise.all(Array.from({length:6},()=>webhook(body)));
    expect(results.map(r=>r.status)).toEqual([200,200,200,200,200,200]);
    expect(results.filter(r=>!r.body.replayed)).toHaveLength(1);
    expect(new Set(results.map(r=>r.body.requestId)).size).toBe(1);
    expect(await db.inboxEvent.count()).toBe(1);expect(await db.request.count()).toBe(1);
    const id=results[0]!.body.requestId;await approve(id);await tick('replay-ticket');
    const replay=await webhook(body).expect(200);expect(replay.body.replayed).toBe(true);
    expect(await tick('replay-no-run')).toBeNull();expect(await db.executionRun.count()).toBe(1);
    expect((await db.resource.findUniqueOrThrow({where:{id:'vm-1'}})).mutationCount).toBe(1);
  });
  it('deduplicates different events for same ticket revision and rejects revision or payload conflicts',async()=>{
    const body=payload();await webhook(body).expect(200);
    expect((await webhook({...body,eventId:randomUUID()}).expect(200)).body.replayed).toBe(true);
    expect(await db.inboxEvent.count()).toBe(2);expect(await db.request.count()).toBe(1);
    expect((await webhook({...body,reason:'Different rationale for the same event'}).expect(409)).body.code).toBe('EVENT_CONFLICT');
    expect((await webhook({...body,eventId:randomUUID(),reason:'Different rationale for the same revision'}).expect(409)).body.code).toBe('TICKET_REVISION_CONFLICT');
    expect((await webhook({...body,eventId:randomUUID(),revision:'2'}).expect(409)).body.code).toBe('REVISION_REVIEW_REQUIRED');
    expect(await db.request.count()).toBe(1);
  });
  it('rejects invalid signature, stale/future replay window and unsigned events before persistence',async()=>{
    const body=payload();await webhook(body,0,'0'.repeat(64)).expect(401);
    await webhook(body,-600).expect(401);await webhook(body,600).expect(401);
    await supertest(app).post('/api/webhooks/demo').send(body).expect(401);
    expect(await db.inboxEvent.count()).toBe(0);expect(await db.request.count()).toBe(0);
  });
  it('rejects remote approval claims, display-name target mapping, production and unscoped requester mapping',async()=>{
    const body=payload();await webhook({...body,approvalSource:'SERVICE_DESK'}).expect(422);
    await webhook({...body,targetExternalId:'platform-worker-01'}).expect(422);
    await webhook({...body,targetExternalId:'demo-vm-009'}).expect(403);
    await webhook({...body,requesterEmail:'requester2@demo.infraflow.test'}).expect(403);
    expect(await db.request.count()).toBe(0);
  });
  it('demo import requires scoped operator/admin and never leaks signing secret',async()=>{
    const body=payload();const requester=await login('requester');const operator=await login('operator');const admin=await login('admin');
    await api(requester,'post','/api/tickets/demo',body).expect(403);
    await api(operator,'post','/api/tickets/demo',{...body,requesterEmail:'requester2@demo.infraflow.test',targetExternalId:'demo-vm-011'}).expect(403);
    const result=await api(admin,'post','/api/tickets/demo',body).expect(200);
    expect(result.body.mode).toBe('DEMO');expect(JSON.stringify(result.body).includes(process.env.WEBHOOK_SECRET!)).toBe(false);
    const outsider=await login('requester2');await api(outsider,'get',`/api/tickets/${result.body.ticketId}`).expect(403);
    expect((await api(outsider,'get','/api/tickets').expect(200)).body.items).toEqual([]);
    await api(requester,'post',`/api/tickets/${result.body.ticketId}/scenario`,{simulateSyncFailure:true}).expect(403);
  });
  it('keeps infrastructure success when ticket sync fails and retries ONLY outbox',async()=>{
    const operator=await login('operator');const result=await api(operator,'post','/api/tickets/demo',payload()).expect(200);
    const {requestId,ticketId}=result.body;
    await api(operator,'post',`/api/tickets/${ticketId}/scenario`,{simulateSyncFailure:true}).expect(200);
    await approve(requestId);await tick('sync-failure-worker');
    for(let i=0;i<2;i++){await db.outboxEvent.updateMany({where:{ticketId},data:{availableAt:new Date(Date.now()-1000)}});await processOutbox();}
    const before=await db.resource.findUniqueOrThrow({where:{id:'vm-1'}});
    expect((await db.request.findUniqueOrThrow({where:{id:requestId}})).status).toBe('SUCCEEDED');
    expect(await db.externalTicket.findUniqueOrThrow({where:{id:ticketId}})).toMatchObject({syncStatus:'FAILED',syncAttempts:3});
    const auditor=await login('auditor');await api(auditor,'post',`/api/tickets/${ticketId}/sync-retry`,{}).expect(403);
    await api(operator,'post',`/api/tickets/${ticketId}/scenario`,{simulateSyncFailure:false}).expect(200);
    await api(operator,'post',`/api/tickets/${ticketId}/sync-retry`,{}).expect(200);
    await processOutbox();expect((await db.externalTicket.findUniqueOrThrow({where:{id:ticketId}})).syncStatus).toBe('SYNCED');
    expect(await db.resource.findUniqueOrThrow({where:{id:'vm-1'}})).toEqual(before);
    expect(await db.executionRun.count()).toBe(1);expect(await db.evidence.count()).toBe(1);
  });
  it('supersedes delayed review outbox after reconciliation without overwriting newer success',async()=>{
    await db.resource.update({where:{id:'vm-1'},data:{scenario:'TIMEOUT_AFTER_DISPATCH'}});
    const result=await webhook(payload()).expect(200);const {requestId,ticketId}=result.body;
    await approve(requestId);const runId=await tick('delayed-review');
    expect((await db.externalTicket.findUniqueOrThrow({where:{id:ticketId}})).result).toMatchObject({status:'REQUIRES_REVIEW'});
    const old=await db.outboxEvent.findFirstOrThrow({where:{ticketId}});
    await db.outboxEvent.update({where:{id:old.id},data:{status:'PENDING',availableAt:new Date(Date.now()+60_000)}});
    const operator=await login('operator');
    await api(operator,'post',`/api/runs/${runId}/reconcile`,{outcome:'CONFIRMED_SUCCEEDED',reason:'Observasi target dan bukti dispatch telah diverifikasi ulang'}).expect(200);
    expect((await db.externalTicket.findUniqueOrThrow({where:{id:ticketId}})).syncStatus).toBe('PENDING');
    await processOutbox();
    expect((await db.externalTicket.findUniqueOrThrow({where:{id:ticketId}})).result).toMatchObject({status:'SUCCEEDED',verified:true});
    await db.outboxEvent.update({where:{id:old.id},data:{availableAt:new Date(Date.now()-1000)}});
    await Promise.all([processOutbox(),processOutbox()]);
    expect(await db.outboxEvent.findUniqueOrThrow({where:{id:old.id}})).toMatchObject({status:'SUPERSEDED',attempts:1});
    expect(await db.externalTicket.findUniqueOrThrow({where:{id:ticketId}})).toMatchObject({syncStatus:'SYNCED',result:{status:'SUCCEEDED',verified:true}});
    expect((await db.resource.findUniqueOrThrow({where:{id:'vm-1'}})).mutationCount).toBe(1);
  });
  it('failed verification is synced as failure and late/duplicate callbacks cannot lower terminal state',async()=>{
    await db.resource.update({where:{id:'vm-1'},data:{scenario:'VERIFY_FAIL'}});
    const result=await webhook(payload()).expect(200);await approve(result.body.requestId);const runId=await tick('failure-ticket');
    const ticket=await db.externalTicket.findUniqueOrThrow({where:{id:result.body.ticketId}});
    expect(ticket.result).toMatchObject({status:'FAILED',verified:false});
    const operator=await login('operator');await api(operator,'post',`/api/runs/${runId}/callback`,{status:'SUCCEEDED'}).expect(404);
    await executeRun(runId!,'failure-ticket');
    expect((await db.request.findUniqueOrThrow({where:{id:result.body.requestId}})).status).toBe('FAILED');
    expect((await db.resource.findUniqueOrThrow({where:{id:'vm-1'}})).mutationCount).toBe(1);
  });
});
