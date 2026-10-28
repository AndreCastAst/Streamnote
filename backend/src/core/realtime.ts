// Mensajes en tiempo real (chat, módulos compartidos en directo, notificaciones).
// Local: la API mantiene los WebSocket; el worker le reenvía mensajes por HTTP.
// AWS:   el chat y los módulos compartidos van como eventos de IVS Chat (SendEvent) y las
//        notificaciones como Web Push; esta interfaz es el punto de cambio.
import type { WebSocket } from 'ws';
import type { Config } from '../config.js';

export interface RealtimeMessage {
  channel: string; // 'user:<id>' | 'stream:<id>'
  type: string;
  data: unknown;
}

export interface Realtime {
  publish(msg: RealtimeMessage): Promise<void>;
}

export interface OnlineUser {
  id: string;
  name: string;
}

const isStream = (channel: string) => channel.startsWith('stream:');

/** Concentrador en memoria dentro del proceso de la API. */
export class LocalHub implements Realtime {
  private subs = new Map<string, Set<WebSocket>>();
  // Presencia: quién está detrás de cada socket suscrito a un canal de directo
  private users = new Map<string, Map<WebSocket, OnlineUser>>();

  subscribe(channel: string, ws: WebSocket, user?: OnlineUser) {
    if (!this.subs.has(channel)) this.subs.set(channel, new Set());
    this.subs.get(channel)!.add(ws);
    if (user && isStream(channel)) {
      if (!this.users.has(channel)) this.users.set(channel, new Map());
      // Volver a suscribirse no cambia el orden: Map conserva la posición de una clave existente
      this.users.get(channel)!.set(ws, { id: user.id, name: user.name });
    }
  }

  /** Devuelve si el socket estaba en el canal (para avisar de la baja solo entonces). */
  unsubscribe(channel: string, ws: WebSocket): boolean {
    const set = this.subs.get(channel);
    const had = !!set?.delete(ws);
    if (set && !set.size) this.subs.delete(channel);
    const users = this.users.get(channel);
    users?.delete(ws);
    if (users && !users.size) this.users.delete(channel);
    return had;
  }

  /** Quita el socket de todos los canales y devuelve los de directo en los que estaba. */
  drop(ws: WebSocket): string[] {
    const left: string[] = [];
    for (const channel of [...this.subs.keys()]) {
      if (this.unsubscribe(channel, ws) && isStream(channel)) left.push(channel);
    }
    return left;
  }

  /** Usuarios conectados a un canal de directo, sin repetir (dos pestañas cuentan una vez), en orden de llegada. */
  online(channel: string): OnlineUser[] {
    const seen = new Map<string, OnlineUser>();
    for (const u of this.users.get(channel)?.values() ?? []) if (!seen.has(u.id)) seen.set(u.id, { ...u });
    return [...seen.values()];
  }

  count(channel: string) {
    return this.subs.get(channel)?.size ?? 0;
  }

  async publish(msg: RealtimeMessage) {
    const payload = JSON.stringify(msg);
    for (const ws of this.subs.get(msg.channel) ?? []) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }
}

/** Usado por el worker: reenvía a la API, que tiene las conexiones abiertas. */
export class HttpRelay implements Realtime {
  constructor(private cfg: Config) {}

  async publish(msg: RealtimeMessage) {
    const res = await fetch(`${this.cfg.realtime.apiInternalUrl}/internal/realtime`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': this.cfg.realtime.internalSecret },
      body: JSON.stringify(msg),
    });
    if (!res.ok) throw new Error(`No se pudo reenviar el mensaje en tiempo real (${res.status})`);
  }
}

/** Sin canal en tiempo real (AWS hasta conectar IVS Chat y Web Push): los avisos quedan en DynamoDB. */
export class NoRealtime implements Realtime {
  async publish() {}
}
