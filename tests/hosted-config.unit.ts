import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { validateConfig, AppError } from '../apps/api/src/security.js';

const keys = ['NODE_ENV','APP_MODE','SESSION_SECRET','APP_ORIGIN','DEMO_PASSWORD','ALLOW_HOSTED_DEMO'];
function config(overrides: Record<string,string|undefined>, check: () => void) {
  const original = Object.fromEntries(keys.map(k => [k,process.env[k]]));
  const values: Record<string,string|undefined> = {
    NODE_ENV:'production', APP_MODE:'DEMO', SESSION_SECRET:randomBytes(32).toString('hex'),
    APP_ORIGIN:'https://infraflow.example.test', DEMO_PASSWORD:undefined, ALLOW_HOSTED_DEMO:undefined,
    ...overrides,
  };
  try {
    for(const k of keys) { if(values[k]===undefined) delete process.env[k]; else process.env[k]=values[k]; }
    check();
  } finally { for(const k of keys) { if(original[k]===undefined) delete process.env[k]; else process.env[k]=original[k]; } }
}
test('production demo stays denied without explicit opt in', () => config({}, () => assert.throws(validateConfig, e => e instanceof AppError && e.code==='DEMO_PRODUCTION_DENIED')));
test('explicit hosted demo works with HTTPS and strong secret', () => config({ALLOW_HOSTED_DEMO:'true'}, () => assert.doesNotThrow(validateConfig)));
test('hosted demo requires HTTPS', () => config({ALLOW_HOSTED_DEMO:'true',APP_ORIGIN:'http://localhost:3001'}, () => assert.throws(validateConfig)));
test('hosted demo rejects runtime seed password', () => config({ALLOW_HOSTED_DEMO:'true',DEMO_PASSWORD:'not-for-runtime'}, () => assert.throws(validateConfig)));
test('hosted demo rejects weak secret', () => config({ALLOW_HOSTED_DEMO:'true',SESSION_SECRET:'too-short'}, () => assert.throws(validateConfig)));
test('hosted flag does not enable connected adapters', () => config({ALLOW_HOSTED_DEMO:'true',APP_MODE:'CONNECTED'}, () => assert.throws(validateConfig, e => e instanceof AppError && e.code==='NOT_CONFIGURED')));
