import 'dotenv/config';
import { execFileSync } from 'node:child_process';
const value=process.env.TEST_DATABASE_URL;
if(!value) throw new Error('TEST_DATABASE_URL wajib diatur');
const url=new URL(value);
if(!['postgres:','postgresql:'].includes(url.protocol) || !decodeURIComponent(url.pathname).endsWith('_test')) throw new Error('Database pengujian wajib berakhiran _test');
execFileSync('npx',['prisma','migrate','deploy'],{stdio:'inherit',env:{...process.env,DATABASE_URL:value}});
