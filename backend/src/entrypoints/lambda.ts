// Entradas para AWS Lambda. Usan exactamente las mismas rutas y funciones que el servidor
// y el worker locales; solo cambia cómo llega la petición.
//   http          ← API Gateway HTTP API (payload 2.0)
//   noteWrites    ← SQS note-writes      (ReportBatchItemFailures)
//   domainEvents  ← SQS domain-events    (destino de la regla de EventBridge y de Scheduler)
//   mediaJobs     ← SQS media-jobs       (en AWS lo llena la regla "IVS Recording State Change")
import { buildDeps } from '../app/deps.js';
import { execute, matchRoute } from '../app/router.js';
import { applyNoteWrite } from '../domains/notes.js';
import { handleDomainEvent } from '../domains/notifications.js';
import { processRecording } from '../domains/streams.js';

// Tipos mínimos para no depender de @types/aws-lambda
interface HttpEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string }; stage?: string };
}
interface SqsEvent {
  Records: { messageId: string; body: string }[];
}

// Se crean una vez por contenedor de Lambda y se reutilizan entre invocaciones
// (realtime 'relay' queda sin uso en AWS hasta conectar IVS Chat / Web Push)
const deps = buildDeps({ realtime: 'relay' });

export async function http(event: HttpEvent) {
  const method = event.requestContext.http.method.toUpperCase();
  const stage = event.requestContext.stage && event.requestContext.stage !== '$default' ? `/${event.requestContext.stage}` : '';
  const path = event.rawPath.startsWith(stage) ? event.rawPath.slice(stage.length) || '/' : event.rawPath;
  const match = matchRoute(method, path);
  if (!match) return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body) : '';
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const res = await execute(match.route, {
    params: match.params,
    query: Object.fromEntries(new URLSearchParams(event.rawQueryString ?? '')),
    headers,
    body: raw ? JSON.parse(raw) : undefined,
  }, deps);
  return { statusCode: res.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(res.body) };
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

export const noteWrites = (event: SqsEvent) => eachRecord(event, (m) => applyNoteWrite(deps, m));
export const domainEvents = (event: SqsEvent) => eachRecord(event, (e) => handleDomainEvent(deps, e['detail-type'], e.detail));
export const mediaJobs = (event: SqsEvent) => eachRecord(event, (j) => processRecording(deps, j.streamId));
