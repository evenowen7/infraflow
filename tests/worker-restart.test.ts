import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { expect,it } from 'vitest';
import { app } from '../apps/api/src/app.js';
import { db } from '../apps/api/src/db.js';

it('persists a crashed worker dispatch intent across fresh Node processes without redispatch',async()=>{
  async function login(name:string){
    const response=await supertest(app).post('/api/auth/login').set('Origin',process.env.APP_ORIGIN!).send({email:`${name}@demo.infraflow.test`,password:process.env.DEMO_PASSWORD}).expect(200);
    return {cookie:(response.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!,csrf:response.body.csrfToken as string};
  }
  const requester=await login('requester');const approver=await login('approver');
  function post(actor:typeof requester,path:string,body:object){return supertest(app).post(path).set('Origin',process.env.APP_ORIGIN!).set('Cookie',actor.cookie).set('X-CSRF-Token',actor.csrf).set('Idempotency-Key',randomUUID()).send(body);}
  const created=await post(requester,'/api/requests',{action:'POWER_ON_VM',resourceId:'vm-1',parameters:{},reason:'Memeriksa pemulihan worker lintas proses nyata'}).expect(201);
  const id=created.body.id as string;
  await post(requester,`/api/requests/${id}/submit`,{}).expect(200);
  await post(approver,`/api/requests/${id}/decision`,{decision:'APPROVE',reason:'Disetujui untuk pengujian pemulihan worker'}).expect(200);
  const worker=(source:string)=>execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',source],{env:{...process.env},stdio:'pipe'});
  worker(`import {claimRun} from './apps/worker/src/engine.ts'; import {db} from './apps/api/src/db.ts';
    const id=await claimRun('worker-process-one');
    await db.executionRun.update({where:{id},data:{dispatchPhase:'DISPATCHING',externalOperationId:'demo-op-crash-test',leaseExpiresAt:new Date(Date.now()-1000)}});
    await db.$disconnect();`);
  const before=await db.resource.findUniqueOrThrow({where:{id:'vm-1'}});
  worker(`import {tick} from './apps/worker/src/engine.ts'; import {db} from './apps/api/src/db.ts';
    await tick('worker-process-two'); await tick('worker-process-two'); await db.$disconnect();`);
  const persisted=await db.request.findUniqueOrThrow({where:{id},include:{approvals:true,runs:{include:{evidence:true,lock:true}}}});
  expect(persisted.status).toBe('REQUIRES_REVIEW');expect(persisted.approvals).toHaveLength(1);
  expect(persisted.runs).toHaveLength(1);expect(persisted.runs[0]?.lock).not.toBeNull();
  expect(persisted.runs[0]?.evidence).toHaveLength(1);expect(persisted.runs[0]?.dispatchPhase).toBe('DISPATCHING');
  expect(await db.resource.findUniqueOrThrow({where:{id:'vm-1'}})).toEqual(before);
});
