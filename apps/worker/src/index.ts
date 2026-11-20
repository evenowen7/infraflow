import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { db } from '../../api/src/db.js';
import { validateConfig } from '../../api/src/security.js';
import { tick } from './engine.js';
validateConfig();
const owner=`worker-${randomUUID()}`;
let running=true;
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{running=false;});
console.log('InfraFlow DEMO worker started',owner);
while(running) {
  try { await tick(owner); } catch(error) { console.error('WORKER_ERROR',error instanceof Error?error.name:'UnknownError'); }
  if(running) await setTimeout(Number(process.env.WORKER_POLL_MS??1000));
}
await db.$disconnect();
