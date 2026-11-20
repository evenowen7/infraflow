import { randomUUID } from 'node:crypto';
import type { Prisma, Resource } from '@prisma/client';
import supertest from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../apps/api/src/app.js';
import { db } from '../apps/api/src/db.js';
import { AppError, hash, validateConfig } from '../apps/api/src/security.js';
import { claimRun, executeRun, tick } from '../apps/worker/src/engine.js';
import { wibToIso } from '../packages/contracts/src/index.js';

type Account = 'requester' | 'requester2' | 'approver' | 'operator' | 'auditor' | 'admin';
type Auth = { userId: string; cookie: string; csrf: string };
type Payload = {
  action: 'POWER_ON_VM';
  resourceId: string;
  reason: string;
  parameters: Record<string, unknown>;
  scheduledAt?: string | null;
};

const origin = () => process.env.APP_ORIGIN!;
const payload = (changes: Partial<Payload> = {}): Payload => ({
  action: 'POWER_ON_VM', resourceId: 'vm-1', reason: 'Power on the development service for integration verification',
  parameters: {}, ...changes,
});

async function login(account: Account): Promise<Auth> {
  const response = await supertest(app).post('/api/auth/login').set('Origin', origin())
    .send({ email: `${account}@demo.infraflow.test`, password: process.env.DEMO_PASSWORD }).expect(200);
  const cookies = response.headers['set-cookie'] as unknown as string[];
  const cookie = cookies?.find(value => value.startsWith('infraflow_session='));
  // Assert booleans, not cookie/token values, so failures cannot print credentials.
  expect(Boolean(cookie)).toBe(true);
  expect(Boolean(cookie?.includes('HttpOnly'))).toBe(true);
  expect(Boolean(cookie?.includes('SameSite=Strict'))).toBe(true);
  expect(typeof response.body.csrfToken === 'string' && response.body.csrfToken.length >= 32).toBe(true);
  expect(response.body.user.id).toBe(`user-${account}`);
  return { userId: response.body.user.id as string, cookie: cookie!.split(';')[0]!, csrf: response.body.csrfToken as string };
}

function api(auth: Auth, method: 'get' | 'post' | 'patch', path: string, body?: object | string) {
  const call = supertest(app)[method](path).set('Cookie', auth.cookie);
  if (method !== 'get') call.set('Origin', origin()).set('X-CSRF-Token', auth.csrf);
  if (body !== undefined) call.send(body);
  return call;
}

async function draft(auth: Auth, changes: Partial<Payload> = {}, key = randomUUID()) {
  const response = await api(auth, 'post', '/api/requests', payload(changes)).set('Idempotency-Key', key).expect(201);
  expect(typeof response.body.id).toBe('string');
  return db.request.findUniqueOrThrow({ where: { id: response.body.id as string } });
}

async function submit(auth: Auth, id: string) {
  const response = await api(auth, 'post', `/api/requests/${id}/submit`).expect(200);
  expect(response.body.status).toBe('AWAITING_APPROVAL');
  return db.request.findUniqueOrThrow({ where: { id } });
}

async function approve(auth: Auth, id: string) {
  return api(auth, 'post', `/api/requests/${id}/decision`, {
    decision: 'APPROVE', reason: 'Approved after reviewing the frozen power-on request',
  }).expect(200);
}

async function queued(changes: Partial<Payload> = {}) {
  const requester = await login('requester');
  const approver = await login('approver');
  const flow = await draft(requester, changes);
  await submit(requester, flow.id);
  await approve(approver, flow.id);
  const run = await db.executionRun.findUniqueOrThrow({ where: { requestId: flow.id } });
  return { requester, approver, flow, run };
}

const resource = (id = 'vm-1') => db.resource.findUniqueOrThrow({ where: { id } });
const execution = (id: string) => db.executionRun.findUniqueOrThrow({
  where: { id }, include: { events: { orderBy: { createdAt: 'asc' } }, evidence: true },
});

async function unchanged(before: Resource) {
  expect(await resource(before.id)).toEqual(before);
}

async function noDispatch(runId: string, status: string, before: Resource, code?: string) {
  const run = await execution(runId);
  expect(run.status).toBe(status);
  expect(run.dispatchPhase).toBe('NOT_DISPATCHED');
  expect(run.externalOperationId).toBeNull();
  expect(run.events.some(event => ['DISPATCHING', 'DISPATCHED'].includes(event.kind))).toBe(false);
  expect(run.evidence).toHaveLength(1);
  expect(run.evidence[0]).toMatchObject({ outcome: status, verified: false });
  if (code) expect(run.evidence[0]?.postcheck).toMatchObject({ code });
  expect((await db.request.findUniqueOrThrow({ where: { id: run.requestId } })).status).toBe(status);
  expect(await db.resourceLock.count({ where: { runId } })).toBe(0);
  await unchanged(before);
}

async function scenario(value: string) {
  await db.resource.update({ where: { id: 'vm-1' }, data: { scenario: value } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('POWER_ON_VM power-on integration', () => {
  it('redacts secret-like rationale from mutation responses without breaking snapshot verification', async () => {
    const requester=await login('requester');const approver=await login('approver');
    const reason='Operational rationale password=fixture-hidden-password token=fixture-hidden-token';
    const responses=[];
    const created=await api(requester,'post','/api/requests',payload({reason})).set('Idempotency-Key',randomUUID()).expect(201);
    responses.push(created);
    const id=created.body.id as string;
    responses.push(await api(requester,'patch',`/api/requests/${id}`,{reason}).expect(200));
    responses.push(await api(requester,'post',`/api/requests/${id}/submit`).expect(200));
    responses.push(await approve(approver,id));await tick('redacted-rationale');
    responses.push(await api(requester,'get',`/api/requests/${id}/evidence`).expect(200));
    expect((await db.request.findUniqueOrThrow({where:{id}})).status).toBe('SUCCEEDED');
    for(const response of responses) {
      expect(JSON.stringify(response.body).includes('fixture-hidden-password')).toBe(false);
      expect(JSON.stringify(response.body).includes('fixture-hidden-token')).toBe(false);
    }
  });
  it('submits, independently approves, mutates PostgreSQL once, verifies and exports correlated evidence', async () => {
    const requester = await login('requester');
    const approver = await login('approver');
    const before = await resource();
    const flow = await draft(requester);
    expect(flow).toMatchObject({ status: 'DRAFT', requesterId: requester.userId, teamId: 'team-platform', environment: 'DEV', action: 'POWER_ON_VM' });
    expect(await tick('before-submit')).toBeNull();
    const frozen = await submit(requester, flow.id);
    expect(frozen.snapshot).toMatchObject({
      action: 'POWER_ON_VM', target: { id: before.id, externalId: before.externalId, environment: 'DEV', adapterId: 'demo' },
      parameters: {}, reason: flow.reason, serviceVersion: 1,
      verifierContract: { powerState: 'poweredOn', guestReady: true, serviceHealthy: true },
    });
    expect(frozen.snapshotHash).toBe(hash(frozen.snapshot));
    expect(await tick('before-approval')).toBeNull();
    await unchanged(before);
    const approvalResponse = await approve(approver, flow.id);
    expect(approvalResponse.body.status).toBe('QUEUED');
    const approval = await db.approval.findFirstOrThrow({ where: { requestId: flow.id } });
    expect(approval).toMatchObject({ actorId: approver.userId, requestVersion: frozen.version, snapshotHash: frozen.snapshotHash, decision: 'APPROVE' });
    expect(approval.actorId).not.toBe(flow.requesterId);
    const runId = await tick('happy-path-worker');
    expect(typeof runId).toBe('string');
    const run = await execution(runId!);
    expect(run).toMatchObject({ requestId: flow.id, status: 'SUCCEEDED', dispatchPhase: 'DISPATCHED', attempt: 1, leaseOwner: null, leaseExpiresAt: null });
    expect(run.externalOperationId).toMatch(/^demo-op-/);
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.events.map(event => event.kind)).toEqual(['CLAIMED', 'DISPATCHING', 'DISPATCHED', 'VERIFYING', 'SUCCEEDED']);
    const after = await resource();
    expect(after).toMatchObject({ powerState: 'poweredOn', guestState: 'ready', serviceHealthy: true, mutationCount: before.mutationCount + 1 });
    expect(after.bootMarker).not.toBe(before.bootMarker);
    expect(run.evidence).toHaveLength(1);
    expect(run.evidence[0]).toMatchObject({
      outcome: 'SUCCEEDED', verified: true, mode: 'DEMO', correlationId: flow.correlationId,
      precheck: { ready: true },
      postcheck: { verified: true, checks: { poweredOn: true, guestReady: true, serviceHealthy: true }, observation: { id: before.id, mutationCount: 1, bootMarker: after.bootMarker } },
    });
    expect(await db.resourceLock.count()).toBe(0);
    const auditor = await login('auditor');
    const detail = await api(auditor, 'get', `/api/requests/${flow.id}`).expect(200);
    expect(detail.body.status).toBe('SUCCEEDED');
    expect(detail.body.requester.passwordHash).toBeUndefined();
    const exported = await api(auditor, 'get', `/api/requests/${flow.id}/evidence`).expect(200);
    expect(exported.headers['content-disposition']).toContain('attachment;');
    expect(exported.body.runs[0].evidence[0]).toMatchObject({ verified: true, outcome: 'SUCCEEDED', correlationId: flow.correlationId });
    const audit = await db.auditEvent.findMany({ where: { requestId: flow.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map(event => event.action)).toEqual(['DRAFT_CREATED', 'AWAITING_APPROVAL', 'APPROVED', 'QUEUED', 'RUNNING', 'VERIFYING', 'SUCCEEDED']);
    expect(audit.every(event => event.correlationId === flow.correlationId)).toBe(true);
    expect(await tick('repeat-worker')).toBeNull();
    await executeRun(run.id, 'happy-path-worker');
    expect((await resource()).mutationCount).toBe(1);
    expect(await db.evidence.count({ where: { runId: run.id } })).toBe(1);
  });

  it('verifies an already-on VM as COMPLETED_NOOP without any resource mutation or dispatch', async () => {
    const before = await resource('vm-2');
    const { flow, run } = await queued({ resourceId: before.id });
    expect(await tick('noop-worker')).toBe(run.id);
    const result = await execution(run.id);
    expect(result).toMatchObject({ status: 'COMPLETED_NOOP', dispatchPhase: 'NOT_DISPATCHED', externalOperationId: null });
    expect(result.events.map(event => event.kind)).toEqual(['CLAIMED', 'COMPLETED_NOOP']);
    expect(result.evidence[0]).toMatchObject({ outcome: 'COMPLETED_NOOP', verified: true, postcheck: { checks: { poweredOn: true, guestReady: true, serviceHealthy: true } } });
    expect((await db.request.findUniqueOrThrow({ where: { id: flow.id } })).status).toBe('COMPLETED_NOOP');
    expect(await db.resourceLock.count()).toBe(0);
    await unchanged(before);
  });

  it('rejects self approval even when the requester is also assigned APPROVER in the database', async () => {
    const requester = await login('requester');
    const flow = await draft(requester);
    await submit(requester, flow.id);
    await db.roleAssignment.create({ data: { userId: requester.userId, teamId: flow.teamId, role: 'APPROVER', environments: ['DEV', 'TEST'] } });
    const response = await api(requester, 'post', `/api/requests/${flow.id}/decision`, { decision: 'APPROVE', reason: 'Attempt to approve my own request' }).expect(403);
    expect(response.body.code).toBe('SELF_APPROVAL');
    expect(await db.approval.count()).toBe(0);
    expect(await db.executionRun.count()).toBe(0);
    expect((await db.request.findUniqueOrThrow({ where: { id: flow.id } })).status).toBe('AWAITING_APPROVAL');
    const approvals = await api(requester, 'get', '/api/approvals').expect(200);
    expect(approvals.body.items).toEqual([]);
  });

  it('enforces cross-team detail, resource, export, submit, decision and run boundaries', async () => {
    const requester = await login('requester');
    const outsider = await login('requester2');
    await db.roleAssignment.create({ data: { userId: outsider.userId, teamId: 'team-data', role: 'APPROVER', environments: ['DEV', 'TEST', 'PRODUCTION'] } });
    const flow = await draft(requester);
    for (const path of [`/api/requests/${flow.id}`, `/api/requests/${flow.id}/evidence`, '/api/resources/vm-1']) {
      expect((await api(outsider, 'get', path).expect(403)).body.code).toBe('FORBIDDEN');
    }
    expect((await api(outsider, 'post', `/api/requests/${flow.id}/submit`).expect(403)).body.code).toBe('FORBIDDEN');
    await api(outsider, 'patch', `/api/requests/${flow.id}`, { reason: 'Attempt to modify another team request' }).expect(403);
    await api(outsider, 'post', `/api/requests/${flow.id}/cancel`).expect(403);
    await api(outsider, 'post', '/api/resources/vm-1/refresh').expect(403);
    await api(outsider, 'post', '/api/requests', payload()).set('Idempotency-Key', randomUUID()).expect(403);
    await submit(requester, flow.id);
    expect((await api(outsider, 'post', `/api/requests/${flow.id}/decision`, { decision: 'APPROVE', reason: 'Cross-team approval attempt' }).expect(403)).body.code).toBe('FORBIDDEN');
    const approver = await login('approver');
    await approve(approver, flow.id);
    const run = await db.executionRun.findUniqueOrThrow({ where: { requestId: flow.id } });
    await api(outsider, 'get', `/api/runs/${run.id}`).expect(403);
    const own = await draft(outsider, { resourceId: 'vm-11' });
    const listed = await api(outsider, 'get', '/api/requests').expect(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual([own.id]);
    const resources = await api(outsider, 'get', '/api/resources').expect(200);
    expect(resources.body.items.length).toBeGreaterThan(0);
    expect(resources.body.items.every((item: { teamId: string }) => item.teamId === 'team-data')).toBe(true);
    for (const path of ['/api/audit', '/api/audit/export']) {
      const result = await api(outsider, 'get', path).expect(200);
      expect(result.body.items.length).toBeGreaterThan(0);
      expect(result.body.items.every((item: { teamId: string }) => item.teamId === 'team-data')).toBe(true);
    }
    expect(await db.approval.count({ where: { requestId: flow.id } })).toBe(1);
    expect((await resource()).mutationCount).toBe(0);
  });

  it.each(['auditor', 'admin'] as const)('%s can inspect but cannot request, approve, cancel or reconcile power-on', async account => {
    await scenario('TIMEOUT_AFTER_DISPATCH');
    const requester = await login('requester');
    const actor = await login(account);
    const flow = await draft(requester);
    await api(actor, 'get', `/api/requests/${flow.id}`).expect(200);
    await api(actor, 'post', '/api/requests', payload()).set('Idempotency-Key', randomUUID()).expect(403);
    await api(actor, 'patch', `/api/requests/${flow.id}`, { reason: 'Unauthorized role attempts a draft update' }).expect(403);
    await api(actor, 'post', `/api/requests/${flow.id}/submit`).expect(403);
    await api(actor, 'post', `/api/requests/${flow.id}/cancel`).expect(403);
    await api(actor, 'post', '/api/resources/vm-1/refresh').expect(403);
    await submit(requester, flow.id);
    await api(actor, 'post', `/api/requests/${flow.id}/decision`, { decision: 'APPROVE', reason: 'Unauthorized approval attempt' }).expect(403);
    await api(actor, 'get', '/api/approvals').expect(403);
    expect(await db.approval.count()).toBe(0);
    await approve(await login('approver'), flow.id);
    const runId = await tick(`role-${account}`);
    expect(typeof runId).toBe('string');
    await api(actor, 'post', `/api/runs/${runId}/reconcile`, { outcome: 'CONFIRMED_SUCCEEDED', reason: 'Unauthorized reconciliation attempt' }).expect(403);
    expect((await execution(runId!)).status).toBe('REQUIRES_REVIEW');
    expect(await db.resourceLock.count()).toBe(1);
  });

  it('rejects unauthenticated reads and mutations without disclosing object existence', async () => {
    const { flow, run } = await queued();
    for (const path of ['/api/me', '/api/requests', `/api/requests/${flow.id}`, `/api/requests/${flow.id}/evidence`, '/api/resources/vm-1', `/api/runs/${run.id}`, '/api/audit/export']) {
      expect((await supertest(app).get(path).expect(401)).body.code).toBe('UNAUTHENTICATED');
    }
    for (const path of ['/api/requests', `/api/requests/${flow.id}/submit`, `/api/requests/${flow.id}/decision`, `/api/requests/${flow.id}/cancel`, `/api/runs/${run.id}/reconcile`]) {
      expect((await supertest(app).post(path).set('Origin', origin()).send({}).expect(401)).body.code).toBe('UNAUTHENTICATED');
    }
    expect((await resource()).mutationCount).toBe(0);
  });

  it('requires the configured Origin and session-bound CSRF on mutations and invalidates logout sessions', async () => {
    const deniedLogin = await supertest(app).post('/api/auth/login').set('Origin', 'https://untrusted.invalid')
      .send({ email: 'requester@demo.infraflow.test', password: process.env.DEMO_PASSWORD }).expect(403);
    expect(deniedLogin.body.code).toBe('ORIGIN_DENIED');
    expect(await db.session.count()).toBe(0);
    const requester = await login('requester');
    const approver = await login('approver');
    const flow = await draft(requester);
    for (const method of ['post', 'patch'] as const) {
      const path = method === 'post' ? `/api/requests/${flow.id}/submit` : `/api/requests/${flow.id}`;
      const missing = await supertest(app)[method](path).set('Cookie', requester.cookie).set('Origin', origin()).send({}).expect(403);
      expect(missing.body.code).toBe('CSRF_INVALID');
      const foreign = await supertest(app)[method](path).set('Cookie', requester.cookie).set('Origin', origin()).set('X-CSRF-Token', approver.csrf).send({}).expect(403);
      expect(foreign.body.code).toBe('CSRF_INVALID');
      const wrongOrigin = await supertest(app)[method](path).set('Cookie', requester.cookie).set('Origin', 'https://untrusted.invalid').set('X-CSRF-Token', requester.csrf).send({}).expect(403);
      expect(wrongOrigin.body.code).toBe('ORIGIN_DENIED');
    }
    const create = await supertest(app).post('/api/requests').set('Cookie', requester.cookie).set('Origin', origin()).set('Idempotency-Key', randomUUID()).send(payload()).expect(403);
    expect(create.body.code).toBe('CSRF_INVALID');
    const state = await db.request.findUniqueOrThrow({ where: { id: flow.id } });
    expect(state.status).toBe('DRAFT');
    expect(await db.request.count()).toBe(1);
    await api(requester, 'get', '/api/me').expect(200);
    await api(requester, 'post', '/api/auth/logout').expect(204);
    await api(requester, 'get', '/api/me').expect(401);
    await api(requester, 'post', `/api/requests/${flow.id}/submit`).expect(401);
  });

  it.each([
    ['top-level production environment', { environment: 'PRODUCTION' }],
    ['nested production environment', { parameters: { environment: 'PRODUCTION' } }],
    ['spoofed nonproduction environment for production target', { resourceId: 'vm-9', environment: 'DEV' }],
    ['spoofed approval status', { status: 'APPROVED' }],
  ])('rejects injected %s rather than trusting client scope', async (_name, injection) => {
    const requester = await login('requester');
    const response = await api(requester, 'post', '/api/requests', { ...payload(), ...injection }).set('Idempotency-Key', randomUUID()).expect(422);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(await db.request.count()).toBe(0);
    expect(await db.executionRun.count()).toBe(0);
    expect((await resource('vm-9')).mutationCount).toBe(0);
  });

  it('rejects the actual catalog production VM even for a requester assigned PRODUCTION scope', async () => {
    const requester = await login('requester');
    const before = await resource('vm-9');
    await api(requester, 'get', '/api/resources/vm-9').expect(200);
    const response = await api(requester, 'post', '/api/requests', payload({ resourceId: before.id })).set('Idempotency-Key', randomUUID()).expect(403);
    expect(response.body.code).toBe('PRODUCTION_DENIED');
    const flow = await draft(requester);
    const patch = await api(requester, 'patch', `/api/requests/${flow.id}`, { resourceId: before.id }).expect(403);
    expect(patch.body.code).toBe('PRODUCTION_DENIED');
    expect((await db.request.findUniqueOrThrow({ where: { id: flow.id } })).resourceId).toBe('vm-1');
    expect(await db.executionRun.count()).toBe(0);
    await unchanged(before);
  });

  it('binds approval to canonical content rather than JSON object insertion order', async () => {
    const requester = await login('requester');
    const flow = await draft(requester);
    const frozen = await submit(requester, flow.id);
    const reordered = Object.fromEntries(Object.entries(frozen.snapshot as Prisma.JsonObject).reverse()) as Prisma.InputJsonObject;
    expect(hash(reordered)).toBe(frozen.snapshotHash);
    await db.request.update({ where: { id: flow.id }, data: { snapshot: reordered } });
    await approve(await login('approver'), flow.id);
    const runId = await tick('canonical-order-worker');
    expect((await execution(runId!)).status).toBe('SUCCEEDED');
    expect((await resource()).mutationCount).toBe(1);
  });

  it('rejects approval when authoritative request content no longer matches the submitted snapshot', async () => {
    const requester = await login('requester');
    const flow = await draft(requester);
    await submit(requester, flow.id);
    await db.request.update({ where: { id: flow.id }, data: { reason: 'Changed outside the submitted immutable request' } });
    const response = await api(await login('approver'), 'post', `/api/requests/${flow.id}/decision`, { decision: 'APPROVE', reason: 'Review changed request' }).expect(409);
    expect(response.body.code).toBe('SNAPSHOT_MISMATCH');
    expect(await db.approval.count()).toBe(0);
    expect(await db.executionRun.count()).toBe(0);
  });

  const dispatchGuards: { name: string; code: string; change: (requestId: string) => Promise<unknown> }[] = [
    { name: 'request reason changed', code: 'SNAPSHOT_MISMATCH', change: id => db.request.update({ where: { id }, data: { reason: 'Tampered after independent approval was granted' } }) },
    { name: 'stored snapshot changed', code: 'SNAPSHOT_MISMATCH', change: id => db.request.update({ where: { id }, data: { snapshot: { action: 'POWER_ON_VM', target: { id: 'vm-4' } } } }) },
    { name: 'approval snapshot hash changed', code: 'SNAPSHOT_MISMATCH', change: id => db.approval.updateMany({ where: { requestId: id }, data: { snapshotHash: 'not-the-approved-hash' } }) },
    { name: 'service version changed', code: 'SNAPSHOT_MISMATCH', change: () => db.serviceDefinition.update({ where: { action: 'POWER_ON_VM' }, data: { version: { increment: 1 } } }) },
    { name: 'target identity changed', code: 'SNAPSHOT_MISMATCH', change: () => db.resource.update({ where: { id: 'vm-1' }, data: { externalId: 'replaced-authoritative-target' } }) },
    { name: 'approver role revoked', code: 'FORBIDDEN', change: () => db.roleAssignment.deleteMany({ where: { userId: 'user-approver', role: 'APPROVER' } }) },
    { name: 'requester role revoked', code: 'FORBIDDEN', change: () => db.roleAssignment.deleteMany({ where: { userId: 'user-requester', role: 'REQUESTER' } }) },
    { name: 'approver scope revoked', code: 'FORBIDDEN', change: () => db.roleAssignment.updateMany({ where: { userId: 'user-approver' }, data: { environments: ['TEST'] } }) },
    { name: 'requester disabled', code: 'FORBIDDEN', change: () => db.user.update({ where: { id: 'user-requester' }, data: { active: false } }) },
    { name: 'approver disabled', code: 'FORBIDDEN', change: () => db.user.update({ where: { id: 'user-approver' }, data: { active: false } }) },
    { name: 'power-on service disabled', code: 'NOT_CONFIGURED', change: () => db.serviceDefinition.update({ where: { action: 'POWER_ON_VM' }, data: { enabled: false } }) },
  ];
  it.each(dispatchGuards)('blocks dispatch when $name', async ({ change, code }) => {
    const { flow, run } = await queued();
    await change(flow.id);
    const before = await resource();
    expect(await tick('execution-guard-worker')).toBe(run.id);
    await noDispatch(run.id, 'FAILED', before, code);
  });

  it('rechecks approval expiry after a worker claim and does not dispatch', async () => {
    const { flow, run } = await queued();
    const before = await resource();
    expect(await claimRun('expired-approval-worker')).toBe(run.id);
    await db.approval.updateMany({ where: { requestId: flow.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await executeRun(run.id, 'expired-approval-worker');
    await noDispatch(run.id, 'EXPIRED', before, 'APPROVAL_EXPIRED');
  });

  it('expires queued approvals before claiming them', async () => {
    const { flow, run } = await queued();
    const before = await resource();
    await db.approval.updateMany({ where: { requestId: flow.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    expect(await tick('expire-before-claim')).toBeNull();
    expect(await execution(run.id)).toMatchObject({ status: 'EXPIRED', dispatchPhase: 'NOT_DISPATCHED', startedAt: null, externalOperationId: null });
    expect((await db.request.findUniqueOrThrow({ where: { id: flow.id } })).status).toBe('EXPIRED');
    expect(await db.resourceLock.count()).toBe(0);
    await unchanged(before);
  });

  it('allows draft changes but rejects every patch after submission without changing the frozen content', async () => {
    const requester = await login('requester');
    const flow = await draft(requester);
    const edit = await api(requester, 'patch', `/api/requests/${flow.id}`, { reason: 'Updated rationale before freezing the power-on request', resourceId: 'vm-4' }).expect(200);
    expect(edit.body.version).toBe(flow.version + 1);
    const frozen = await submit(requester, flow.id);
    for (const patch of [{ reason: 'Tampered submitted request rationale' }, { resourceId: 'vm-1' }, { parameters: {} }, { scheduledAt: null }]) {
      const response = await api(requester, 'patch', `/api/requests/${flow.id}`, patch).expect(409);
      expect(response.body.code).toBe('IMMUTABLE_SNAPSHOT');
    }
    expect(await db.request.findUniqueOrThrow({ where: { id: flow.id } })).toEqual(frozen);
    await approve(await login('approver'), flow.id);
    const approved = await db.request.findUniqueOrThrow({ where: { id: flow.id } });
    await api(requester, 'patch', `/api/requests/${flow.id}`, { reason: 'Tampered approved request rationale' }).expect(409);
    expect(await db.request.findUniqueOrThrow({ where: { id: flow.id } })).toEqual(approved);
  });

  it('deduplicates concurrent create calls with one key and payload, and rejects a conflicting payload', async () => {
    const requester = await login('requester');
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 6 }, () => api(requester, 'post', '/api/requests', payload()).set('Idempotency-Key', key)));
    expect(responses.map(response => response.status)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(new Set(responses.map(response => response.body.id)).size).toBe(1);
    expect(await db.request.count()).toBe(1);
    expect(await db.auditEvent.count({ where: { action: 'DRAFT_CREATED' } })).toBe(1);
    const response = await api(requester, 'post', '/api/requests', payload({ reason: 'Different rationale reusing the same idempotency key' })).set('Idempotency-Key', key).expect(409);
    expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await db.request.count()).toBe(1);
    expect(await db.executionRun.count()).toBe(0);
  });

  it('requires an idempotency key before persisting a create request', async () => {
    const requester = await login('requester');
    const response = await api(requester, 'post', '/api/requests', payload()).expect(400);
    expect(response.body.code).toBe('IDEMPOTENCY_REQUIRED');
    expect(await db.request.count()).toBe(0);
  });

  it('serializes concurrent submissions and decisions into one approval and one execution run', async () => {
    const requester = await login('requester');
    const approver = await login('approver');
    const flow = await draft(requester);
    const submits = await Promise.all(Array.from({ length: 4 }, () => api(requester, 'post', `/api/requests/${flow.id}/submit`)));
    expect(submits.map(response => response.status).sort()).toEqual([200, 409, 409, 409]);
    const decisions = await Promise.all(Array.from({ length: 4 }, () => api(approver, 'post', `/api/requests/${flow.id}/decision`, { decision: 'APPROVE', reason: 'Concurrent independent approval' })));
    expect(decisions.map(response => response.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await db.approval.count({ where: { requestId: flow.id } })).toBe(1);
    expect(await db.executionRun.count({ where: { requestId: flow.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { requestId: flow.id, action: 'AWAITING_APPROVAL' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { requestId: flow.id, action: 'APPROVED' } })).toBe(1);
    await tick('concurrent-approved-worker');
    expect((await resource()).mutationCount).toBe(1);
  });

  it('holds one resource lock across competing workers; a second request waits and then completes as a no-op', async () => {
    const first = await queued();
    const second = await draft(first.requester, { reason: 'A separate approved request for the same development VM' });
    await submit(first.requester, second.id);
    await approve(first.approver, second.id);
    const owners = ['resource-worker-a', 'resource-worker-b'];
    const claims = await Promise.all(owners.map(owner => claimRun(owner)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.findIndex(Boolean);
    const claimedId = claims[winner]!;
    const lock = await db.resourceLock.findUniqueOrThrow({ where: { key: 'resource:vm-1' } });
    expect(lock.runId).toBe(claimedId);
    expect(await claimRun('blocked-worker')).toBeNull();
    expect((await resource()).mutationCount).toBe(0);
    const waiting = await db.executionRun.findFirstOrThrow({ where: { id: { not: claimedId } } });
    expect(waiting).toMatchObject({ status: 'QUEUED', dispatchPhase: 'NOT_DISPATCHED', leaseOwner: null });
    await executeRun(claimedId, owners[winner]!);
    expect((await execution(claimedId)).status).toBe('SUCCEEDED');
    expect(await db.resourceLock.count()).toBe(0);
    const afterFirst = await resource();
    expect(afterFirst.mutationCount).toBe(1);
    expect(await claimRun('waiting-worker')).toBe(waiting.id);
    await executeRun(waiting.id, 'waiting-worker');
    expect(await execution(waiting.id)).toMatchObject({ status: 'COMPLETED_NOOP', dispatchPhase: 'NOT_DISPATCHED', externalOperationId: null });
    expect(await db.resourceLock.count()).toBe(0);
    await unchanged(afterFirst);
  });

  it.each(['DRAFT', 'AWAITING_APPROVAL', 'QUEUED', 'SCHEDULED'] as const)('cancels %s before dispatch and prevents future execution', async state => {
    const requester = await login('requester');
    const flow = await draft(requester, state === 'SCHEDULED' ? { scheduledAt: new Date(Date.now() + 10 * 60_000).toISOString() } : {});
    if (state !== 'DRAFT') await submit(requester, flow.id);
    if (state === 'QUEUED' || state === 'SCHEDULED') await approve(await login('approver'), flow.id);
    const before = await resource();
    expect((await db.request.findUniqueOrThrow({ where: { id: flow.id } })).status).toBe(state);
    const cancelled = await api(requester, 'post', `/api/requests/${flow.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(await tick('cancelled-worker')).toBeNull();
    const runs = await db.executionRun.findMany({ where: { requestId: flow.id } });
    if (state === 'QUEUED' || state === 'SCHEDULED') {
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'CANCELLED', dispatchPhase: 'NOT_DISPATCHED', externalOperationId: null });
      expect(runs[0]?.finishedAt).toBeInstanceOf(Date);
    } else expect(runs).toHaveLength(0);
    expect(await db.resourceLock.count()).toBe(0);
    await unchanged(before);
  });

  it('cannot cancel after a worker claims the request', async () => {
    const { requester, flow, run } = await queued();
    expect(await claimRun('running-cancel-worker')).toBe(run.id);
    const response = await api(requester, 'post', `/api/requests/${flow.id}/cancel`).expect(409);
    expect(response.body.code).toBe('CANNOT_CANCEL');
    expect((await execution(run.id)).status).toBe('RUNNING');
    expect(await db.resourceLock.count()).toBe(1);
    await executeRun(run.id, 'running-cancel-worker');
    expect((await execution(run.id)).status).toBe('SUCCEEDED');
    expect((await resource()).mutationCount).toBe(1);
  });

  it('converts WIB to UTC, persists the instant, and never dispatches a scheduled request early', async () => {
    expect(wibToIso('2030-01-02T00:15')).toBe('2030-01-01T17:15:00.000Z');
    const due = new Date(Date.now() + 10 * 60_000);
    due.setUTCSeconds(0, 0);
    const localWib = new Date(due.getTime() + 7 * 60 * 60_000).toISOString().slice(0, 16);
    const utc = wibToIso(localWib);
    const { flow, run } = await queued({ scheduledAt: `${localWib}:00+07:00` });
    expect(flow.scheduledAt?.toISOString()).toBe(utc);
    expect(run.availableAt.toISOString()).toBe(utc);
    expect(run.status).toBe('SCHEDULED');
    const before = await resource();
    const claimed = await tick('too-early-worker');
    await unchanged(before);
    expect.soft((await execution(run.id)).status).toBe('SCHEDULED');
    expect(claimed).toBeNull();
  });

  it('rechecks the approved schedule at dispatch even if a queue row is made eligible early', async () => {
    const { run } = await queued({ scheduledAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    const before = await resource();
    // Leave the approved schedule untouched: queue eligibility alone is insufficient.
    await db.executionRun.update({ where: { id: run.id }, data: { availableAt: new Date(Date.now() - 1000) } });
    expect(await claimRun('premature-queue-worker')).toBe(run.id);
    await executeRun(run.id, 'premature-queue-worker');
    await noDispatch(run.id, 'FAILED', before, 'NOT_DUE');
  });

  it('does not recover a live worker lease when a second worker ticks', async () => {
    const { run } = await queued();
    const before = await resource();
    expect(await claimRun('live-lease-worker')).toBe(run.id);
    const claimed = await execution(run.id);
    expect(claimed.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await tick('other-lease-worker')).toBeNull();
    const stillOwned = await execution(run.id);
    expect(stillOwned).toMatchObject({ status: 'RUNNING', leaseOwner: 'live-lease-worker', dispatchPhase: 'NOT_DISPATCHED' });
    expect(stillOwned.evidence).toHaveLength(0);
    expect(await db.resourceLock.findUnique({ where: { key: 'resource:vm-1' } })).toMatchObject({ runId: run.id });
    await unchanged(before);
    await executeRun(run.id, 'live-lease-worker');
    expect((await execution(run.id)).status).toBe('SUCCEEDED');
    expect((await resource()).mutationCount).toBe(1);
  });

  it('rejects past schedules and schedules extending beyond approval validity', async () => {
    const requester = await login('requester');
    const past = await api(requester, 'post', '/api/requests', payload({ scheduledAt: new Date(Date.now() - 60_000).toISOString() })).set('Idempotency-Key', randomUUID()).expect(422);
    expect(past.body.code).toBe('PAST_SCHEDULE');
    vi.stubEnv('APPROVAL_TTL_MINUTES', '5');
    const flow = await draft(requester, { scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString() });
    await submit(requester, flow.id);
    const response = await api(await login('approver'), 'post', `/api/requests/${flow.id}/decision`, { decision: 'APPROVE', reason: 'Approval would expire before dispatch' }).expect(422);
    expect(response.body.code).toBe('APPROVAL_EXPIRY');
    expect(await db.approval.count()).toBe(0);
    expect(await db.executionRun.count()).toBe(0);
  });

  it('recovers an expired DISPATCHING lease into review without mutation, redispatch, or releasing its lock', async () => {
    const { requester, flow, run } = await queued();
    const before = await resource();
    expect(await claimRun('crashed-worker')).toBe(run.id);
    await db.executionRun.update({ where: { id: run.id }, data: { dispatchPhase: 'DISPATCHING', externalOperationId: `demo-op-${randomUUID()}`, leaseExpiresAt: new Date(Date.now() - 1000) } });
    expect(await tick('recovery-worker')).toBeNull();
    const recovered = await execution(run.id);
    expect(recovered).toMatchObject({ status: 'REQUIRES_REVIEW', dispatchPhase: 'DISPATCHING', leaseOwner: null, leaseExpiresAt: null });
    expect(recovered.evidence).toHaveLength(1);
    expect(recovered.evidence[0]).toMatchObject({ outcome: 'REQUIRES_REVIEW', verified: false, postcheck: { code: 'WORKER_LEASE_EXPIRED', dispatchPhase: 'DISPATCHING' } });
    expect(await db.resourceLock.findUnique({ where: { key: 'resource:vm-1' } })).toMatchObject({ runId: run.id });
    await executeRun(run.id, 'crashed-worker');
    expect(await tick('repeat-recovery-worker')).toBeNull();
    expect(await db.evidence.count({ where: { runId: run.id } })).toBe(1);
    const clone = await api(requester, 'post', `/api/requests/${flow.id}/clone`).set('Idempotency-Key', randomUUID()).expect(409);
    expect(clone.body.code).toBe('RECONCILIATION_REQUIRED');
    await unchanged(before);
  });

  it('records a timeout after mutation as review and never redispatches automatically', async () => {
    await scenario('TIMEOUT_AFTER_DISPATCH');
    const { run } = await queued();
    expect(await tick('timeout-worker')).toBe(run.id);
    const result = await execution(run.id);
    expect(result).toMatchObject({ status: 'REQUIRES_REVIEW', dispatchPhase: 'DISPATCHED', attempt: 1 });
    expect(result.evidence[0]).toMatchObject({ outcome: 'REQUIRES_REVIEW', verified: false, postcheck: { code: 'DISPATCH_TIMEOUT' } });
    const observed = await resource();
    expect(observed).toMatchObject({ powerState: 'poweredOn', mutationCount: 1 });
    expect(await db.resourceLock.count({ where: { runId: run.id } })).toBe(1);
    for (const owner of ['retry-one', 'retry-two']) {
      expect(await tick(owner)).toBeNull();
      await executeRun(run.id, owner);
    }
    await executeRun(run.id, 'timeout-worker');
    await unchanged(observed);
    expect(await db.executionRun.count()).toBe(1);
    expect((await execution(run.id)).events.filter(event => event.kind === 'DISPATCHED')).toHaveLength(1);
    expect(await db.evidence.count()).toBe(1);
  });

  it.each(['poweredOff', 'poweredOn'])('does not report success when service verification fails from %s', async initialPower => {
    const id = initialPower === 'poweredOn' ? 'vm-5' : 'vm-1';
    if (initialPower === 'poweredOff') await scenario('VERIFY_FAIL');
    const before = await resource(id);
    const { run } = await queued({ resourceId: id });
    await tick('failed-verifier-worker');
    const result = await execution(run.id);
    expect(result.status).toBe('FAILED');
    expect(result.evidence[0]).toMatchObject({ outcome: 'FAILED', verified: false, postcheck: { verified: false, checks: { poweredOn: true, serviceHealthy: false } } });
    expect(result.events.some(event => ['SUCCEEDED', 'COMPLETED_NOOP'].includes(event.kind))).toBe(false);
    expect(await db.resourceLock.count()).toBe(0);
    if (initialPower === 'poweredOn') {
      expect(result.dispatchPhase).toBe('NOT_DISPATCHED');
      await unchanged(before);
    } else {
      expect(result.dispatchPhase).toBe('DISPATCHED');
      expect((await resource(id)).mutationCount).toBe(before.mutationCount + 1);
    }
  });

  it('operator reconciliation observes a successful target and never repeats the mutation', async () => {
    await scenario('TIMEOUT_AFTER_DISPATCH');
    const { flow, run } = await queued();
    await tick('reconcile-timeout-worker');
    const operator = await login('operator');
    const before = await resource();
    const conflict = await api(operator, 'post', `/api/runs/${run.id}/reconcile`, { outcome: 'CONFIRMED_FAILED', reason: 'Observation is healthy, so this decision must not be accepted' }).expect(422);
    expect(conflict.body.code).toBe('OBSERVATION_CONFLICT');
    expect(await db.resourceLock.count()).toBe(1);
    const reconciled = await api(operator, 'post', `/api/runs/${run.id}/reconcile`, { outcome: 'CONFIRMED_SUCCEEDED', reason: 'Operator independently confirmed guest and service health' }).expect(200);
    expect(reconciled.body.status).toBe('SUCCEEDED');
    expect((await execution(run.id)).evidence.map(evidence => evidence.outcome).sort()).toEqual(['REQUIRES_REVIEW', 'SUCCEEDED']);
    expect(await db.auditEvent.findFirst({ where: { requestId: flow.id, action: 'RECONCILIATION' } })).toMatchObject({ actorId: operator.userId, runId: run.id, details: { outcome: 'CONFIRMED_SUCCEEDED', observation: { verified: true } } });
    expect(await db.resourceLock.count()).toBe(0);
    await api(operator, 'post', `/api/runs/${run.id}/reconcile`, { outcome: 'CONFIRMED_SUCCEEDED', reason: 'Repeated reconciliation must not produce another result' }).expect(409);
    expect(await tick('post-reconciliation-worker')).toBeNull();
    await unchanged(before);
  });

  it('operator cannot label an unpowered target successful and can confirm failure without powering it on', async () => {
    const { run } = await queued();
    const before = await resource();
    await claimRun('lost-before-mutation-worker');
    await db.executionRun.update({ where: { id: run.id }, data: { dispatchPhase: 'DISPATCHING', leaseExpiresAt: new Date(Date.now() - 1000) } });
    await tick('recover-unpowered-worker');
    const operator = await login('operator');
    const invalid = await api(operator, 'post', `/api/runs/${run.id}/reconcile`, { outcome: 'CONFIRMED_SUCCEEDED', reason: 'An unpowered resource cannot satisfy the verifier' }).expect(422);
    expect(invalid.body.code).toBe('VERIFICATION_FAILED');
    expect(await db.resourceLock.count()).toBe(1);
    const failed = await api(operator, 'post', `/api/runs/${run.id}/reconcile`, { outcome: 'CONFIRMED_FAILED', reason: 'Observed powered off with no healthy guest service' }).expect(200);
    expect(failed.body.status).toBe('FAILED');
    expect(await db.resourceLock.count()).toBe(0);
    expect((await execution(run.id)).evidence.some(evidence => evidence.verified)).toBe(false);
    await unchanged(before);
  });

  it('redacts secret fixture messages and nested payloads from detail, run, audit and evidence exports', async () => {
    await scenario('SECRET_LOG');
    const { requester, flow, run } = await queued();
    await tick('secret-fixture-worker');
    const result = await execution(run.id);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.events.some(event => event.kind === 'ADAPTER_LOG')).toBe(true);
    const fixtureSecrets = ['example-secret-token', 'sample-password', 'sample-token', 'fixture-private-key'];
    for (const path of [`/api/requests/${flow.id}`, `/api/runs/${run.id}`, `/api/requests/${flow.id}/evidence`, '/api/audit/export']) {
      const response = await api(requester, 'get', path).expect(200);
      const serialized = JSON.stringify(response.body);
      for (const secret of fixtureSecrets) expect(serialized.includes(secret), `Secret fixture leaked by ${path}`).toBe(false);
      expect(serialized.includes(process.env.DEMO_PASSWORD!), 'Login password leaked').toBe(false);
      expect(serialized.includes(requester.csrf), 'Session CSRF leaked').toBe(false);
      expect(serialized.includes(requester.cookie.split('=')[1]!), 'Session cookie leaked').toBe(false);
      if (path !== '/api/audit/export') expect(serialized.includes('[REDACTED]')).toBe(true);
    }
  });

  it('CONNECTED mode refuses create and queued dispatch rather than falling back to the demo adapter', async () => {
    const { requester, run } = await queued();
    const before = await resource();
    vi.stubEnv('APP_MODE', 'CONNECTED');
    const denied = await api(requester, 'post', '/api/requests', payload()).set('Idempotency-Key', randomUUID()).expect(503);
    expect(denied.body.code).toBe('NOT_CONFIGURED');
    expect(await tick('not-configured-connected-worker')).toBe(run.id);
    await noDispatch(run.id, 'FAILED', before, 'NOT_CONFIGURED');
    expect(await db.request.count()).toBe(1);
    // Pass the unrelated deployment checks to exercise the explicit startup gate.
    vi.stubEnv('DEMO_PASSWORD', undefined);
    vi.stubEnv('APP_ORIGIN', 'https://infraflow.example.test');
    vi.stubEnv('SESSION_SECRET', randomUUID() + randomUUID());
    expect(() => validateConfig()).toThrowError(AppError);
    try {
      validateConfig();
    } catch (error) {
      expect(error).toMatchObject({ status: 503, code: 'NOT_CONFIGURED' });
    }
  });

  it('does not fall back to demo for a catalog VM with an unconfigured adapter', async () => {
    const requester = await login('requester');
    await db.resource.update({ where: { id: 'vm-1' }, data: { adapterId: 'jenkins' } });
    const before = await resource();
    const denied = await api(requester, 'post', '/api/requests', payload()).set('Idempotency-Key', randomUUID()).expect(503);
    expect(denied.body.code).toBe('NOT_CONFIGURED');
    expect(await db.request.count()).toBe(0);
    expect(await tick('unconfigured-adapter-worker')).toBeNull();
    await unchanged(before);
  });

  it('rejects weak session configuration and refuses demo accounts on a production deployment', () => {
    vi.stubEnv('SESSION_SECRET', 'too-short');
    expect(() => validateConfig()).toThrowError(AppError);
    vi.stubEnv('SESSION_SECRET', randomUUID() + randomUUID());
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEMO_PASSWORD', undefined);
    vi.stubEnv('APP_ORIGIN', 'https://infraflow.example.test');
    expect(() => validateConfig()).toThrowError('Mode DEMO tidak diizinkan sebagai deployment production');
  });

  it('database uniqueness prevents duplicate approval, run and resource-lock ownership', async () => {
    const { flow, run } = await queued();
    const approval = await db.approval.findFirstOrThrow({ where: { requestId: flow.id } });
    await expect(db.approval.create({ data: { requestId: flow.id, requestVersion: approval.requestVersion, snapshotHash: approval.snapshotHash, actorId: approval.actorId, decision: 'APPROVE', reason: 'Duplicate approval must fail at the database boundary', expiresAt: approval.expiresAt } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.executionRun.create({ data: { requestId: flow.id } })).rejects.toMatchObject({ code: 'P2002' });
    expect(await claimRun('constraint-worker')).toBe(run.id);
    await expect(db.resourceLock.create({ data: { key: 'resource:vm-1', runId: run.id } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(db.resourceLock.create({ data: { key: 'resource:vm-4', runId: run.id } })).rejects.toMatchObject({ code: 'P2002' });
    expect(await db.approval.count()).toBe(1);
    expect(await db.executionRun.count()).toBe(1);
    expect(await db.resourceLock.count()).toBe(1);
  });
});
