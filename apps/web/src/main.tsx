import { StrictMode, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './api';
import App from './App';
import { DemoBadge, Logo } from './components';
import './styles.css';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <><header className="login-topbar"><Logo /><DemoBadge /></header><main className="fatal-error"><h1>Halaman tidak dapat ditampilkan</h1><p>Terjadi kesalahan pada antarmuka. Muat ulang untuk mencoba kembali.</p><button className="button primary" onClick={() => window.location.reload()}>Muat ulang</button></main></>;
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><AuthProvider><App /></AuthProvider></ErrorBoundary></StrictMode>);
