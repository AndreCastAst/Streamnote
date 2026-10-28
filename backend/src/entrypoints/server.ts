// API local: Fastify sirve las mismas rutas que en AWS sirve API Gateway + Lambda,
// y además mantiene los WebSocket del tiempo real.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { buildDeps } from '../app/deps.js';
import { execute, routes } from '../app/router.js';
import { canView } from '../domains/access.js';
import type { RealtimeMessage } from '../core/realtime.js';

const deps = buildDeps({ realtime: 'hub' });
const hub = deps.hub!;
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.register(cors, { origin: deps.cfg.webOrigin.split(','), methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
await app.register(websocket);

for (const r of routes) {
  app.route({
    method: r.method,
    url: r.path,
    handler: async (req, reply) => {
      const res = await execute(
        r,
        {
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string>,
          headers: req.headers as Record<string, string>,
          body: req.body,
        },
        deps,
        (e) => req.log.error(e),
      );
      return reply.status(res.status).send(res.body);
    },
  });
}

app.get('/health', async () => ({ ok: true, stage: deps.cfg.stage }));

// El worker reenvía aquí los mensajes en tiempo real
app.post('/internal/realtime', async (req, reply) => {
  if (req.headers['x-internal-secret'] !== deps.cfg.realtime.internalSecret) return reply.status(403).send();
  await hub.publish(req.body as RealtimeMessage);
  return { ok: true };
});

// Presencia: a cada alta o baja en un canal de directo, la lista de conectados va a todo el canal
const presence = (channel: string) =>
  hub.publish({ channel, type: 'presence', data: { online: hub.online(channel) } }).catch(() => undefined);

// WebSocket: canal personal automático + suscripción a directos que el usuario puede ver
app.get('/ws', { websocket: true }, async (socket, req) => {
  const user = await deps.auth.verify((req.query as Record<string, string>).token);
  if (!user) {
    socket.close(4401, 'unauthorized');
    return;
  }
  hub.subscribe(`user:${user.id}`, socket);
  socket.on('message', async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; channel?: string };
      if (msg.type === 'ping') return socket.send(JSON.stringify({ type: 'pong' }));
      const m = /^stream:([0-9a-f-]{36})$/.exec(msg.channel ?? '');
      if (!m) return;
      if (msg.type === 'unsubscribe') {
        if (hub.unsubscribe(msg.channel!, socket)) await presence(msg.channel!);
        return;
      }
      if (msg.type === 'subscribe') {
        const s = await deps.db.one<{ community_id: string }>('SELECT community_id FROM stream_sessions WHERE id = :id::uuid', { id: m[1] });
        // Si el socket se cerró mientras se consultaba, no se suscribe: quedaría «conectado» para siempre
        if (s && (await canView(deps.db, s.community_id, user.id)) && socket.readyState === socket.OPEN) {
          hub.subscribe(msg.channel!, socket, { id: user.id, name: user.name });
          socket.send(JSON.stringify({ channel: msg.channel, type: 'subscribed', data: { online: hub.online(msg.channel!) } }));
          await presence(msg.channel!);
        }
      }
    } catch (e) {
      req.log.warn(e, 'mensaje WebSocket inválido');
    }
  });
  socket.on('close', () => {
    // Un usuario con otra pestaña abierta sigue en la lista mientras le quede un socket
    for (const channel of hub.drop(socket)) void presence(channel);
  });
});

const close = async () => {
  await app.close();
  await deps.db.close();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ port: deps.cfg.port, host: '0.0.0.0' });
