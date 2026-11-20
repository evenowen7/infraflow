import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Prisma, type Environment, type Role } from '@prisma/client';
import { db } from './db.js';
import { AppError, authorize, ensure, json, scope, sessionHash, verifyPassword, type Actor } from './security.js';
import { cancelRequest, cloneRequest, createDraft, decideRequest, submitRequest, updateDraft, userSelect } from './workflow.js';
import { decisionSchema, statuses } from '../../../packages/contracts/src/index.js';
import { reconcileRun } from '../../worker/src/engine.js';
import { demoWebhook, importDemoTicket, retryTicketSync, setTicketScenario, ticketDetail } from './tickets.js';

const app = express();
app.disable('x-powered-by');
app.post('/api/webhooks/demo',express.raw({type:'application/json',limit:'32kb'}),demoWebhook);
app.use(express.json({limit:'32kb'}));
app.use((_req,res,next) => {
  res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"});
  next();
});
const mode = () => process.env.APP_MODE??'DEMO';
const publicUser = (u: Actor) => ({id:u.id,name:u.name,email:u.email,assignments:u.assignments.map(({role,teamId,environments})=>({role,teamId,environments}))});
const actor = (res: Response) => res.locals.actor as Actor;
const param = (req: Request,name='id') => z.string().parse(req.params[name]);
const cookieToken = (req: Request) => req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('infraflow_session='))?.slice('infraflow_session='.length);
function pageOf(req: Request) {
  return z.object({page:z.coerce.number().int().min(1).max(10000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)}).parse(req.query);
}
function origin(req: Request) { ensure(req.headers.origin===process.env.APP_ORIGIN,403,'ORIGIN_DENIED','Origin tidak diizinkan'); }
function hasRole(user: Actor, roles: Role[]) { return user.active && user.assignments.some(a=>roles.includes(a.role)); }
const throttle = new Map<string,{count:number;until:number}>();
function loginLimit(req: Request) {
  const key = req.ip??'local';
  const now = Date.now();
  for (const [k,v] of throttle) if (v.until<now) throttle.delete(k);
  const entry = throttle.get(key)??{count:0,until:now+15*60_000};
  entry.count++;
  throttle.set(key,entry);
  ensure(entry.count<=Number(process.env.LOGIN_RATE_LIMIT??40),429,'RATE_LIMIT','Terlalu banyak percobaan login; coba lagi nanti');
}
app.get('/healthz',(_req,res)=>res.json({status:'UP',mode:mode()}));
app.get('/readyz',async (_req,res)=>{
  try { await db.$queryRaw`SELECT 1`; res.json({database:'UP',mode:mode()}); }
  catch { res.status(503).json({database:'DOWN',mode:mode()}); }
});
app.post('/api/auth/login',async (req,res)=>{
  origin(req); loginLimit(req);
  const input = z.object({email:z.email().max(200),password:z.string().min(1).max(256)}).strict().parse(req.body);
  const user = await db.user.findUnique({where:{email:input.email.toLowerCase()},include:{assignments:true}});
  const valid = verifyPassword(input.password,user?.passwordHash??'00000000000000000000000000000000:'+ '00'.repeat(64));
  ensure(user?.active && valid,401,'INVALID_CREDENTIALS','Email atau password tidak valid');
  const previous = cookieToken(req);
  if (previous) await db.session.deleteMany({where:{id:sessionHash(previous)}});
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  await db.session.create({data:{id:sessionHash(token),userId:user.id,csrfToken,expiresAt:new Date(Date.now()+8*60*60_000)}});
  res.cookie('infraflow_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.APP_ORIGIN?.startsWith('https://'),maxAge:8*60*60_000,path:'/'});
  res.json({user:publicUser(user),csrfToken,mode:mode()});
});
app.use('/api',async (req,res,next)=>{
  const token = cookieToken(req);
  ensure(token,401,'UNAUTHENTICATED','Silakan masuk');
  const session = await db.session.findUnique({where:{id:sessionHash(token)},include:{user:{include:{assignments:true}}}});
  ensure(session && session.expiresAt>new Date() && session.user.active,401,'UNAUTHENTICATED','Sesi berakhir; silakan masuk kembali');
  res.locals.actor=session.user; res.locals.session=session;
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    origin(req);
    ensure(req.headers['x-csrf-token']===session.csrfToken,403,'CSRF_INVALID','Token CSRF tidak valid');
  }
  next();
});
app.get('/api/me',(_req,res)=>res.json({user:publicUser(actor(res)),csrfToken:res.locals.session.csrfToken,mode:mode()}));
app.post('/api/auth/logout',async (_req,res)=>{
  await db.session.deleteMany({where:{id:res.locals.session.id}});
  res.clearCookie('infraflow_session',{httpOnly:true,sameSite:'strict',secure:process.env.APP_ORIGIN?.startsWith('https://'),path:'/'}).status(204).end();
});
app.get('/api/catalog',async (_req,res)=>{
  const teamIds = actor(res).assignments.map(a=>a.teamId);
  const [services,templates,sizes,networks]=await Promise.all([db.serviceDefinition.findMany(),db.template.findMany({where:{enabled:true}}),db.sizeProfile.findMany(),db.networkProfile.findMany({where:{teamId:{in:teamIds}}})]);
  res.json({services,templates,sizes,networks,mode:mode()});
});
app.get('/api/resources',async(req,res)=>{
  const {page,pageSize}=pageOf(req);
  const q=z.string().max(100).optional().parse(req.query.q);
  const environment=z.enum(['DEV','TEST','PRODUCTION']).optional().parse(req.query.environment);
  const where: Prisma.ResourceWhereInput={AND:[scope(actor(res)),{environment,...(q?{OR:[{name:{contains:q,mode:'insensitive'}},{externalId:{contains:q,mode:'insensitive'}}]}:{})}]};
  const [items,total]=await Promise.all([db.resource.findMany({where,orderBy:{name:'asc'},skip:(page-1)*pageSize,take:pageSize}),db.resource.count({where})]);
  res.json({items,total,page,pageSize,mode:mode()});
});
app.get('/api/resources/:id',async(req,res)=>{
  const resource=await db.resource.findUnique({where:{id:param(req)}});
  ensure(resource,404,'NOT_FOUND','Resource tidak ditemukan'); authorize(actor(res),resource);
  res.json({...resource,mode:mode()});
});
app.post('/api/resources/:id/refresh',async(req,res)=>{
  const resource=await db.resource.findUnique({where:{id:param(req)}});
  ensure(resource,404,'NOT_FOUND','Resource tidak ditemukan'); authorize(actor(res),resource,['REQUESTER','OPERATOR']);
  ensure(resource.adapterId==='demo' && mode()==='DEMO',503,'NOT_CONFIGURED','Inventory adapter belum terhubung');
  res.json(await db.resource.update({where:{id:resource.id},data:{observedAt:new Date()}}));
});
app.post('/api/resources/:id/scenario',async(req,res)=>{
  ensure(mode()==='DEMO',403,'DEMO_ONLY','Skenario hanya untuk DEMO');
  const {scenario}=z.object({scenario:z.enum(['NORMAL','VERIFY_FAIL','TIMEOUT_AFTER_DISPATCH','SECRET_LOG'])}).strict().parse(req.body);
  res.json(await db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "Resource" WHERE id=${param(req)} FOR UPDATE`;
    const resource=await tx.resource.findUnique({where:{id:param(req)}});
    ensure(resource,404,'NOT_FOUND','Resource tidak ditemukan');authorize(actor(res),resource,['OPERATOR','PLATFORM_ADMIN']);
    ensure(resource.environment!=='PRODUCTION',403,'PRODUCTION_DENIED','Production tidak dapat diubah');
    const lock=await tx.resourceLock.findUnique({where:{key:`resource:${resource.id}`}});
    ensure(!lock,409,'RESOURCE_LOCKED','Resource sedang terkunci');
    await tx.auditEvent.create({data:{actorId:actor(res).id,teamId:resource.teamId,environment:resource.environment,action:'DEMO_SCENARIO_CHANGED',correlationId:randomUUID(),source:'PORTAL',details:json({resourceId:resource.id,scenario})}});
    return tx.resource.update({where:{id:resource.id},data:{scenario}});
  }));
});
app.post('/api/requests',async(req,res)=>res.status(201).json(json(await createDraft(actor(res),req.body,req.get('Idempotency-Key')??''))));
app.patch('/api/requests/:id',async(req,res)=>res.json(json(await updateDraft(actor(res),param(req),req.body))));
app.post('/api/requests/:id/submit',async(req,res)=>res.json(json(await submitRequest(actor(res),param(req)))));
app.post('/api/requests/:id/cancel',async(req,res)=>res.json(json(await cancelRequest(actor(res),param(req)))));
app.post('/api/requests/:id/clone',async(req,res)=>res.status(201).json(json(await cloneRequest(actor(res),param(req),req.get('Idempotency-Key')??''))));
app.post('/api/requests/:id/decision',async(req,res)=>{
  const {decision,reason}=decisionSchema.parse(req.body);
  res.json(json(await decideRequest(actor(res),param(req),decision,reason)));
});
async function listRequests(req: Request,res: Response, approvals = false) {
  const {page,pageSize}=pageOf(req);
  if (approvals) ensure(hasRole(actor(res),['APPROVER']),403,'FORBIDDEN','Peran approver diperlukan');
  const status=approvals?'AWAITING_APPROVAL':z.enum(statuses).optional().parse(req.query.status);
  const action=z.enum(['POWER_ON_VM','RESTART_VM','CREATE_VM']).optional().parse(req.query.action);
  const where: Prisma.RequestWhereInput={AND:[scope(actor(res),approvals?['APPROVER']:undefined),{status,action,...(approvals?{requesterId:{not:actor(res).id}}:{})}]};
  const [items,total]=await Promise.all([db.request.findMany({where,include:{resource:true,requester:{select:userSelect},ticket:true},orderBy:{createdAt:'desc'},skip:(page-1)*pageSize,take:pageSize}),db.request.count({where})]);
  res.json(json({items,total,page,pageSize,mode:mode()}));
}
app.get('/api/requests',(req,res)=>listRequests(req,res));
app.get('/api/approvals',(req,res)=>listRequests(req,res,true));
async function detail(id: string,user: Actor) {
  const request=await db.request.findUnique({where:{id},include:{resource:true,requester:{select:userSelect},approvals:{include:{actor:{select:userSelect}}},runs:{include:{events:{orderBy:{createdAt:'asc'}},evidence:{orderBy:{createdAt:'asc'}}}},audit:{orderBy:{createdAt:'asc'}},ticket:true}});
  ensure(request,404,'NOT_FOUND','Request tidak ditemukan'); authorize(user,request);
  return request;
}
app.get('/api/requests/:id',async(req,res)=>res.json(json({...await detail(param(req),actor(res)),mode:mode()})));
app.get('/api/requests/:id/evidence',async(req,res)=>{
  const request=await detail(param(req),actor(res));
  res.setHeader('Content-Disposition',`attachment; filename="infraflow-${request.id}.json"`);
  res.json(json({mode:mode(),exportedAt:new Date(),...request}));
});
app.get('/api/runs/:id',async(req,res)=>{
  const run=await db.executionRun.findUnique({where:{id:param(req)},include:{request:true,events:true,evidence:true}});
  ensure(run,404,'NOT_FOUND','Run tidak ditemukan');authorize(actor(res),run.request);
  res.json(json({...run,mode:mode()}));
});
app.post('/api/runs/:id/reconcile',async(req,res)=>{
  const body=z.object({reason:z.string().trim().min(10).max(1000),outcome:z.enum(['CONFIRMED_SUCCEEDED','CONFIRMED_FAILED'])}).strict().parse(req.body);
  res.json(await reconcileRun(actor(res),param(req),body.reason,body.outcome));
});
app.get('/api/dashboard',async(_req,res)=>{
  const where=scope(actor(res));
  const [groups,total,resources,recentRequests,durations]=await Promise.all([
    db.request.groupBy({by:['status'],where,_count:true}),db.request.count({where}),db.resource.count({where}),
    db.request.findMany({where,include:{resource:true,requester:{select:userSelect}},take:6,orderBy:{createdAt:'desc'}}),
    db.executionRun.findMany({where:{request:where,status:{in:['SUCCEEDED','COMPLETED_NOOP']},finishedAt:{not:null},startedAt:{not:null}},select:{startedAt:true,finishedAt:true}}),
  ]);
  res.json(json({mode:mode(),counts:Object.fromEntries(groups.map(g=>[g.status,g._count])),total,resources,recentRequests,averageDurationSeconds:durations.length?durations.reduce((n,r)=>n+(r.finishedAt!.getTime()-r.startedAt!.getTime())/1000,0)/durations.length:null}));
});
app.get('/api/audit',async(req,res)=>{
  const {page,pageSize}=pageOf(req);
  const where=scope(actor(res));
  const [items,total]=await Promise.all([db.auditEvent.findMany({where,include:{actor:{select:userSelect}},orderBy:{createdAt:'desc'},skip:(page-1)*pageSize,take:pageSize}),db.auditEvent.count({where})]);
  res.json(json({items,total,page,pageSize,mode:mode()}));
});
app.get('/api/audit/export',async(_req,res)=>{
  res.setHeader('Content-Disposition','attachment; filename="infraflow-audit.json"');
  res.json(json({mode:mode(),items:await db.auditEvent.findMany({where:scope(actor(res)),orderBy:{createdAt:'desc'},take:1000}),limit:1000}));
});
app.get('/api/tickets',async(req,res)=>{
  const {page,pageSize}=pageOf(req);const where=scope(actor(res));
  const [items,total]=await Promise.all([db.externalTicket.findMany({where,include:{request:{select:{id:true,status:true}}},orderBy:{createdAt:'desc'},take:pageSize,skip:(page-1)*pageSize}),db.externalTicket.count({where})]);
  res.json(json({items,total,page,pageSize,mode:mode()}));
});
app.post('/api/tickets/demo',async(req,res)=>res.json(await importDemoTicket(actor(res),req.body)));
app.get('/api/tickets/:id',async(req,res)=>res.json(json({...await ticketDetail(actor(res),param(req)),mode:mode()})));
app.post('/api/tickets/:id/scenario',async(req,res)=>res.json(json(await setTicketScenario(actor(res),param(req),req.body))));
app.post('/api/tickets/:id/sync-retry',async(req,res)=>res.json(json(await retryTicketSync(actor(res),param(req)))));
app.get('/api/settings',async(_req,res)=>{
  await db.$queryRaw`SELECT 1`;
  res.json({mode:mode(),integrations:[{id:'demo',name:'Demo PostgreSQL adapter',status:'READY',description:'Simulator persisten; tidak mengubah infrastruktur perusahaan'},{id:'jenkins',name:'Jenkins',status:'NOT_CONFIGURED',description:'Interface extension; belum tersambung atau terverifikasi'},{id:'service-desk',name:'Service desk connected',status:'NOT_CONFIGURED',description:'Provider perusahaan belum ditentukan'}],policy:{productionAllowed:false,approvalTtlMinutes:Number(process.env.APPROVAL_TTL_MINUTES??1440),timezone:'Asia/Jakarta'},health:{database:'UP'}});
});
app.use('/api',(_req,res)=>res.status(404).json({error:'Endpoint tidak ditemukan',code:'NOT_FOUND'}));
app.use(express.static(resolve(process.env.WEB_DIST_PATH??'apps/web/dist')));
app.get('/{*path}',(_req,res,next)=>res.sendFile(resolve(process.env.WEB_DIST_PATH??'apps/web/dist','index.html'),error=>error?next():undefined));
app.use((error: unknown,_req: Request,res: Response,_next: NextFunction)=>{
  if (error instanceof z.ZodError) { res.status(422).json({error:'Input tidak valid',code:'VALIDATION_ERROR',issues:error.issues.map(i=>({path:i.path,message:i.message}))});return; }
  if (error instanceof AppError) {res.status(error.status).json(json({error:error.message,code:error.code}));return;}
  if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002','P2034'].includes(error.code)) {res.status(409).json({error:'Konflik data atau transaksi; muat ulang',code:'CONFLICT'});return;}
  if (error && typeof error==='object' && 'status' in error && [400,413].includes(Number(error.status))) {res.status(Number(error.status)).json({error:'Payload tidak valid atau terlalu besar',code:'INVALID_PAYLOAD'});return;}
  console.error('API_ERROR',error instanceof Error?error.name:'UnknownError');
  res.status(500).json({error:'Terjadi kesalahan internal',code:'INTERNAL_ERROR'});
});
export { app, actor, param, mode, hasRole };
export type { Environment };
