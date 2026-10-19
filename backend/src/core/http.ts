// Definición de rutas independiente del transporte: la misma ruta la sirve
// Fastify en local y el adaptador de API Gateway + Lambda en AWS.
import type { ZodType } from 'zod';
import type { Deps } from '../app/deps.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error') {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m, 'bad_request');
export const unauthorized = (m = 'Sesión no válida') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'No tienes permiso para esto') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'No encontrado') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface Request<B = unknown> {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: B;
  headers: Record<string, string | undefined>;
  user: AuthUser | null;
}

export interface Response {
  status?: number;
  body?: unknown;
}

export type Handler<B = any> = (req: Request<B>, deps: Deps) => Promise<Response | unknown>;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string; // estilo '/communities/:id'
  auth: 'user' | 'none' | 'internal';
  body?: ZodType;
  handler: Handler;
}

export function route(r: Route): Route {
  return r;
}

export function isResponse(v: unknown): v is Response {
  return typeof v === 'object' && v !== null && ('status' in v || 'body' in v) && Object.keys(v).every((k) => k === 'status' || k === 'body');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parámetro de ruta que debe ser un UUID; si no lo es, el recurso no existe. */
export function idParam(req: Request, name = 'id'): string {
  const v = req.params[name];
  if (!v || !UUID.test(v)) throw notFound();
  return v;
}

export function requireUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
