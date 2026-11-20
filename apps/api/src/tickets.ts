import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request as HttpRequest, Response } from 'express';
import { z } from 'zod';
import { db } from './db.js';
import { authorize, ensure, hash, json, type Actor } from './security.js';
import { audit, snapshotFor, transition, validateTarget } from './workflow.js';
import { demoTicketSchema } from '../../../packages/contracts/src/index.js';

const windowSeconds = 300;
const attempts = new Map<string,{count:number;until:number}>();
function requireDemo() { ensure(process.env.APP_MODE==='DEMO',503,'NOT_CONFIGURED','Provider simulator hanya tersedia di mode DEMO'); }
function webhookSecret() {
  const value=process.env.WEBHOOK_SECRET;
  ensure(value && value.length>=32 && !value.startsWith('replace-'),503,'NOT_CONFIGURED','Secret webhook simulator belum dikonfigurasi');
  return value;
}
export function signDemoWebhook(body: Buffer,timestamp: string) {
  return createHmac('sha256',webhookSecret()).update(`${timestamp}.`).update(body).digest('hex');
}
function verifySignature(body: Buffer,timestamp: string,signature: string) {
  ensure(/^\d{10}$/.test(timestamp) && Math.abs(Date.now()/1000-Number(timestamp))<=windowSeconds,401,'WEBHOOK_EXPIRED','Timestamp webhook tidak valid atau kedaluwarsa');
  ensure(/^[a-f0-9]{64}$/.test(signature),401,'WEBHOOK_SIGNATURE','Signature webhook tidak valid');
  ensure(timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(signDemoWebhook(body,timestamp),'hex')),401,'WEBHOOK_SIGNATURE','Signature webhook tidak cocok');
}
export async function ingestDemoTicket(payload: unknown,caller?: Actor) {
  requireDemo();
  const input=demoTicketSchema.parse(payload);
  const payloadHash=hash(input);
  return db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`inbox:${input.provider}:${input.eventId}`},0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ticket:${input.provider}:${input.externalTicketId}`},0))`;
    const requester=await tx.user.findUnique({where:{email:input.requesterEmail.toLowerCase()},include:{assignments:true}});
    ensure(requester?.active,422,'REQUESTER_MAPPING','Mapping requester tidak ditemukan atau tidak aktif');
    const resource=await tx.resource.findUnique({where:{adapterId_externalId:{adapterId:'demo',externalId:input.targetExternalId}}});
    ensure(resource,422,'TARGET_MAPPING','External resource ID tidak ditemukan pada adapter demo');
    authorize(requester,resource,['REQUESTER']);
    if(caller) authorize(caller,resource,['OPERATOR','PLATFORM_ADMIN']);
    const seen=await tx.inboxEvent.findUnique({where:{provider_eventId:{provider:input.provider,eventId:input.eventId}},include:{ticket:{include:{request:true}}}});
    if(seen) {
      authorize(requester,seen.ticket,['REQUESTER']);
      if(caller) authorize(caller,seen.ticket,['OPERATOR','PLATFORM_ADMIN']);
      ensure(seen.payloadHash===payloadHash,409,'EVENT_CONFLICT','Event ID pernah dipakai dengan payload berbeda');
      ensure(seen.ticket.request,409,'INCOMPLETE_IMPORT','Mapping request belum tersedia');
      return {requestId:seen.ticket.request.id,ticketId:seen.ticketId,replayed:true,mode:'DEMO'};
    }
    const existing=await tx.externalTicket.findUnique({where:{provider_externalId:{provider:input.provider,externalId:input.externalTicketId}},include:{request:true,events:{take:1,orderBy:{createdAt:'asc'}}}});
    if(existing) {
      authorize(requester,existing,['REQUESTER']);
      if(caller) authorize(caller,existing,['OPERATOR','PLATFORM_ADMIN']);
      ensure(existing.revision===input.revision,409,'REVISION_REVIEW_REQUIRED','Revisi tiket berbeda memerlukan rekonsiliasi; tidak membuat eksekusi baru');
      ensure(existing.request?.resourceId===resource.id && existing.request.requesterId===requester.id && existing.request.action===input.action && existing.request.reason===input.reason,409,'TICKET_REVISION_CONFLICT','Isi tiket berubah tanpa revisi yang direkonsiliasi');
      await tx.inboxEvent.create({data:{provider:input.provider,eventId:input.eventId,revision:input.revision,payloadHash,ticketId:existing.id}});
      return {requestId:existing.request.id,ticketId:existing.id,replayed:true,mode:'DEMO'};
    }
    const target=await validateTarget(tx,requester,input.action,resource.id,{},null);
    const ticket=await tx.externalTicket.create({data:{provider:input.provider,externalId:input.externalTicketId,revision:input.revision,teamId:resource.teamId,environment:resource.environment,approvalSource:'PORTAL'}});
    let request=await tx.request.create({data:{requesterId:requester.id,teamId:resource.teamId,environment:resource.environment,action:input.action,resourceId:resource.id,reason:input.reason,parameters:{},source:'DEMO_DESK',sourceRevision:input.revision,ticketId:ticket.id,idempotencyKey:`ticket:${ticket.id}`,payloadHash}});
    await audit(tx,request,'TICKET_IMPORTED',caller?.id??requester.id,{provider:input.provider,ticketId:ticket.id,eventId:input.eventId,approvalSource:'PORTAL'});
    const snapshot=await snapshotFor(tx,request);
    request=await tx.request.update({where:{id:request.id},data:{snapshot:json(snapshot),snapshotHash:hash(snapshot),precheck:json(target.precheck)}});
    await transition(tx,request,'AWAITING_APPROVAL',requester.id,{approvalSource:'PORTAL',externalApprovalClaimIgnored:input.approved??false});
    await tx.inboxEvent.create({data:{provider:input.provider,eventId:input.eventId,revision:input.revision,payloadHash,ticketId:ticket.id}});
    return {requestId:request.id,ticketId:ticket.id,replayed:false,mode:'DEMO'};
  });
}
export async function demoWebhook(req:HttpRequest,res:Response) {
  requireDemo();
  const now=Date.now();
  for(const [key,entry] of attempts) if(entry.until<now) attempts.delete(key);
  const key=req.ip??'unknown'; const entry=attempts.get(key)??{count:0,until:now+60_000};entry.count++;attempts.set(key,entry);
  ensure(entry.count<=Number(process.env.WEBHOOK_RATE_LIMIT??60),429,'RATE_LIMIT','Terlalu banyak event webhook');
  ensure(Buffer.isBuffer(req.body),415,'CONTENT_TYPE','Webhook memerlukan application/json');
  verifySignature(req.body,req.get('X-InfraFlow-Timestamp')??'',req.get('X-InfraFlow-Signature')??'');
  let payload:unknown;
  try{payload=JSON.parse(req.body.toString('utf8'));}catch{ensure(false,400,'INVALID_PAYLOAD','JSON webhook tidak valid');}
  res.json(await ingestDemoTicket(payload));
}
export async function importDemoTicket(caller:Actor,payload:unknown) {
  requireDemo();
  const input=demoTicketSchema.parse(payload);
  const body=Buffer.from(JSON.stringify(input)); const timestamp=String(Math.floor(Date.now()/1000));
  verifySignature(body,timestamp,signDemoWebhook(body,timestamp));
  return ingestDemoTicket(input,caller);
}
export async function ticketDetail(caller:Actor,id:string) {
  const ticket=await db.externalTicket.findUnique({where:{id},include:{request:{select:{id:true,status:true,correlationId:true}},events:{orderBy:{createdAt:'asc'}},outbox:{orderBy:{createdAt:'asc'}}}});
  ensure(ticket,404,'NOT_FOUND','Tiket tidak ditemukan');authorize(caller,ticket);
  return ticket;
}
export async function setTicketScenario(caller:Actor,id:string,payload:unknown) {
  requireDemo();const {simulateSyncFailure}=z.object({simulateSyncFailure:z.boolean()}).strict().parse(payload);
  return db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "ExternalTicket" WHERE id=${id} FOR UPDATE`;
    const ticket=await tx.externalTicket.findUnique({where:{id},include:{request:true}});
    ensure(ticket,404,'NOT_FOUND','Tiket tidak ditemukan');authorize(caller,ticket,['OPERATOR','PLATFORM_ADMIN']);
    if(ticket.request) await audit(tx,ticket.request,'TICKET_SCENARIO_CHANGED',caller.id,{simulateSyncFailure});
    return tx.externalTicket.update({where:{id},data:{simulateSyncFailure}});
  });
}
export async function retryTicketSync(caller:Actor,id:string) {
  requireDemo();
  return db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "ExternalTicket" WHERE id=${id} FOR UPDATE`;
    const ticket=await tx.externalTicket.findUnique({where:{id},include:{request:true}});
    ensure(ticket,404,'NOT_FOUND','Tiket tidak ditemukan');authorize(caller,ticket,['OPERATOR']);
    ensure(ticket.syncStatus==='FAILED',409,'SYNC_NOT_FAILED','Retry hanya tersedia untuk sinkronisasi gagal');
    const latest=await tx.outboxEvent.findFirst({where:{ticketId:id,status:'FAILED'},orderBy:{createdAt:'desc'}});
    ensure(latest,409,'NO_OUTBOX','Tidak ada pengiriman hasil yang dapat dicoba ulang');
    await tx.outboxEvent.update({where:{id:latest.id},data:{status:'PENDING',attempts:0,availableAt:new Date(),lastError:null}});
    const updated=await tx.externalTicket.update({where:{id},data:{syncStatus:'PENDING'}});
    if(ticket.request) await audit(tx,ticket.request,'TICKET_SYNC_RETRY',caller.id,{outboxId:latest.id,infrastructureRetried:false});
    return updated;
  });
}
