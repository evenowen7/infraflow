import { spawnSync } from 'node:child_process';
import process from 'node:process';

function run(args, extraEnv = {}) {
  const result = spawnSync('npm', args, {
    stdio: 'inherit', env: { ...process.env, ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['run', 'build']);
// Only the production deployment applies its dedicated demo database migrations.
// Preview builds must never migrate or seed the production database.
if (process.env.VERCEL_ENV === 'production' && process.env.APP_MODE === 'DEMO') {
  if (process.env.ALLOW_HOSTED_DEMO !== 'true') throw new Error('Hosted DEMO must be explicitly enabled');
  if (!process.env.INITIAL_DEMO_PASSWORD || process.env.INITIAL_DEMO_PASSWORD.length < 12) {
    throw new Error('INITIAL_DEMO_PASSWORD must contain at least 12 characters');
  }
  run(['run', 'db:migrate']);
  // Pass the seed credential only to the seed child process, never as DEMO_PASSWORD
  // in the API/worker environment. Existing account passwords are not reset.
  run(['run', 'db:seed:hosted'], { DEMO_PASSWORD: process.env.INITIAL_DEMO_PASSWORD });
}
