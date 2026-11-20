import { app } from './app.js';
import { db } from './db.js';
import { validateConfig } from './security.js';
validateConfig();
const server=app.listen(Number(process.env.PORT??3001),process.env.API_HOST??'127.0.0.1',()=>console.log(`InfraFlow API DEMO ready on ${process.env.PORT??3001}`));
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(()=>void db.$disconnect()));
