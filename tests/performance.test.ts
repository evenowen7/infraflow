import supertest from 'supertest';
import { expect,it } from 'vitest';
import { app } from '../apps/api/src/app.js';
import { db } from '../apps/api/src/db.js';

it('measures scoped list/detail p95 on 500 persisted demo resources',async()=>{
  await db.resource.createMany({data:Array.from({length:488},(_,i)=>({
    id:`perf-${i}`,externalId:`perf-external-${i}`,adapterId:'demo',name:`perf-vm-${String(i).padStart(3,'0')}`,
    teamId:'team-platform',owner:'requester@demo.infraflow.test',environment:'DEV',cpu:2,ramGb:4,diskGb:40,networkId:'net-platform',
  }))});
  expect(await db.resource.count()).toBe(500);
  const login=await supertest(app).post('/api/auth/login').set('Origin',process.env.APP_ORIGIN!).send({email:'requester@demo.infraflow.test',password:process.env.DEMO_PASSWORD}).expect(200);
  const cookie=(login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  const results:Record<string,number>={};
  for(const path of ['/api/resources?pageSize=100','/api/resources/perf-0']){
    const durations:number[]=[];
    for(let i=0;i<60;i++){
      const start=performance.now();await supertest(app).get(path).set('Cookie',cookie).expect(200);
      if(i>=10)durations.push(performance.now()-start);
    }
    durations.sort((a,b)=>a-b);const p95=durations[Math.ceil(durations.length*0.95)-1]!;
    results[path]=Number(p95.toFixed(2));expect(p95).toBeLessThan(2000);
  }
  console.log('PERFORMANCE_500_RESOURCES_P95_MS',JSON.stringify(results));
});
