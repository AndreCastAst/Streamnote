// Entradas para AWS Lambda. Usan exactamente las mismas rutas y funciones que el servidor
// y el worker locales; solo cambia cómo llega la petición.
//   http          ← API Gateway REST API (payload 1.0); también acepta HTTP API (payload 2.0)
//   noteWrites    ← SQS note-writes      (ReportBatchItemFailures)
//   domainEvents  ← SQS domain-events    (destino de la regla de EventBridge y de Scheduler)
//   mediaJobs     ← SQS media-jobs       (en AWS lo llena la regla "IVS Recording State Change")
//   migrate       ← la invoca el pipeline después de cada terraform apply
import { readdir, readFile } from 'node:fs/promises';
import { buildDeps } from '../app/deps.js';
import { execute, matchRoute } from '../app/router.js';
import { applyNoteWrite, notifyNoteUpdated } from '../domains/notes.js';
import { handleDomainEvent } from '../domains/notifications.js';
import { processRecording } from '../domains/streams.js';

// Tipos mínimos para no depender de @types/aws-lambda
interface HttpEvent {
  // payload 2.0 (HTTP API)
  rawPath?: string;
  rawQueryString?: string;
  // payload 1.0 (REST API)
  path?: string;
  httpMethod?: string;
  queryStringParameters?: Record<string, string> | null;
  headers?: Record<string, string> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: { http?: { method: string }; stage?: string };
}
interface SqsEvent {
  Records: { messageId: string; body: string }[];
}

// La sesión viaja en la cabecera Authorization (no hay cookies), así que permitir cualquier
// origen no expone nada: sin un token válido la API responde 401.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
};

// Se crean una vez por contenedor de Lambda y se reutilizan entre invocaciones
// (realtime 'relay' queda sin uso en AWS hasta conectar IVS Chat / Web Push)
const deps = buildDeps({ realtime: 'relay' });

export async function http(event: HttpEvent) {
  const method = (event.requestContext.http?.method ?? event.httpMethod ?? 'GET').toUpperCase();
  const stage = event.requestContext.stage && event.requestContext.stage !== '$default' ? `/${event.requestContext.stage}` : '';
  const fullPath = event.rawPath ?? event.path ?? '/';
  const path = stage && (fullPath === stage || fullPath.startsWith(`${stage}/`)) ? fullPath.slice(stage.length) || '/' : fullPath;
  const match = matchRoute(method, path);
  if (!match) return { statusCode: 404, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify({ error: 'not_found' }) };
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : '';
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const query = event.rawQueryString !== undefined ? Object.fromEntries(new URLSearchParams(event.rawQueryString)) : { ...(event.queryStringParameters ?? {}) };
  const res = await execute(match.route, {
    params: match.params,
    query,
    headers,
    body: raw ? JSON.parse(raw) : undefined,
  }, deps);
  return { statusCode: res.status, headers: { 'content-type': 'application/json', ...CORS }, body: JSON.stringify(res.body) };
}

async function eachRecord(event: SqsEvent, fn: (body: any) => Promise<unknown>) {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const r of event.Records) {
    try {
      await fn(JSON.parse(r.body));
    } catch (e) {
      console.error(e);
      batchItemFailures.push({ itemIdentifier: r.messageId });
    }
  }
  return { batchItemFailures };
}

export const noteWrites = (event: SqsEvent) =>
  eachRecord(event, async (m) => {
    if ((await applyNoteWrite(deps, m)) === 'applied') await notifyNoteUpdated(deps, m.noteId);
  });
export const domainEvents = (event: SqsEvent) => eachRecord(event, (e) => handleDomainEvent(deps, e['detail-type'], e.detail));
export const mediaJobs = (event: SqsEvent) => eachRecord(event, (j) => processRecording(deps, j.streamId));

/** Separa un archivo .sql en sentencias: la Data API ejecuta una sola por llamada. */
export function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Aplica las migraciones pendientes (copiadas a dist/lambda/migrations por build:lambda).
 * Es idempotente: el pipeline la invoca en cada despliegue.
 */
export async function migrate() {
  const dir = new URL('./migrations/', import.meta.url);
  await deps.db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await deps.db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const statements = splitSql(await readFile(new URL(file, dir), 'utf8'));
    await deps.db.tx(async (db) => {
      for (const s of statements) await db.query(s);
      await db.query('INSERT INTO schema_migrations (name) VALUES (:name)', { name: file });
    });
    console.log(`Migración aplicada: ${file}`);
    applied.push(file);
  }
  return { applied, total: done.size + applied.length };
}
