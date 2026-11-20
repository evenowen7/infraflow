import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, ChevronRight, ClipboardCheck, Eye, EyeOff, FileClock, FileText, Headphones, LayoutDashboard, Layers3, LockKeyhole, LogOut, Menu, Search, Server, Settings as SettingsIcon, ShieldCheck, X } from 'lucide-react';
import { useAuth, useMutation } from './api';
import { DemoBadge, ErrorState, Field, Link, Loading, Logo, navigate, useLocation } from './components';
import { Audit, Dashboard, NotFound, Requests, Services, Settings, TicketDetails, Tickets } from './pages';
import { ResourceDetail, Resources } from './resources';
import { EditRequest, RequestDetails, RequestWizard } from './request-pages';

const navigation = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/services', label: 'Layanan', icon: Layers3 },
  { href: '/resources', label: 'Resource VM', icon: Server },
  { href: '/requests', label: 'Requests', icon: FileText },
  { href: '/approvals', label: 'Approval', icon: ClipboardCheck },
  { href: '/tickets', label: 'Service Desk', icon: Headphones },
  { href: '/audit', label: 'Audit', icon: FileClock },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];
const demoEmails = ['requester', 'approver', 'operator', 'admin', 'auditor', 'requester2'].map(name => `${name}@demo.infraflow.test`);

function Login() {
  const { login } = useAuth(); const mutation = useMutation();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [show, setShow] = useState(false);
  return <div className="login-screen"><header className="login-topbar"><Logo /><div><span className="topbar-subtitle">Portal layanan infrastruktur</span><DemoBadge /></div></header><main className="login-main"><section className="login-story"><span className="eyebrow"><span className="tiny-dot" />INFRASTRUCTURE, WITH CONFIDENCE</span><h1>Operasional tertata.<br /><span>Infrastruktur terkendali.</span></h1><p>Dari request hingga verifikasi. Kelola layanan infrastruktur dengan persetujuan yang jelas dan jejak audit di setiap langkah.</p><div className="login-workflow"><div className="workflow-line" /><div className="workflow-node"><span><FileText size={21} /></span><div><strong>Ajukan kebutuhan</strong><p>Request terstruktur dengan konteks yang lengkap.</p></div><span className="workflow-number">01</span></div><div className="workflow-node"><span><ClipboardCheck size={21} /></span><div><strong>Tinjau & setujui</strong><p>Keputusan independen, sesuai kebijakan.</p></div><span className="workflow-number">02</span></div><div className="workflow-node"><span><CheckCircle2 size={21} /></span><div><strong>Eksekusi & verifikasi</strong><p>Hasil yang terukur, bukti yang dapat ditelusuri.</p></div><span className="workflow-number">03</span></div></div><div className="login-trust"><ShieldCheck size={19} /><span>Berbasis peran</span><span className="separator-dot" /><span>Audit-ready</span><span className="separator-dot" /><span>Human approval</span></div></section><section className="login-form-area"><div className="login-card"><span className="login-lock"><LockKeyhole size={23} /></span><h2>Masuk ke workspace</h2><p>Gunakan akun Anda untuk melanjutkan ke InfraFlow.</p><form onSubmit={e => { e.preventDefault(); void mutation.run(() => login(email.trim(), password)); }} className="stack"><Field label="Alamat email" htmlFor="login-email" required><input id="login-email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="nama@perusahaan.com" required disabled={mutation.busy} autoFocus /></Field><Field label="Password" htmlFor="login-password" required><div className="password-input"><input id="login-password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Masukkan password" required disabled={mutation.busy} /><button type="button" className="icon-button" aria-label={show ? 'Sembunyikan password' : 'Tampilkan password'} aria-pressed={show} onClick={() => setShow(value => !value)}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></Field><ErrorState error={mutation.error} compact /><button className="button primary full-width login-submit" disabled={mutation.busy}>{mutation.busy ? 'Memverifikasi akun…' : 'Masuk ke InfraFlow'}<ArrowRight size={18} /></button></form><div className="login-security"><LockKeyhole size={13} />Sesi aman menggunakan cookie HttpOnly</div><details className="demo-accounts"><summary>Akun yang tersedia untuk demo</summary><p>Setiap akun memiliki penugasan tersendiri. Gunakan password demo yang diberikan administrator; tidak ada password bawaan di halaman ini.</p><div>{demoEmails.map(address => <button key={address} type="button" onClick={() => { setEmail(address); document.getElementById('login-password')?.focus(); }} disabled={mutation.busy}>{address}<ArrowRight size={13} /></button>)}</div></details></div><p className="login-demo-note"><DemoBadge />Lingkungan demonstrasi, bukan infrastruktur produksi.</p></section></main><footer className="login-footer"><span>InfraFlow · Infrastructure Service Management</span><span>Dirancang untuk operasi yang dapat dipercaya.</span></footer></div>;
}

function Route({ pathname, search }: { pathname: string; search: string }) {
  if (pathname === '/' || pathname === '/login') return <Dashboard />;
  if (pathname === '/services') return <Services />;
  if (pathname === '/resources') return <Resources initialSearch={new URLSearchParams(search).get('q') ?? ''} />;
  const resource = pathname.match(/^\/resources\/([^/]+)$/);
  if (resource) return <ResourceDetail id={decodeURIComponent(resource[1]!)} />;
  if (pathname === '/requests/new') return <RequestWizard key={search} />;
  if (pathname === '/requests') return <Requests />;
  const edit = pathname.match(/^\/requests\/([^/]+)\/edit$/);
  if (edit) return <EditRequest id={decodeURIComponent(edit[1]!)} />;
  const request = pathname.match(/^\/requests\/([^/]+)$/);
  if (request) return <RequestDetails id={decodeURIComponent(request[1]!)} />;
  if (pathname === '/approvals') return <Requests approval />;
  if (pathname === '/tickets') return <Tickets />;
  const ticket = pathname.match(/^\/tickets\/([^/]+)$/);
  if (ticket) return <TicketDetails id={decodeURIComponent(ticket[1]!)} />;
  if (pathname === '/audit') return <Audit />;
  if (pathname === '/settings') return <Settings />;
  return <NotFound />;
}

export default function App() {
  const { session, loading, error, logout, retry } = useAuth(); const location = useLocation();
  const url = new URL(location, window.location.origin); const pathname = url.pathname.replace(/\/$/, '') || '/';
  const [menuOpen, setMenuOpen] = useState(false); const [search, setSearch] = useState(''); const mutation = useMutation();
  const mainRef = useRef<HTMLElement>(null); const menuRef = useRef<HTMLButtonElement>(null);
  const page = navigation.find(n => n.href === '/' ? pathname === '/' : pathname.startsWith(n.href))?.label ?? 'Workspace';
  useEffect(() => {
    setMenuOpen(false); window.scrollTo({ top: 0 });
    mainRef.current?.focus({ preventScroll: true }); document.title = `${page} — InfraFlow`;
  }, [location, page]);
  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { setMenuOpen(false); menuRef.current?.focus(); } }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  if (loading || error) return <><header className="login-topbar"><Logo /><DemoBadge /></header><main className="session-state">{loading ? <Loading label="Memeriksa sesi aman…" /> : <ErrorState error={error} retry={retry} />}</main></>;
  if (!session) return <Login />;
  return <div className="app-shell"><a className="skip-link" href="#main-content">Lewati ke konten utama</a>{menuOpen && <button className="sidebar-overlay" aria-label="Tutup navigasi" onClick={() => setMenuOpen(false)} />}
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`} id="workspace-navigation"><div className="sidebar-brand"><Logo /><button className="icon-button mobile-close" aria-label="Tutup navigasi" onClick={() => { setMenuOpen(false); menuRef.current?.focus(); }}><X size={20} /></button></div><div className="workspace-switch"><span className="workspace-avatar">IF</span><div><strong>InfraFlow Workspace</strong><span>Demo environment</span></div><ChevronRight size={14} /></div><div className="nav-caption">WORKSPACE</div><nav aria-label="Navigasi utama">{navigation.map((item, index) => <Link key={item.href} href={item.href} aria-current={item.href === '/' ? pathname === '/' ? 'page' : undefined : pathname.startsWith(item.href) ? 'page' : undefined} className={`nav-item ${index === 6 ? 'nav-separated' : ''}`}><item.icon size={19} strokeWidth={1.8} /><span>{item.label}</span>{item.href === '/services' && <span className="nav-mini-badge">Katalog</span>}</Link>)}</nav><div className="sidebar-bottom"><div className="sidebar-note"><ShieldCheck size={20} /><strong>Built for accountability</strong><p>Setiap langkah tercatat.<br />Setiap hasil terverifikasi.</p></div><div className="sidebar-version"><span className="tiny-dot" />Demo workspace<span>v0.1</span></div></div></aside>
    <header className="topbar"><div className="topbar-breadcrumb"><button ref={menuRef} className="icon-button mobile-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label="Buka navigasi" aria-expanded={menuOpen} aria-controls="workspace-navigation"><Menu size={22} /></button><span>Workspace</span><ChevronRight size={14} /><strong>{page}</strong></div><div className="topbar-actions"><form className="global-search" onSubmit={e => { e.preventDefault(); navigate(`/resources?q=${encodeURIComponent(search.trim())}`); }}><label className="sr-only" htmlFor="global-search">Cari resource</label><Search size={16} /><input id="global-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Cari resource…" /><button type="submit" aria-label="Jalankan pencarian"><ArrowRight size={14} /></button></form><DemoBadge /><div className="topbar-divider" /><Link href="/settings" className="user-profile" aria-label={`Profil ${session.user.name}`}><span className="avatar">{session.user.name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase()}</span><span><strong>{session.user.name}</strong><small>{Array.from(new Set(session.user.assignments.map(a => a.role))).join(' · ') || 'Tanpa penugasan'}</small></span></Link><button className="icon-button logout-button" aria-label="Keluar dari akun" title="Keluar" disabled={mutation.busy} onClick={() => void mutation.run(logout)}><LogOut size={17} /></button></div></header>
    <main id="main-content" className="main-content" tabIndex={-1} ref={mainRef}><ErrorState error={mutation.error} compact /><Route key={pathname} pathname={pathname} search={url.search} /><footer className="workspace-footer"><span>InfraFlow <span> / </span> Infrastructure Service Management</span><span><ShieldCheck size={13} />Semua waktu dalam WIB (UTC+07:00)</span></footer></main>
  </div>;
}
