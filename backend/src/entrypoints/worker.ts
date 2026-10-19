// Worker local: hace lo que en AWS hacen las integraciones de SQS con Lambda,
// las reglas de EventBridge y EventBridge Scheduler.
import type { Message } from '@aws-sdk/client-sqs';
import { buildDeps, type Deps } from '../app/deps.js';
import { applyNoteWrite, type NoteWriteMessage } from '../domains/notes.js';
import { handleDomainEvent, fireDueReminders } from '../domains/notifications.js';
import { reconcileStreams, processRecording, expireProvisionalRecordings, RetryLater } from '../domains/streams.js';

const deps = buildDeps({ realtime: 'relay' });
let running = true;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Bucle de consumo. Un error deja el mensaje en la cola: SQS lo reintenta y, al tercer fallo, lo manda a la DLQ. */
async function consume(name: string, queueUrl: string, handle: (body: any, m: Message) => Promise<void>, deps: Deps) {
  while (running) {
    let messages: Message[] = [];
    try {
      messages = await deps.queue.receive(queueUrl, 10, 5);
    } catch (e) {
      log(`[${name}] no se pudo leer la cola`, (e as Error).message);
      await sleep(3000);
      continue;
    }
    for (const m of messages) {
      try {
        await handle(JSON.parse(m.Body!), m);
        await deps.queue.ack(queueUrl, m.ReceiptHandle!);
      } catch (e) {
        if (e instanceof RetryLater) {
          log(`[${name}] reintento en 10 s: ${e.message}`);
          await deps.queue.retryIn(queueUrl, m.ReceiptHandle!, 10);
        } else {
          log(`[${name}] error (intento ${m.Attributes?.ApproximateReceiveCount ?? '?'})`, e);
        }
      }
    }
  }
}

function every(name: string, seconds: number, fn: () => Promise<unknown>) {
  const tick = async () => {
    if (!running) return;
    try {
      await fn();
    } catch (e) {
      log(`[${name}] error`, (e as Error).message);
    }
    setTimeout(tick, seconds * 1000);
  };
  setTimeout(tick, 1000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const { resources, scheduler, recordings } = deps.cfg;

void consume('note-writes', resources.noteWritesQueueUrl, async (msg: NoteWriteMessage) => {
  const result = await applyNoteWrite(deps, msg);
  if (result !== 'applied') log(`[note-writes] nota ${msg.noteId} v${msg.version}: ${result}`);
}, deps);

// La regla de EventBridge entrega el evento completo; lo útil va en detail-type y detail
void consume('domain-events', resources.domainEventsQueueUrl, async (evt: { 'detail-type': string; detail: Record<string, unknown> }) => {
  log(`[domain-events] ${evt['detail-type']}`);
  await handleDomainEvent(deps, evt['detail-type'], evt.detail);
}, deps);

void consume('media-jobs', resources.mediaJobsQueueUrl, async (job: { kind: string; streamId: string }) => {
  if (job.kind === 'process-recording') {
    log(`[media-jobs] procesando grabación de ${job.streamId}`);
    await processRecording(deps, job.streamId);
  }
}, deps);

every('streams', 10, () => reconcileStreams(deps));
if (scheduler.mode === 'poll') every('reminders', scheduler.pollSeconds, () => fireDueReminders(deps));
if (recordings.emulateLifecycle) every('s3-lifecycle', 60, () => expireProvisionalRecordings(deps));

log('worker listo');

const stop = async () => {
  running = false;
  await sleep(500);
  await deps.db.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
