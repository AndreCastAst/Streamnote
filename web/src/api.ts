// Cliente de la API y del canal en tiempo real.
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';

export interface User {
  id: string;
  email: string;
  name: string;
}

export type ModuleType = 'text' | 'heading' | 'code' | 'checklist' | 'quote';
// Acomodo en la cuadrícula de 12 columnas, en unidades de cuadrícula
export interface ModuleLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface NoteModule {
  id: string;
  type: ModuleType;
  content: any;
  sourceModuleId?: string | null;
  sourceAuthor?: string | null;
  layout?: ModuleLayout;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const KEY = 'streamnote.session';

export function loadSession(): { token: string; user: User } | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: { token: string; user: User } | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* almacenamiento no disponible: la sesión dura lo que la pestaña */
  }
}

let token: string | null = loadSession()?.token ?? null;
export const setToken = (t: string | null) => (token = t);
export const getToken = () => token;
let onUnauthorized: () => void = () => {};
export const handleUnauthorized = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'No hay conexión con el servidor');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401 && token) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, data?.message ?? `Error ${res.status}`);
  return data as T;
}

// ---------- Tiempo real ----------
export interface RealtimeMessage {
  channel: string;
  type: string;
  data: any;
}
type Listener = (m: RealtimeMessage) => void;

class Realtime {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private channels = new Map<string, number>();
  private retry = 0;
  private timer: number | undefined;
  private wanted = false;
  connected = false;
  private statusListeners = new Set<(c: boolean) => void>();

  start() {
    this.wanted = true;
    this.open();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private open() {
    if (!token || !this.wanted || this.ws) return;
    const ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setConnected(true);
      for (const ch of this.channels.keys()) ws.send(JSON.stringify({ type: 'subscribe', channel: ch }));
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const msg = JSON.parse(e.data) as RealtimeMessage;
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      // Una conexión vieja que se cierra no debe abrir otra si ya hay una nueva
      if (this.ws !== ws) return;
      this.ws = null;
      this.setConnected(false);
      if (!this.wanted) return;
      const delay = Math.min(15000, 500 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => this.open(), delay);
    };
  }

  private setConnected(c: boolean) {
    this.connected = c;
    for (const l of this.statusListeners) l(c);
  }

  onStatus(fn: (c: boolean) => void) {
    this.statusListeners.add(fn);
    return () => void this.statusListeners.delete(fn);
  }

  listen(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  subscribe(channel: string) {
    this.channels.set(channel, (this.channels.get(channel) ?? 0) + 1);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'subscribe', channel }));
    return () => {
      const n = (this.channels.get(channel) ?? 1) - 1;
      if (n <= 0) {
        this.channels.delete(channel);
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsubscribe', channel }));
      } else this.channels.set(channel, n);
    };
  }
}

export const realtime = new Realtime();

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString('es-PE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function relative(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'hace un momento';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return formatDate(iso);
}
