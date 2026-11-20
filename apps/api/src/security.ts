import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Environment, Prisma, Role, RoleAssignment, User } from '@prisma/client';

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function ensure(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
export type Actor = User & { assignments: RoleAssignment[] };
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest) return false;
  const value = Buffer.from(digest, 'hex');
  const candidate = scryptSync(password, salt, 64);
  return value.length === candidate.length && timingSafeEqual(candidate, value);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const sessionHash = (token: string) => createHmac('sha256', process.env.SESSION_SECRET!).update(token).digest('hex');
export function can(actor: Actor, teamId: string, environment: Environment, roles?: Role[]): boolean {
  return actor.active && actor.assignments.some(a => a.teamId === teamId && a.environments.includes(environment) && (!roles || roles.includes(a.role)));
}
export function authorize(actor: Actor, target: {teamId: string; environment: Environment}, roles?: Role[]): void {
  ensure(can(actor, target.teamId, target.environment, roles), 403, 'FORBIDDEN', 'Akses tidak diizinkan untuk peran atau scope Anda');
}
export function scope(actor: Actor, roles?: Role[]) {
  return { OR: actor.active ? actor.assignments.filter(a => !roles || roles.includes(a.role)).map(a => ({ teamId: a.teamId, environment: { in: a.environments } })) : [] };
}
export function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '$1 [REDACTED]')
    .replace(/\b(password|passwd|secret|token|authorization|cookie|session|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]');
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /password|passwd|secret|token|authorization|cookie|private.?key|api.?key/i.test(k) ? '[REDACTED]' : sanitize(v)]));
  return value;
}
export const json = (value: unknown) => JSON.parse(JSON.stringify(sanitize(value))) as Prisma.InputJsonValue;
export function validateConfig() {
  ensure(process.env.APP_MODE === 'DEMO' || process.env.APP_MODE === 'CONNECTED', 500, 'CONFIGURATION', 'APP_MODE wajib DEMO atau CONNECTED');
  ensure((process.env.SESSION_SECRET?.length ?? 0) >= 32 && !process.env.SESSION_SECRET?.startsWith('replace-'), 500, 'CONFIGURATION', 'SESSION_SECRET tidak layak');
  const hostedDemo = process.env.ALLOW_HOSTED_DEMO === 'true';
  ensure(!(process.env.NODE_ENV === 'production' && process.env.APP_MODE === 'DEMO' && !hostedDemo), 503, 'DEMO_PRODUCTION_DENIED', 'Mode DEMO tidak diizinkan sebagai deployment production');
  if (process.env.APP_MODE === 'CONNECTED' || process.env.NODE_ENV === 'production') {
    ensure(!process.env.DEMO_PASSWORD && !process.env.SESSION_SECRET!.includes('demo') && process.env.APP_ORIGIN?.startsWith('https://'), 500, 'CONFIGURATION', 'Deployment production memerlukan HTTPS, secret kuat, dan tanpa credential demo');
  }
  ensure(process.env.APP_MODE !== 'CONNECTED', 503, 'NOT_CONFIGURED', 'Connected adapters belum dikonfigurasi; tidak ada fallback DEMO');
}
