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

/** Concentrador en memoria dentro del proceso de la API. */
export class LocalHub implements Realtime {
  private subs = new Map<string, Set<WebSocket>>();

  subscribe(channel: string, ws: WebSocket) {
    if (!this.subs.has(channel)) this.subs.set(channel, new Set());
    this.subs.get(channel)!.add(ws);
  }

  unsubscribe(channel: string, ws: WebSocket) {
    this.subs.get(channel)?.delete(ws);
  }

  drop(ws: WebSocket) {
    for (const set of this.subs.values()) set.delete(ws);
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
