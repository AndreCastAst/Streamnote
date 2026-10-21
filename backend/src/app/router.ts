// Ejecuta una ruta con independencia del transporte (Fastify en local, API Gateway en AWS).
import { ZodError } from 'zod';
import { HttpError, isResponse, type Request, type Route } from '../core/http.js';
import { bearer } from '../core/auth.js';
import type { Deps } from './deps.js';
import { identityRoutes } from '../domains/identity.js';
import { communityRoutes } from '../domains/communities.js';
import { noteRoutes } from '../domains/notes.js';
import { folderRoutes } from '../domains/folders.js';
import { streamRoutes } from '../domains/streams.js';
import { notificationRoutes } from '../domains/notifications.js';

export const routes: Route[] = [...identityRoutes, ...communityRoutes, ...noteRoutes, ...folderRoutes, ...streamRoutes, ...notificationRoutes];

export interface RawRequest {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface RawResponse {
  status: number;
  body: unknown;
}

export async function execute(route: Route, raw: RawRequest, deps: Deps, log: (e: unknown) => void = console.error): Promise<RawResponse> {
  try {
    const req: Request = { ...raw, user: null };
    if (route.auth === 'user') {
      req.user = await deps.auth.verify(bearer(raw.headers.authorization));
      if (!req.user) throw new HttpError(401, 'Sesión no válida o vencida', 'unauthorized');
    }
    if (route.auth === 'internal' && raw.headers['x-internal-secret'] !== deps.cfg.realtime.internalSecret) {
      throw new HttpError(403, 'Solo para uso interno', 'forbidden');
    }
    if (route.body) req.body = route.body.parse(raw.body ?? {});
    const result = await route.handler(req, deps);
    if (isResponse(result)) return { status: result.status ?? 200, body: result.body ?? null };
    return { status: 200, body: result ?? null };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.code, message: e.message } };
    if (e instanceof ZodError) {
      const first = e.issues[0];
      return { status: 400, body: { error: 'validation', message: `${first.path.join('.') || 'cuerpo'}: ${first.message}`, issues: e.issues } };
    }
    log(e);
    return { status: 500, body: { error: 'internal', message: 'Error interno' } };
  }
}

/** Búsqueda de ruta para el adaptador de Lambda (Fastify tiene su propio enrutador). */
export function matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
  const candidates = routes
    .filter((r) => r.method === method)
    .sort((a, b) => (a.path.match(/:/g)?.length ?? 0) - (b.path.match(/:/g)?.length ?? 0));
  for (const r of candidates) {
    const names: string[] = [];
    const re = new RegExp('^' + r.path.replace(/:([a-zA-Z]+)/g, (_, n) => (names.push(n), '([^/]+)')) + '/?$');
    const m = re.exec(path);
    if (m) return { route: r, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
