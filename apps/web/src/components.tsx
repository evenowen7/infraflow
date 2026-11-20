import { useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, CircleHelp, FileText, Inbox, Layers3, LoaderCircle, RefreshCw } from 'lucide-react';
import { ApiError } from './api';
import { actionLabel, formatDate, statusLabel, type Page, type RequestItem } from './types';

export function navigate(to: string) { window.history.pushState({}, '', to); window.dispatchEvent(new Event('infraflow:navigate')); }
export function useLocation() {
  const [location, setLocation] = useState(window.location.pathname + window.location.search);
  useEffect(() => {
    const change = () => setLocation(window.location.pathname + window.location.search);
    window.addEventListener('popstate', change); window.addEventListener('infraflow:navigate', change);
    return () => { window.removeEventListener('popstate', change); window.removeEventListener('infraflow:navigate', change); };
  }, []);
  return location;
}
export function Link({ href = '/', onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a href={href} {...props} onClick={event => {
    onClick?.(event);
    if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !props.target && !props.download && href.startsWith('/')) {
      event.preventDefault(); navigate(href);
    }
  }} />;
}
export function Logo({ compact = false }: { compact?: boolean }) {
  return <Link href="/" className="brand" aria-label="InfraFlow, Dashboard"><span className="brand-icon"><Layers3 size={23} strokeWidth={2.2} /></span>{!compact && <span>Infra<span className="brand-light">Flow</span><small>INFRASTRUCTURE OPERATIONS</small></span>}</Link>;
}
export function DemoBadge() { return <span className="demo-badge"><span />DEMO</span>; }
export function StatusBadge({ status }: { status: string }) {
  const positive = ['SUCCEEDED', 'COMPLETED_NOOP', 'APPROVED', 'APPROVE', 'VERIFIED', 'CONFIRMED_SUCCEEDED', 'UP', 'HEALTHY', 'READY', 'CONNECTED', 'SYNCED', 'poweredOn'];
  const negative = ['FAILED', 'REJECTED', 'REJECT', 'CONFIRMED_FAILED'];
  const warn = ['AWAITING_APPROVAL', 'REQUIRES_REVIEW', 'UNKNOWN', 'EXPIRED'];
  const active = ['RUNNING', 'QUEUED', 'SCHEDULED', 'DISPATCHING', 'VERIFYING', 'PENDING'];
  const tone = positive.includes(status) ? 'success' : negative.includes(status) ? 'danger' : warn.includes(status) ? 'warning' : active.includes(status) ? 'info' : 'neutral';
  return <span className={`badge ${tone}`}><span className="badge-dot" />{statusLabel(status)}</span>;
}
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow ?? 'WORKSPACE / INFRASTRUKTUR'}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</div>;
}
export function Panel({ title, description, children, action, className = '' }: { title?: string; description?: string; children: ReactNode; action?: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{title && <div className="panel-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>}{children}</section>;
}
export function Loading({ label = 'Memuat data…' }: { label?: string }) {
  return <div className="state loading-state" role="status"><LoaderCircle className="spin" size={28} /><span>{label}</span></div>;
}
export function ErrorState({ error, retry, compact = false }: { error: Error | string | null; retry?: () => void; compact?: boolean }) {
  if (!error) return null;
  return <div className={`error-state ${compact ? 'compact' : ''}`} role="alert"><AlertCircle size={21} /><div><strong>{error instanceof ApiError && error.status === 403 ? 'Akses tidak diizinkan' : 'Permintaan belum berhasil'}</strong><p>{typeof error === 'string' ? error : error.message}</p>{error instanceof ApiError && error.code && <small>Kode: {error.code}</small>}</div>{retry && <button className="button secondary small" onClick={retry}><RefreshCw size={15} />Coba lagi</button>}</div>;
}
export function Empty({ title = 'Belum ada data', description = 'Data akan tampil di sini ketika tersedia.', action }: { title?: string; description?: string; action?: ReactNode }) {
  return <div className="state empty-state"><span className="empty-icon"><Inbox size={27} /></span><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' | 'success' }) {
  return <div className={`notice ${tone}`}><CircleHelp size={18} /><div>{children}</div></div>;
}
export function Pagination({ data, onPage }: { data: Pick<Page<unknown>, 'total' | 'page' | 'pageSize'>; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return <div className="pagination"><span>{data.total === 0 ? '0 hasil' : `${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)} dari ${data.total} hasil`}</span><div><button type="button" className="icon-button" aria-label="Halaman sebelumnya" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}><ChevronLeft size={18} /></button><span>Halaman {data.page} / {pages}</span><button type="button" className="icon-button" aria-label="Halaman berikutnya" disabled={data.page >= pages} onClick={() => onPage(data.page + 1)}><ChevronRight size={18} /></button></div></div>;
}
export function RequestTable({ items, approval = false }: { items: RequestItem[]; approval?: boolean }) {
  if (!items.length) return <Empty title={approval ? 'Tidak ada persetujuan tertunda' : 'Belum ada request'} description={approval ? 'Request yang membutuhkan tinjauan Anda akan tampil di sini.' : 'Mulai dengan memilih layanan Nyalakan VM dari katalog.'} action={!approval && <Link className="button secondary" href="/services">Lihat layanan<ArrowRight size={16} /></Link>} />;
  return <div className="table-scroll"><table><thead><tr><th>Request / layanan</th><th>Resource</th><th>Pemohon</th><th>Status</th><th>Dibuat</th><th><span className="sr-only">Detail</span></th></tr></thead><tbody>{items.map(item => <tr key={item.id}>
    <td><Link className="cell-title" href={`/requests/${encodeURIComponent(item.id)}`}>{actionLabel(item.action)}</Link><span className="cell-sub mono">{item.id.slice(0, 12)}</span></td>
    <td><span className="cell-title">{item.resource?.name ?? item.resourceId ?? (typeof item.parameters.name === 'string' ? `${item.parameters.name} · menunggu provisioning` : 'Menunggu provisioning')}</span><span className="cell-sub">{item.environment} · {item.teamId}</span></td>
    <td><span>{item.requester?.name ?? 'Pemohon'}</span><span className="cell-sub">{item.requester?.email ?? item.requesterId}</span></td>
    <td><StatusBadge status={item.status} /></td><td className="nowrap muted">{formatDate(item.createdAt)}</td>
    <td><Link className="table-link" href={`/requests/${encodeURIComponent(item.id)}`} aria-label={`${approval ? 'Tinjau' : 'Detail'} request ${item.id}`}>{approval ? 'Tinjau' : 'Detail'}<ArrowRight size={15} /></Link></td>
  </tr>)}</tbody></table></div>;
}
export function Field({ label, children, hint, required = false, htmlFor }: { label: string; children: ReactNode; hint?: string; required?: boolean; htmlFor: string }) {
  return <div className="field"><label htmlFor={htmlFor}>{label}{required && <span className="required"> *</span>}</label>{children}{hint && <small id={`${htmlFor}-hint`}>{hint}</small>}</div>;
}
export function KeyValue({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return <div className="key-value"><dt>{label}</dt><dd className={mono ? 'mono break-word' : ''}>{children ?? '—'}</dd></div>;
}
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[Kedalaman dibatasi]';
  if (typeof value === 'string') return Array.from(value.slice(0, 12000)).filter(char => {
    const code = char.charCodeAt(0);
    return code >= 32 || code === 9 || code === 10 || code === 13;
  }).join('').replace(/(password|secret|token|authorization|credential)\s*[:=]\s*[^\s,;]+/gi, '$1=[DISAMARKAN]').replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [DISAMARKAN]');
  if (Array.isArray(value)) return value.slice(0, 250).map(v => sanitize(v, depth + 1));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, /password|secret|token|authorization|cookie|credential|private.?key/i.test(key) ? '[DISAMARKAN]' : sanitize(item, depth + 1)]));
  return value;
}
export function JsonBlock({ value, label = 'Data JSON', open = false }: { value: unknown; label?: string; open?: boolean }) {
  return <details className="json-details" open={open || undefined}><summary><FileText size={15} />{label}</summary><pre>{JSON.stringify(sanitize(value), null, 2) ?? 'Tidak ada data'}</pre></details>;
}
export function BackLink({ href = '/requests', children = 'Kembali ke requests' }: { href?: string; children?: ReactNode }) {
  return <Link className="back-link" href={href}><ArrowLeft size={16} />{children}</Link>;
}
export function StepIndicator({ step, firstLabel = 'Pilih resource' }: { step: number; firstLabel?: string }) {
  return <ol className="steps">{[firstLabel, 'Detail & jadwal', 'Tinjau request'].map((label, i) => <li key={label} className={i + 1 === step ? 'current' : i + 1 < step ? 'complete' : ''} aria-current={i + 1 === step ? 'step' : undefined}><span>{i + 1 < step ? <Check size={16} /> : `0${i + 1}`}</span><strong>{label}</strong></li>)}</ol>;
}
