import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from './types';

let csrfToken = '';
const unauthorized = new EventTarget();
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('Content-Type', 'application/json');
    headers.set('X-CSRF-Token', csrfToken);
  }
  let response: Response;
  try { response = await fetch(path, { ...options, headers, credentials: 'same-origin' }); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('Tidak dapat terhubung ke server. Periksa koneksi Anda lalu coba lagi.', 0);
  }
  const data = await response.json().catch(() => null);
  const token = response.headers.get('X-CSRF-Token') ?? data?.csrfToken;
  if (typeof token === 'string') csrfToken = token;
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') unauthorized.dispatchEvent(new Event('expired'));
    throw new ApiError(data?.error ?? `Permintaan gagal (${response.status}).`, response.status, data?.code);
  }
  if (data === null && response.status !== 204) throw new ApiError('Respons server tidak valid. Coba muat ulang atau hubungi administrator.', response.status, 'INVALID_RESPONSE');
  return data as T;
}
export function mutate<T>(path: string, body: unknown = {}, method = 'POST', idempotency: boolean | string = false) {
  return api<T>(path, {
    method, body: JSON.stringify(body),
    headers: idempotency ? { 'Idempotency-Key': typeof idempotency === 'string' ? idempotency : crypto.randomUUID() } : undefined,
  });
}
interface AuthValue {
  session: Session | null; loading: boolean; error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>; retry: () => void;
}
const AuthContext = createContext<AuthValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    api<Session>('/api/me', { signal: controller.signal }).then(setSession).catch(e => {
      if (e.name !== 'AbortError' && e.status !== 401) setError(e.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const expire = () => { setSession(null); csrfToken = ''; };
    unauthorized.addEventListener('expired', expire);
    return () => { controller.abort(); unauthorized.removeEventListener('expired', expire); };
  }, [attempt]);
  const login = async (email: string, password: string) => {
    const result = await mutate<Session>('/api/auth/login', { email, password });
    csrfToken = result.csrfToken; setSession(result); setError(null);
  };
  const logout = async () => {
    await mutate('/api/auth/logout'); setSession(null); csrfToken = '';
  };
  return <AuthContext.Provider value={{ session, loading, error, login, logout, retry: () => setAttempt(v => v + 1) }}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider required');
  return value;
}
export function useApi<T>(path: string | null, poll?: (data: T) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [version, setVersion] = useState(0);
  const pollRef = useRef(poll); pollRef.current = poll;
  const reload = useCallback(() => setVersion(n => n + 1), []);
  useEffect(() => {
    if (!path) { setData(null); setLoading(false); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true); setError(null); setData(null);
    async function load() {
      try {
        const result = await api<T>(path!, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData(result); setError(null); setLoading(false);
        if (pollRef.current?.(result)) timer = setTimeout(load, 2000);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e : new Error('Terjadi kesalahan.')); setLoading(false);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, version]);
  return { data, loading, error, reload };
}
export function useMutation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const locked = useRef(false);
  async function run<T>(operation: () => Promise<T>, done?: (result: T) => void) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(null);
    try { const result = await operation(); done?.(result); }
    catch (e) { setError(e instanceof Error ? e : new Error('Terjadi kesalahan.')); }
    finally { locked.current = false; setBusy(false); }
  }
  return { busy, error, run, clearError: () => setError(null) };
}
