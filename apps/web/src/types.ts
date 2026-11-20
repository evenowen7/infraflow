export type Environment = 'DEV' | 'TEST' | 'PRODUCTION';
export type Action = 'POWER_ON_VM' | 'RESTART_VM' | 'CREATE_VM';
export const SUPPORTED_ACTIONS: readonly string[] = ['POWER_ON_VM', 'RESTART_VM', 'CREATE_VM'];
export interface CreateVmInput {
  name: string; templateId: string; sizeId: string; networkId: string;
  teamId: string; owner: string; environment: string;
}
export interface Assignment { role: string; teamId: string; environments: Environment[] }
export interface User { id: string; name: string; email: string; assignments: Assignment[] }
export interface Session { user: User; csrfToken: string; mode: string }
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number; mode: string }
export interface Resource {
  id: string; name: string; externalId: string; adapterId: string; teamId: string;
  owner: string; environment: Environment; cpu: number; ramGb: number; diskGb: number;
  networkId: string; powerState: 'poweredOn' | 'poweredOff'; guestState: string;
  bootMarker: string | null; serviceHealthy: boolean | null; guestRebootSupported: boolean;
  observedAt: string | null; scenario?: string;
}
export interface AuditItem {
  id: string; action: string; actorId: string | null; requestId: string | null;
  runId: string | null; correlationId: string | null; details: unknown; createdAt: string;
}
export interface Evidence {
  id: string; mode: string; precheck: unknown; postcheck: unknown;
  verified: boolean; outcome: string; createdAt: string;
}
export interface Run {
  id: string; status: string; dispatchPhase: string; externalOperationId: string | null;
  startedAt: string | null; finishedAt: string | null;
  events: { id: string; kind: string; message: string; createdAt: string; payload: unknown }[];
  evidence: Evidence[];
}
export interface RequestItem {
  id: string; action: Action; resourceId: string | null; teamId: string; environment: Environment; reason: string;
  parameters: Record<string, unknown>; scheduledAt: string | null; status: string;
  version: number; snapshotHash: string | null; snapshot?: unknown; precheck?: unknown; correlationId: string;
  createdAt: string; updatedAt: string; requesterId: string; resource?: Resource | null;
  requester?: { id: string; name: string; email: string };
  ticket?: { id: string; externalId: string; syncStatus: string } | null;
}
export interface RequestDetail extends RequestItem {
  approvals: { decision: string; reason: string; createdAt: string; expiresAt: string | null; actor: { name: string; email: string } }[];
  runs: Run[]; audit: AuditItem[];
}
export interface Catalog {
  services: { action: string; name: string; description: string; enabled: boolean }[];
  templates: { id: string; name: string; os: string }[];
  sizes: { id: string; name: string; cpu: number; ramGb: number; diskGb: number }[];
  networks: { id: string; name: string; cidr: string; teamId: string }[]; mode: string;
}
export interface DashboardData {
  counts: Record<string, number>; total: number; resources: number;
  averageDurationSeconds: number | null; recentRequests: RequestItem[]; mode: string;
}
export interface SettingsData {
  mode: string; integrations: { id: string; name: string; status: string; description: string }[];
  policy: { productionAllowed: boolean; approvalTtlMinutes: number; timezone: string };
  health: { database: string };
}
export interface Ticket {
  id: string; createdAt: string; provider: string; externalId: string; revision: string;
  teamId: string; environment: Environment; approvalSource: string;
  syncStatus: 'PENDING' | 'SYNCED' | 'FAILED'; syncAttempts: number;
  simulateSyncFailure: boolean; result: unknown;
  request: { id: string; status: string } | null;
}
export interface TicketDetail extends Ticket {
  mode: string;
  events: { id: string; eventId: string; provider: string; revision: string; payloadHash: string; createdAt: string }[];
  outbox: { id: string; status: string; attempts: number; payload: unknown; lastError: string | null; createdAt: string; availableAt: string }[];
}
export interface DemoTicketInput {
  provider: 'DEMO_DESK'; eventId: string; externalTicketId: string; revision: string;
  requesterEmail: string; action: 'POWER_ON_VM'; targetExternalId: string;
  reason: string; approvalSource: 'PORTAL';
}
export interface DemoTicketResult { requestId: string; ticketId: string; replayed: boolean; mode: string }

export const ACTIVE_STATUSES = new Set(['AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'QUEUED', 'RUNNING', 'VERIFYING']);
export const REVIEW_STATUSES = new Set(['REQUIRES_REVIEW']);
export const APPROVAL_STATUSES = new Set(['AWAITING_APPROVAL']);
export const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draf', AWAITING_APPROVAL: 'Menunggu persetujuan', APPROVED: 'Disetujui', REJECTED: 'Ditolak',
  SCHEDULED: 'Terjadwal', QUEUED: 'Dalam antrean', RUNNING: 'Sedang berjalan',
  DISPATCHING: 'Mengirim operasi', VERIFYING: 'Memverifikasi',
  SUCCEEDED: 'Berhasil', FAILED: 'Gagal', CANCELLED: 'Dibatalkan', EXPIRED: 'Kedaluwarsa',
  REQUIRES_REVIEW: 'Perlu tinjauan', COMPLETED_NOOP: 'Selesai tanpa perubahan', VERIFIED: 'Terverifikasi',
  NOT_CONFIGURED: 'Belum dikonfigurasi', SYNCED: 'Tersinkron', PENDING: 'Menunggu sinkronisasi',
  NOT_DISPATCHED: 'Belum dikirim', DISPATCHED: 'Operasi terkirim',
  CONFIRMED_SUCCEEDED: 'Dikonfirmasi berhasil', CONFIRMED_FAILED: 'Dikonfirmasi gagal',
  APPROVE: 'Disetujui', REJECT: 'Ditolak', OPEN: 'Terbuka', IN_PROGRESS: 'Ditangani',
  RESOLVED: 'Terselesaikan', CLOSED: 'Ditutup', UP: 'Terhubung', HEALTHY: 'Sehat',
  CONNECTED: 'Terhubung', READY: 'Siap', DEMO: 'Demo', UNKNOWN: 'Belum diketahui',
  poweredOn: 'Menyala', poweredOff: 'Mati', SUPERSEDED: 'Digantikan hasil terbaru',
};
export const ACTION_LABELS: Record<string, string> = {
  POWER_ON_VM: 'Nyalakan VM', RESTART_VM: 'Restart VM', CREATE_VM: 'Buat VM',
  RESIZE_VM: 'Ubah kapasitas VM', CREATE_CLUSTER: 'Buat cluster',
};
export const actionLabel = (action: string) => ACTION_LABELS[action] ?? action.replaceAll('_', ' ');
export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status.replaceAll('_', ' ');
export function hasRole(user: User, role: string, scope?: { teamId: string; environment: string }) {
  return user.assignments.some(a => a.role === role && (!scope ||
    (a.teamId === scope.teamId && a.environments.some(environment => environment === scope.environment))));
}
export const isProduction = (environment: string) => ['prod', 'production'].includes(environment.toLowerCase());
export const isStale = (observedAt: string | null) => !observedAt || !Number.isFinite(Date.parse(observedAt)) || Date.now() - Date.parse(observedAt) > 300_000;
export function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta',
  }).format(date) + ' WIB';
}
export function toJakartaInput(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Date(Date.parse(value) + 7 * 60 * 60 * 1000).toISOString().slice(0, 16);
}
export function jakartaToUTC(value: string) {
  if (!value) return null;
  // datetime-local is explicitly interpreted as Jakarta, never the browser timezone.
  const date = new Date(`${value}:00+07:00`);
  if (!Number.isFinite(date.getTime())) throw new Error('Tanggal dan waktu jadwal tidak valid.');
  return date.toISOString();
}
