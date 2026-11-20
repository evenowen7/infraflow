import { useState } from 'react';
import { Activity, ArrowRight, Boxes, CheckCheck, Clock3, FileClock, FileText, GitBranch, HardDrive, LockKeyhole, Plus, Power, RefreshCw, RotateCw, Server, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { mutate, useApi, useAuth, useMutation } from './api';
import { BackLink, Empty, ErrorState, Field, JsonBlock, KeyValue, Link, Loading, Notice, PageHeader, Pagination, Panel, RequestTable, StatusBadge } from './components';
import { ACTIVE_STATUSES, SUPPORTED_ACTIONS, actionLabel, formatDate, hasRole, isProduction, statusLabel, type AuditItem, type Catalog, type DashboardData, type DemoTicketInput, type DemoTicketResult, type Page, type RequestItem, type Resource, type SettingsData, type Ticket, type TicketDetail } from './types';

export function Dashboard() {
  const { session } = useAuth();
  const { data, error, loading, reload } = useApi<DashboardData>('/api/dashboard');
  const pending = data?.counts.AWAITING_APPROVAL ?? 0;
  const success = (data?.counts.SUCCEEDED ?? 0) + (data?.counts.COMPLETED_NOOP ?? 0);
  return <>
    <PageHeader eyebrow="WORKSPACE / OVERVIEW" title={`Selamat datang, ${session?.user.name.split(' ')[0] ?? 'Anda'}`} description="Satu tempat untuk mengelola request dan operasional infrastruktur Anda." actions={<Link href="/requests/new" className="button primary"><Plus size={17} />Buat request</Link>} />
    <div className="demo-banner"><div className="banner-icon"><ShieldCheck size={24} /></div><div><strong>Ruang kerja demo. Alur operasional yang sesungguhnya.</strong><p>Setiap request melalui persetujuan, pemeriksaan awal, dan verifikasi hasil. Tidak terhubung ke infrastruktur produksi.</p></div><Link href="/settings">Lihat konfigurasi<ArrowRight size={16} /></Link></div>
    {loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : data && <>
      <div className="stat-grid">
        {[{ label: 'Total request', value: data.total, icon: FileText, note: 'Dalam cakupan akses Anda', color: 'teal' }, { label: 'Menunggu persetujuan', value: pending, icon: Clock3, note: 'Menunggu tinjauan approver', color: 'amber' }, { label: 'Request berhasil', value: success, icon: CheckCheck, note: 'Status akhir dari server', color: 'green' }, { label: 'Resource VM', value: data.resources, icon: Server, note: 'Resource yang dapat diakses', color: 'blue' }, { label: 'Request berjalan', value: (data.counts.RUNNING ?? 0) + (data.counts.VERIFYING ?? 0), icon: Activity, note: 'Menjalankan operasi / verifikasi', color: 'blue' }, { label: 'Request gagal', value: data.counts.FAILED ?? 0, icon: FileClock, note: 'Status gagal dari database', color: 'amber' }].map(stat => <div className="stat-card" key={stat.label}><div className="stat-top"><span>{stat.label}</span><span className={`stat-icon ${stat.color}`}><stat.icon size={19} /></span></div><div className="stat-value">{stat.value.toLocaleString('id-ID')}</div><div className="stat-note">{stat.note}</div></div>)}
      </div>
      <div className="dashboard-columns">
        <Panel title="Aktivitas request" description="Distribusi status request saat ini" action={<Activity size={18} className="muted" />}>
          <div className="status-overview"><div className="status-total"><strong>{data.total}</strong><span>Total request</span></div><div className="status-bars">{Object.entries(data.counts).filter(([, count]) => count > 0).length ? Object.entries(data.counts).filter(([, count]) => count > 0).map(([status, count]) => <div className="status-bar-row" key={status}><div><span>{statusLabel(status)}</span><strong>{count}</strong></div><div className="bar-track"><span style={{ width: `${data.total ? (count / data.total) * 100 : 0}%` }} /></div></div>) : <p className="muted">Belum ada aktivitas request.</p>}</div></div>
          <div className="panel-footer"><Clock3 size={15} /><span>Rata-rata durasi eksekusi</span><strong>{data.averageDurationSeconds === null ? 'Belum tersedia' : `${Math.round(data.averageDurationSeconds)} detik`}</strong></div>
        </Panel>
        <Panel className="quick-service" title="Layanan siap digunakan" description="Mulai dari kebutuhan infrastruktur Anda">
          <div className="featured-service"><span className="service-symbol"><Power size={26} /></span><div><h3>Nyalakan VM</h3><p>Nyalakan mesin virtual dengan alur persetujuan dan hasil terverifikasi.</p></div></div>
          <div className="flow-mini"><span>Request</span><ArrowRight size={14} /><span>Approval</span><ArrowRight size={14} /><span>Verifikasi</span></div>
          <Link href="/requests/new" className="button secondary full-width">Buat request power-on<ArrowRight size={16} /></Link>
          <Link className="subtle-link" href="/services">Jelajahi katalog layanan<ArrowRight size={14} /></Link>
        </Panel>
      </div>
      <Panel title="Request terbaru" description="Pantau progres dan hasil operasional Anda" action={<Link className="table-link" href="/requests">Lihat semua<ArrowRight size={15} /></Link>}><RequestTable items={data.recentRequests} /></Panel>
    </>}
  </>;
}

const serviceInfo: Record<string, { category: string; icon: typeof Power }> = {
  POWER_ON_VM: { category: 'OPERASIONAL VM', icon: Power }, RESTART_VM: { category: 'OPERASIONAL VM', icon: RotateCw },
  CREATE_VM: { category: 'PROVISIONING', icon: Server }, RESIZE_VM: { category: 'KAPASITAS', icon: SlidersHorizontal }, CREATE_CLUSTER: { category: 'ORKESTRASI', icon: Boxes },
};
export function Services() {
  const { data, error, loading, reload } = useApi<Catalog>('/api/catalog');
  // Roadmap descriptions are product copy, not simulated API results or executable actions.
  const roadmap = [
    { action: 'RESTART_VM', name: 'Restart VM', description: 'Restart guest dengan verifikasi boot marker. Direncanakan, belum tersedia.', enabled: false },
    { action: 'CREATE_VM', name: 'Buat VM', description: 'Provisioning mesin virtual dari template terstandar. Direncanakan, belum tersedia.', enabled: false },
    { action: 'RESIZE_VM', name: 'Ubah kapasitas VM', description: 'Penyesuaian kapasitas komputasi sesuai kebutuhan. Direncanakan, belum tersedia.', enabled: false },
    { action: 'CREATE_CLUSTER', name: 'Buat cluster', description: 'Provisioning cluster melalui kebijakan terpusat. Direncanakan, belum tersedia.', enabled: false },
  ];
  const services = data ? [...data.services, ...roadmap.filter(item => !data.services.some(service => service.action === item.action))] : [];
  return <><PageHeader title="Katalog layanan" description="Layanan infrastruktur yang terstandar, aman, dan dapat ditelusuri." /><Notice>Ketersediaan layanan mengikuti katalog server. Power-on, graceful restart, dan provisioning VM memerlukan persetujuan serta verifikasi. Resize dan cluster masih roadmap, belum dapat dieksekusi.</Notice>
    {loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : data && <>
      <div className="section-caption"><h2>Semua layanan <span>{services.length}</span></h2><span><ShieldCheck size={15} />Berbasis kebijakan & persetujuan</span></div>
      <div className="service-grid">{services.map(service => {
        const info = serviceInfo[service.action] ?? { category: 'INFRASTRUKTUR', icon: HardDrive };
        const enabled = service.enabled && SUPPORTED_ACTIONS.includes(service.action);
        return <article className={`service-card ${enabled ? 'enabled' : 'unavailable'}`} key={service.action}><div className="service-top"><span className="service-symbol"><info.icon size={25} /></span><span className={`badge ${enabled ? 'success' : 'neutral'}`}>{enabled ? 'Tersedia' : 'Roadmap · Belum tersedia'}</span></div><div className="eyebrow">{info.category}</div><h2>{actionLabel(service.action)}</h2><p>{service.description}</p><div className="service-bottom"><span><ShieldCheck size={15} />{enabled ? 'Memerlukan persetujuan' : 'Belum dapat dijalankan'}</span>{enabled ? <Link className="button primary small" href={service.action === 'POWER_ON_VM' ? '/requests/new' : `/requests/new?action=${encodeURIComponent(service.action)}`}>Buat request<ArrowRight size={15} /></Link> : <button className="button secondary small" disabled><LockKeyhole size={14} />Segera hadir</button>}</div></article>;
      })}</div>
      {!data.services.length && <Empty title="Katalog belum tersedia" description="Belum ada layanan yang dipublikasikan oleh server." />}
    </>}
  </>;
}

export function Requests({ approval = false }: { approval?: boolean }) {
  const [status, setStatus] = useState(''); const [action, setAction] = useState(''); const [page, setPage] = useState(1);
  const query = new URLSearchParams({ ...(status ? { status } : {}), ...(action ? { action } : {}), page: String(page) });
  const { data, loading, error, reload } = useApi<Page<RequestItem>>(`${approval ? '/api/approvals' : '/api/requests'}?${query}`);
  return <><PageHeader title={approval ? 'Approval' : 'Requests'} description={approval ? 'Tinjau snapshot, dampak, dan pemeriksaan awal sebelum mengambil keputusan.' : 'Kelola permintaan infrastruktur dari draf hingga hasil terverifikasi.'} actions={approval ? <span className="heading-note"><ShieldCheck size={17} />Pemisahan tugas aktif</span> : <Link href="/requests/new" className="button primary"><Plus size={17} />Buat request</Link>} />
    {approval && <Notice>Anda tidak dapat menyetujui request sendiri. Keputusan hanya tersedia bagi approver dalam cakupan tim dan environment yang sesuai.</Notice>}
    <Panel><div className="filters"><div className="filter-fields">{!approval && <Field htmlFor="request-status" label="Status"><select id="request-status" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="">Semua status</option>{['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'QUEUED', 'RUNNING', 'VERIFYING', 'SUCCEEDED', 'COMPLETED_NOOP', 'FAILED', 'REQUIRES_REVIEW', 'REJECTED', 'CANCELLED', 'EXPIRED'].map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></Field>}<Field htmlFor="request-action" label="Layanan"><select id="request-action" value={action} onChange={e => { setAction(e.target.value); setPage(1); }}><option value="">Semua layanan</option>{SUPPORTED_ACTIONS.map(action => <option key={action} value={action}>{actionLabel(action)}</option>)}</select></Field></div><button className="button secondary small" onClick={reload} disabled={loading}><RefreshCw size={15} />Muat ulang</button></div>
      {loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : data && <><RequestTable items={data.items} approval={approval} /><Pagination data={data} onPage={setPage} /></>}
    </Panel>
  </>;
}

export function Audit() {
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useApi<Page<AuditItem>>(`/api/audit?page=${page}`);
  return <><PageHeader title="Audit trail" description="Jejak aktivitas yang transparan untuk setiap perubahan dan keputusan." actions={<button className="button secondary" onClick={reload} disabled={loading}><RefreshCw size={16} />Muat ulang</button>} /><Notice>Catatan ditampilkan sesuai cakupan akses akun Anda. Semua waktu menggunakan Asia/Jakarta (WIB).</Notice><Panel title="Log aktivitas" description="Identitas, korelasi, dan detail peristiwa dari server">{loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : data && <>{data.items.length ? <div className="table-scroll"><table><thead><tr><th>Waktu / ID</th><th>Aktivitas</th><th>Aktor</th><th>Referensi</th><th>Detail</th></tr></thead><tbody>{data.items.map(item => <tr key={item.id}><td className="nowrap">{formatDate(item.createdAt)}<span className="cell-sub mono">{item.id.slice(0, 12)}</span></td><td><span className="audit-action"><FileClock size={16} />{item.action.replaceAll('_', ' ')}</span></td><td className="mono">{item.actorId ?? 'Sistem'}</td><td>{item.requestId ? <Link className="table-link" href={`/requests/${encodeURIComponent(item.requestId)}`}>Request {item.requestId.slice(0, 10)}<ArrowRight size={13} /></Link> : '—'}<span className="cell-sub mono">Korelasi: {item.correlationId ?? '—'}</span>{item.runId && <span className="cell-sub mono">Run: {item.runId}</span>}</td><td><JsonBlock value={item.details} label="Lihat detail" /></td></tr>)}</tbody></table></div> : <Empty title="Belum ada catatan audit" description="Aktivitas dan perubahan akan tercatat di sini secara otomatis." />}<Pagination data={data} onPage={setPage} /></>}</Panel></>;
}

export function Tickets() {
  const [page, setPage] = useState(1); const { session } = useAuth();
  const { data, error, loading, reload } = useApi<Page<Ticket>>(`/api/tickets?page=${page}`);
  const canImport = session?.mode === 'DEMO' && (hasRole(session.user, 'OPERATOR') || hasRole(session.user, 'PLATFORM_ADMIN'));
  return <>
    <PageHeader title="Service Desk" description="Pantau tiket tindak lanjut yang terkait dengan operasional infrastruktur." actions={<button className="button secondary" disabled={loading} onClick={reload}><RefreshCw size={16} />Muat ulang</button>} />
    <Notice><strong>DEMO_DESK · simulator, bukan integrasi ITSM nyata.</strong> Simulator MVP hanya mendukung Nyalakan VM (POWER_ON_VM). Approval tetap dilakukan di portal; status infrastruktur dan sinkronisasi tiket dicatat terpisah.</Notice>
    {canImport && <TicketSimulator onDone={reload} />}
    <Panel title="Tiket layanan" description="Tiket yang tersedia dalam cakupan akses Anda">
      {loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : data && <>
        {data.items.length ? <div className="table-scroll"><table><thead><tr><th>Tiket</th><th>Sinkronisasi tiket</th><th>Provider / approval</th><th>Request / infrastruktur</th><th>Dibuat</th></tr></thead><tbody>
          {data.items.map(item => <tr key={item.id}>
            <td><Link className="cell-title" href={`/tickets/${encodeURIComponent(item.id)}`}>{item.externalId}</Link><span className="cell-sub mono">{item.id}</span></td>
            <td><StatusBadge status={item.syncStatus} /><span className="cell-sub">{item.syncAttempts} percobaan sinkronisasi</span>{item.simulateSyncFailure && <span className="cell-sub">Simulasi gagal sinkronisasi aktif</span>}</td>
            <td>{item.provider}<span className="cell-sub">Revisi {item.revision} · Approval {item.approvalSource}</span></td>
            <td>{item.request ? <><Link className="table-link" href={`/requests/${encodeURIComponent(item.request.id)}`}>{item.request.id.slice(0, 12)}<ArrowRight size={14} /></Link><span className="cell-sub"><StatusBadge status={item.request.status} /></span></> : 'Belum ada request'}</td>
            <td className="nowrap">{formatDate(item.createdAt)}</td>
          </tr>)}
        </tbody></table></div> : <Empty title="Tidak ada tiket layanan" description="Tiket tindak lanjut dari operasional Anda akan muncul di sini. Tidak ada tindakan yang diperlukan saat ini." />}
        <Pagination data={data} onPage={setPage} />
      </>}
    </Panel>
  </>;
}

function TicketSimulator({ onDone }: { onDone: () => void }) {
  const { session } = useAuth(); const mutation = useMutation();
  const [eventId, setEventId] = useState<string>(() => crypto.randomUUID());
  const [externalTicketId, setExternalTicketId] = useState(() => `DEMO-${crypto.randomUUID()}`);
  const [revision, setRevision] = useState('1'); const [requesterEmail, setRequesterEmail] = useState('requester@demo.infraflow.test');
  const [reason, setReason] = useState(''); const [target, setTarget] = useState<Resource | null>(null);
  const [search, setSearch] = useState(''); const [q, setQ] = useState(''); const [page, setPage] = useState(1);
  const [sent, setSent] = useState<DemoTicketInput | null>(null); const [result, setResult] = useState<DemoTicketResult | null>(null);
  const catalog = useApi<Catalog>('/api/catalog');
  const resources = useApi<Page<Resource>>(`/api/resources?${new URLSearchParams({ q, page: String(page) })}`);
  const allowed = (resource: Resource) => !isProduction(resource.environment) && resource.adapterId === 'demo' && session && (hasRole(session.user, 'OPERATOR', resource) || hasRole(session.user, 'PLATFORM_ADMIN', resource));
  const available = catalog.data?.services.some(service => service.action === 'POWER_ON_VM' && service.enabled);
  function send(replay = false) {
    if (!replay && (!target || !allowed(target) || !available)) return;
    const payload: DemoTicketInput | null = replay ? sent : { provider: 'DEMO_DESK', eventId, externalTicketId, revision, requesterEmail, action: 'POWER_ON_VM', targetExternalId: target!.externalId, reason, approvalSource: 'PORTAL' };
    if (!payload) return;
    // Replay uses this immutable payload, never current field values or a regenerated event key.
    void mutation.run(async () => {
      if (!replay) setSent(payload);
      setResult(null);
      return mutate<DemoTicketResult>('/api/tickets/demo', payload);
    }, response => { setResult(response); onDone(); });
  }
  return <Panel className="ticket-simulator" title="Simulator impor tiket demo" description="Hanya operator / platform admin; tanda tangan dibuat oleh server"><form className="panel-body stack" onSubmit={e => { e.preventDefault(); send(); }}>
    <div className="fact-grid form-grid"><Field label="Event ID" htmlFor="ticket-event-id" required><input id="ticket-event-id" value={eventId} onChange={e => setEventId(e.target.value)} maxLength={100} required disabled={mutation.busy} /></Field><Field label="External ticket ID" htmlFor="ticket-external-id" required><input id="ticket-external-id" value={externalTicketId} onChange={e => setExternalTicketId(e.target.value)} maxLength={100} required disabled={mutation.busy} /></Field><Field label="Revisi" htmlFor="ticket-revision" required><input id="ticket-revision" value={revision} onChange={e => setRevision(e.target.value)} maxLength={30} required disabled={mutation.busy} /></Field><Field label="Email requester" htmlFor="ticket-requester" required hint="Requester harus memiliki cakupan target; backend memverifikasi penugasannya."><input id="ticket-requester" type="email" value={requesterEmail} onChange={e => setRequesterEmail(e.target.value)} required disabled={mutation.busy} /></Field></div>
    <div className="button-row"><Field label="Cari target VM" htmlFor="ticket-resource-search"><input id="ticket-resource-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Nama atau external ID" /></Field><button type="button" className="button secondary" disabled={mutation.busy} onClick={() => { setQ(search.trim()); setPage(1); }}>Cari target</button></div>
    {resources.loading ? <Loading /> : resources.error ? <ErrorState error={resources.error} retry={resources.reload} /> : resources.data && <><Field label="Target VM (external ID)" htmlFor="ticket-target" required><select id="ticket-target" value={target?.externalId ?? ''} required disabled={mutation.busy} onChange={e => setTarget(resources.data?.items.find(resource => resource.externalId === e.target.value) ?? null)}><option value="">Pilih target dari inventaris</option>{target && !resources.data.items.some(resource => resource.id === target.id) && <option value={target.externalId}>{target.name} · {target.externalId}</option>}{resources.data.items.map(resource => <option key={resource.id} value={resource.externalId} disabled={!allowed(resource)}>{resource.name} · {resource.externalId} · {resource.environment} · {statusLabel(resource.powerState)}{!allowed(resource) ? ' · Tidak diizinkan' : ''}</option>)}</select></Field><Pagination data={resources.data} onPage={setPage} /></>}
    <Notice>Target yang sudah menyala tetap valid dan dapat menghasilkan no-op. Untuk menguji kegagalan verifikasi power-on, pilih VM yang mati dan atur skenarionya di detail resource. Tidak ada reset daya dari simulator.</Notice>
    <Field label="Alasan operasional tiket" htmlFor="ticket-reason" required hint="Minimal 10 karakter, maksimal 1.000 karakter."><textarea id="ticket-reason" value={reason} onChange={e => setReason(e.target.value)} minLength={10} maxLength={1000} rows={3} required disabled={mutation.busy} /></Field>
    <ErrorState error={catalog.error} retry={catalog.reload} compact />{!catalog.loading && !catalog.error && !available && <Notice tone="warning">Nyalakan VM belum diaktifkan dalam katalog server. Impor baru tidak tersedia.</Notice>}
    <ErrorState error={mutation.error} compact /><div className="button-row"><button className="button primary" type="submit" disabled={mutation.busy || !target || !available || reason.trim().length < 10}>Kirim event demo</button><button className="button secondary" type="button" disabled={mutation.busy || !sent} onClick={() => send(true)}><RefreshCw size={16} />Replay event yang sama</button><button className="button secondary" type="button" disabled={mutation.busy} onClick={() => { setEventId(crypto.randomUUID()); setExternalTicketId(`DEMO-${crypto.randomUUID()}`); setRevision('1'); setSent(null); setResult(null); mutation.clearError(); }}>Event demo baru</button></div>
    {sent && <><Notice>Event ID dan payload terakhir disimpan di halaman ini. Replay mengirim payload yang persis sama, termasuk jika kolom di atas diubah. ID tidak diganti otomatis setelah pengiriman; payload berbeda dengan event key sama akan ditolak server.</Notice><JsonBlock label="Payload terakhir · dipakai untuk replay" value={sent} /></>}
    {result && <div role="status" className="stack"><Notice tone="success">{result.replayed ? 'Replay terdeteksi: request dan tiket yang sama dikembalikan, tanpa membuat operasi baru.' : 'Event diterima oleh server. Approval tetap di portal.'} Mode {result.mode}.</Notice><div className="button-row"><Link className="table-link" href={`/requests/${encodeURIComponent(result.requestId)}`}>Buka request {result.requestId.slice(0, 12)}<ArrowRight size={14} /></Link><Link className="table-link" href={`/tickets/${encodeURIComponent(result.ticketId)}`}>Buka tiket {result.ticketId.slice(0, 12)}<ArrowRight size={14} /></Link></div></div>}
  </form></Panel>;
}

export function TicketDetails({ id }: { id: string }) {
  const { data, loading, error, reload } = useApi<TicketDetail>(`/api/tickets/${encodeURIComponent(id)}`, ticket => Boolean(ticket.request && ACTIVE_STATUSES.has(ticket.request.status)) || ticket.outbox.some(event => event.status === 'PENDING'));
  return <><BackLink href="/tickets">Kembali ke Service Desk</BackLink><PageHeader title={data?.externalId ?? 'Detail tiket'} description="DEMO_DESK · simulator, bukan integrasi ITSM nyata." actions={<button className="button secondary" onClick={reload} disabled={loading}><RefreshCw size={16} />Muat ulang</button>} />
    {loading ? <Loading /> : error && !data ? <ErrorState error={error} retry={reload} /> : data && <><ErrorState error={error} retry={reload} compact /><div className="detail-grid"><div className="stack"><Panel title="Status tiket & infrastruktur"><div className="panel-body stack"><dl className="fact-grid"><KeyValue label="Status infrastruktur">{data.request ? <><StatusBadge status={data.request.status} /><Link className="table-link" href={`/requests/${encodeURIComponent(data.request.id)}`}>Buka request<ArrowRight size={14} /></Link></> : 'Belum ada request'}</KeyValue><KeyValue label="Sinkronisasi tiket"><StatusBadge status={data.syncStatus} /></KeyValue><KeyValue label="Percobaan sinkronisasi">{data.syncAttempts}</KeyValue><KeyValue label="Sumber approval">{data.approvalSource} · persetujuan lokal</KeyValue><KeyValue label="Provider / revisi">{data.provider} / {data.revision}</KeyValue><KeyValue label="Tim / environment">{data.teamId} / {data.environment}</KeyValue><KeyValue label="Dibuat">{formatDate(data.createdAt)}</KeyValue><KeyValue label="Ticket ID" mono>{data.id}</KeyValue></dl><Notice tone={data.syncStatus === 'FAILED' ? 'warning' : 'info'}>Hasil infrastruktur terpisah dari sinkronisasi tiket. {data.syncStatus === 'FAILED' ? 'Sinkronisasi gagal tidak berarti operasi VM gagal. ' : ''}Retry hanya mengirim ulang hasil melalui outbox, tidak mengeksekusi ulang infrastruktur.</Notice><JsonBlock label="Hasil yang dikirim ke tiket" value={data.result} open /></div></Panel>
      <Panel title="Event masuk (inbox)">{data.events.length ? <div className="panel-body stack">{data.events.map(event => <JsonBlock key={event.id} label={`${event.eventId} · revisi ${event.revision} · ${formatDate(event.createdAt)}`} value={event} />)}</div> : <Empty title="Belum ada event masuk" />}</Panel>
      <Panel title="Pengiriman hasil (outbox)">{data.outbox.length ? <div className="panel-body stack">{data.outbox.map(event => <div className="evidence-card" key={event.id}><div className="evidence-heading"><StatusBadge status={event.status} /><span>{event.attempts} percobaan</span></div><p className="muted">{formatDate(event.createdAt)}</p>{event.lastError && <Notice tone="warning">{event.lastError}</Notice>}<JsonBlock label="Outbox · payload & pengiriman" value={event} /></div>)}</div> : <Empty title="Belum ada pengiriman hasil" description="Outbox tersedia setelah ada hasil infrastruktur yang perlu disinkronkan." />}</Panel></div><aside className="stack"><TicketControls key={`${data.id}-${data.simulateSyncFailure}`} ticket={data} onDone={reload} /><Notice>Simulator tidak menghubungi provider ITSM perusahaan. Rahasia penandatanganan tetap di server.</Notice></aside></div></>}
  </>;
}
function TicketControls({ ticket, onDone }: { ticket: TicketDetail; onDone: () => void }) {
  const { session } = useAuth(); const mutation = useMutation(); const [simulateSyncFailure, setSimulateSyncFailure] = useState(ticket.simulateSyncFailure);
  const demo = session?.mode === 'DEMO' && ticket.mode === 'DEMO';
  const operator = demo && hasRole(session.user, 'OPERATOR', ticket);
  const canScenario = demo && (operator || hasRole(session.user, 'PLATFORM_ADMIN', ticket));
  if (!operator && !canScenario) return <Panel title="Sinkronisasi"><div className="panel-body"><p className="muted">Retry outbox hanya tersedia untuk operator dalam cakupan tiket.</p></div></Panel>;
  return <Panel title="Kontrol sinkronisasi"><div className="panel-body stack"><ErrorState error={mutation.error} compact />{operator && <><button className="button secondary" disabled={mutation.busy || ticket.syncStatus !== 'FAILED' || !ticket.outbox.some(event => event.status === 'FAILED')} onClick={() => void mutation.run(() => mutate(`/api/tickets/${encodeURIComponent(ticket.id)}/sync-retry`, {}), onDone)}><RefreshCw size={16} />Retry sinkronisasi tiket</button><p className="muted">Hanya mengantrekan ulang outbox gagal, bukan operasi VM.</p></>}{canScenario && <form className="stack" onSubmit={e => { e.preventDefault(); void mutation.run(() => mutate(`/api/tickets/${encodeURIComponent(ticket.id)}/scenario`, { simulateSyncFailure }), onDone); }}><label className="checkbox-label"><input id="ticket-sync-failure" type="checkbox" checked={simulateSyncFailure} onChange={e => setSimulateSyncFailure(e.target.checked)} disabled={mutation.busy} />Simulasikan kegagalan sinkronisasi tiket</label><p className="muted">DEMO saja. Nonaktifkan simulasi sebelum retry agar pengiriman berikutnya dapat berhasil. Tidak mengubah hasil infrastruktur.</p><button className="button secondary" disabled={mutation.busy || simulateSyncFailure === ticket.simulateSyncFailure}>Simpan skenario tiket</button></form>}</div></Panel>;
}

export function Settings() {
  const { session } = useAuth(); const { data, error, loading, reload } = useApi<SettingsData>('/api/settings');
  return <><PageHeader title="Settings" description="Identitas, integrasi, dan kebijakan operasional workspace Anda." />{loading ? <Loading /> : error ? <ErrorState error={error} retry={reload} /> : data && <div className="settings-grid"><div className="stack"><Panel title="Profil & cakupan akses" description="Hak akses berasal dari penugasan akun di server"><div className="panel-body"><div className="profile-row"><span className="avatar large">{session?.user.name.slice(0, 2).toUpperCase()}</span><div><h3>{session?.user.name}</h3><p className="muted">{session?.user.email}</p></div></div><div className="assignment-list">{session?.user.assignments.map((a, index) => <div className="assignment" key={`${a.role}-${a.teamId}-${index}`}><span className="badge info">{a.role}</span><div><strong>Tim {a.teamId}</strong><p>{a.environments.join(', ') || 'Tidak ada environment'}</p></div></div>)}</div></div></Panel><Panel title="Integrasi" description="Status koneksi yang dilaporkan oleh server"><div className="integration-list">{data.integrations.length ? data.integrations.map(i => <div className="integration" key={i.id}><span className="integration-icon"><GitBranch size={21} /></span><div><h3>{i.name}</h3><p>{i.description}</p></div><StatusBadge status={i.status} /></div>) : <Empty title="Belum ada integrasi" />}</div></Panel></div><div className="stack"><Panel title="Kebijakan operasional" action={<ShieldCheck size={19} className="muted" />}><dl className="panel-body"><KeyValue label="Mode"><span className="badge warning">{data.mode}</span></KeyValue><KeyValue label="Akses produksi">{data.policy.productionAllowed ? 'Diizinkan oleh server' : 'Tidak diizinkan'}</KeyValue><KeyValue label="Masa berlaku approval">{data.policy.approvalTtlMinutes} menit</KeyValue><KeyValue label="Zona waktu">{data.policy.timezone} (UTC+07:00)</KeyValue></dl><div className="panel-footer"><LockKeyhole size={15} />Kebijakan dikelola oleh administrator server.</div></Panel><Panel title="Kesehatan sistem"><div className="panel-body health-row"><span><HardDrive size={18} />Database</span><StatusBadge status={data.health.database} /></div></Panel><Notice>Mode demo tidak menjalankan operasi produksi. Perubahan konfigurasi dan pemilihan peran tidak tersedia pada antarmuka ini.</Notice>{session && hasRole(session.user, 'AUDITOR') && <Link href="/audit" className="button secondary">Buka audit trail<ArrowRight size={16} /></Link>}</div></div>}</>;
}

export function NotFound() { return <><PageHeader title="Halaman tidak ditemukan" description="Alamat yang Anda buka tidak tersedia di workspace ini." /><BackLink href="/">Kembali ke dashboard</BackLink></>; }
