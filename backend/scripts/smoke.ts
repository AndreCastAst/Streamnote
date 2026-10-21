// Prueba de humo de la API completa (sin video). Requiere API, worker, PostgreSQL y moto en marcha.
//   npm run smoke            (API en http://localhost:4000)
//   API_URL=http://... npm run smoke
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const API = process.env.API_URL ?? 'http://localhost:4000';
let failures = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? '✔' : '✘'} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function until<T>(fn: () => Promise<T>, check: (v: T) => boolean, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!check(v) && Date.now() < end) {
    await sleep(300);
    v = await fn();
  }
  return v;
}

async function login(email: string, name: string) {
  const r = await call(null, 'POST', '/auth/dev-login', { email, name });
  return r.body as { token: string; user: { id: string } };
}

const run = randomUUID().slice(0, 6);
const ana = await login(`ana-${run}@upao.edu.pe`, 'Ana Docente');
const beto = await login(`beto-${run}@upao.edu.pe`, 'Beto Alumno');
ok(ana.token && beto.token, 'inicio de sesión local de dos usuarios');
ok((await call(null, 'GET', '/communities')).status === 401, 'sin token → 401');

// Tiempo real de Beto
const inbox: any[] = [];
const ws = new WebSocket(`${API.replace('http', 'ws')}/ws?token=${beto.token}`);
ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
await new Promise((r) => ws.on('open', r));

// ---- Comunidades y permisos ----
const c = (await call(ana.token, 'POST', '/communities', { name: `Cálculo II ${run}`, visibility: 'private' })).body;
ok(c.id && c.invite_code, 'Ana crea una comunidad privada');
ok((await call(beto.token, 'POST', `/communities/${c.id}/join`)).status === 403, 'una privada no admite unirse sin código');
ok((await call(beto.token, 'GET', `/communities/${c.id}`)).status === 403, 'Beto no ve la comunidad privada');
ok((await call(beto.token, 'POST', '/communities/join-by-code', { code: c.invite_code })).status === 200, 'Beto se une con el código');
const detail = (await call(beto.token, 'GET', `/communities/${c.id}`)).body;
ok(detail.members.length === 2 && detail.inviteCode === undefined, 'Beto ve a los miembros pero no el código de invitación');

ok((await call(beto.token, 'POST', `/communities/${c.id}/streams`, { title: 'Repaso' })).status === 403, 'Beto no puede transmitir sin permiso');
ok((await call(beto.token, 'POST', `/communities/${c.id}/stream-permission-requests`)).status === 202, 'Beto pide permiso para transmitir');
const anaNotes = await until(() => call(ana.token, 'GET', '/notifications'), (r) => r.body.some((n: any) => n.type === 'StreamPermissionRequested'));
ok(anaNotes.body.some((n: any) => n.type === 'StreamPermissionRequested'), 'Ana recibe la solicitud (EventBridge → SQS → worker → DynamoDB)');
ok((await call(beto.token, 'PATCH', `/communities/${c.id}/members/${beto.user.id}`, { canStream: true })).status === 403, 'Beto no puede darse permiso a sí mismo');
const granted = await call(ana.token, 'PATCH', `/communities/${c.id}/members/${beto.user.id}`, { canStream: true });
ok(granted.body.can_stream === true, 'Ana le da permiso para transmitir');
await until(async () => inbox, (m) => m.some((x) => x.data?.type === 'MemberPermissionsChanged'));
ok(inbox.some((x) => x.type === 'notification' && x.data.type === 'MemberPermissionsChanged'), 'Beto recibe el aviso en tiempo real por WebSocket');

// ---- Notas modulares con autoguardado por cola ----
const note = (await call(beto.token, 'POST', '/notes', { title: 'Integrales' })).body;
const modules = [
  { id: randomUUID(), type: 'heading', content: { text: 'Integración por partes', level: 1 } },
  { id: randomUUID(), type: 'text', content: { text: '∫u dv = uv − ∫v du' } },
  { id: randomUUID(), type: 'checklist', content: { items: [{ text: 'Ejercicio 3', done: false }] } },
];
const save = await call(beto.token, 'PUT', `/notes/${note.id}`, { opId: randomUUID(), version: 3, title: 'Integrales', modules });
ok(save.status === 202, 'autoguardado responde 202 de inmediato');
const saved = await until(() => call(beto.token, 'GET', `/notes/${note.id}`), (r) => r.body.version === 3);
ok(saved.body.version === 3 && saved.body.modules.length === 3, 'el worker aplicó la versión 3 con 3 módulos');
const dupOp = randomUUID();
await call(beto.token, 'PUT', `/notes/${note.id}`, { opId: dupOp, version: 2, title: 'VIEJA', modules: [] });
await sleep(1500);
ok((await call(beto.token, 'GET', `/notes/${note.id}`)).body.title === 'Integrales', 'una versión vieja que llega tarde se descarta');
await call(beto.token, 'PUT', `/notes/${note.id}`, { opId: dupOp, version: 9, title: 'DUPLICADA', modules: [] });
await sleep(1500);
ok((await call(beto.token, 'GET', `/notes/${note.id}`)).body.title === 'Integrales', 'un opId repetido no se aplica dos veces');
ok((await call(ana.token, 'GET', `/notes/${note.id}`)).status === 403, 'Ana no ve la nota antes de compartirla');
ok((await call(ana.token, 'PUT', `/notes/${note.id}`, { opId: randomUUID(), version: 10, title: 'x', modules: [] })).status === 403, 'Ana no puede editar la nota de Beto');
await call(beto.token, 'POST', `/notes/${note.id}/shares`, { communityId: c.id });
const shared = (await call(ana.token, 'GET', `/communities/${c.id}/notes`)).body;
ok(shared.length === 1 && shared[0].modules === 3, 'la nota aparece en la comunidad');
const view = (await call(ana.token, 'GET', `/notes/${note.id}`)).body;
ok(view.canEdit === false && view.modules.length === 3, 'Ana la lee sin poder editarla');
const copy = (await call(ana.token, 'POST', `/notes/${note.id}/copy`)).body;
const copied = (await call(ana.token, 'GET', `/notes/${copy.id}`)).body;
ok(copied.canEdit && copied.modules[1].sourceAuthor === 'Beto Alumno', 'Ana copia la nota; cada módulo recuerda su autor');

// Acomodo en cuadrícula (lienzo): x, y, w, h por módulo, en unidades de la cuadrícula de 12 columnas
const sameLayout = (a: any, b: any) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const ids = (ms: any[]) => ms.map((m) => m.id).join(',');
const canvas = (
  await call(beto.token, 'POST', '/notes', {
    title: 'Lienzo',
    modules: [
      { id: randomUUID(), type: 'heading', content: { text: 'Lienzo', level: 1 } },
      { id: randomUUID(), type: 'code', content: { code: 'x = 1', language: 'python' } },
    ],
  })
).body;
const canvas1 = (await call(beto.token, 'GET', `/notes/${canvas.id}`)).body;
ok(
  canvas1.modules.length === 2 && canvas1.modules.every((m: any) => m.layout && m.layout.x === 0 && m.layout.w === 12),
  'una nota creada sin acomodo trae layout a ancho completo en cada módulo',
);
const [ma, mb, mc] = [
  { id: randomUUID(), type: 'heading', content: { text: 'Izquierda', level: 2 }, layout: { x: 0, y: 0, w: 6, h: 2 } },
  { id: randomUUID(), type: 'text', content: { text: 'Derecha' }, layout: { x: 6, y: 0, w: 6, h: 4 } },
  { id: randomUUID(), type: 'checklist', content: { items: [{ text: 'Abajo', done: false }] }, layout: { x: 0, y: 4, w: 12, h: 3 } },
];
await call(beto.token, 'PUT', `/notes/${canvas.id}`, { opId: randomUUID(), version: 2, title: 'Lienzo', modules: [ma, mb, mc] });
const canvas2 = (await until(() => call(beto.token, 'GET', `/notes/${canvas.id}`), (r) => r.body.version === 2)).body;
ok(
  canvas2.version === 2 && ids(canvas2.modules) === ids([ma, mb, mc]) && [ma, mb, mc].every((m, i) => sameLayout(canvas2.modules[i].layout, m.layout)),
  'el acomodo se guarda tal cual y los módulos vuelven en orden de lectura',
);
await call(beto.token, 'PUT', `/notes/${canvas.id}`, { opId: randomUUID(), version: 3, title: 'Lienzo', modules: [mc, mb, ma] });
const canvas3 = (await until(() => call(beto.token, 'GET', `/notes/${canvas.id}`), (r) => r.body.version === 3)).body;
ok(canvas3.version === 3 && ids(canvas3.modules) === ids([ma, mb, mc]), 'módulos enviados en desorden se guardan en orden de lectura (y, x)');
const outside = await call(beto.token, 'PUT', `/notes/${canvas.id}`, {
  opId: randomUUID(),
  version: 4,
  title: 'Lienzo',
  modules: [{ ...ma, layout: { x: 8, y: 0, w: 6, h: 2 } }],
});
await sleep(1500);
ok(
  outside.status === 400 && (await call(beto.token, 'GET', `/notes/${canvas.id}`)).body.version === 3,
  'un módulo que se sale de la cuadrícula se rechaza con 400 y no cambia la versión',
);
const md = { id: randomUUID(), type: 'quote', content: { text: 'Sin acomodo' } };
await call(beto.token, 'PUT', `/notes/${canvas.id}`, { opId: randomUUID(), version: 4, title: 'Lienzo', modules: [ma, md, mb, mc] });
const canvas4 = (await until(() => call(beto.token, 'GET', `/notes/${canvas.id}`), (r) => r.body.version === 4)).body;
const last = canvas4.modules?.[3];
const bottom = Math.max(...[ma, mb, mc].map((m) => m.layout.y + m.layout.h));
ok(
  canvas4.version === 4 && canvas4.modules.length === 4 && last?.id === md.id && last.layout.x === 0 && last.layout.w === 12 && last.layout.y === bottom,
  'un módulo sin acomodo entre otros con acomodo queda al final a ancho completo',
);
const canvasCopy = (await call(beto.token, 'POST', `/notes/${canvas.id}/copy`)).body;
const canvasCopied = (await call(beto.token, 'GET', `/notes/${canvasCopy.id}`)).body;
ok(
  canvasCopied.modules?.length === 4 && canvas4.modules.every((m: any, i: number) => sameLayout(canvasCopied.modules[i].layout, m.layout)),
  'la copia conserva el acomodo de cada módulo',
);

// ---- Carpetas ----
const files = async (token: string) => (await call(token, 'GET', '/files')).body as { folders: any[]; items: any[] };
const calc = (await call(beto.token, 'POST', '/folders', { name: 'Cálculo' })).body;
const p1 = (await call(beto.token, 'POST', '/folders', { name: 'Parcial 1', parentId: calc.id })).body;
const tree1 = await files(beto.token);
ok(
  tree1.folders.some((f) => f.id === calc.id && f.parentId === null && f.kind === 'user') && tree1.folders.some((f) => f.id === p1.id && f.parentId === calc.id),
  'Beto crea «Cálculo» y dentro «Parcial 1»',
);
ok((await call(beto.token, 'POST', '/folders', { name: 'cálculo' })).status === 409, 'otra «cálculo» en la raíz (sin distinguir mayúsculas) → 409');
ok((await call(beto.token, 'PATCH', `/folders/${calc.id}`, { parentId: p1.id })).status === 400, 'no se puede mover una carpeta dentro de su descendiente');
const inP1 = (await call(beto.token, 'POST', '/notes', { title: 'Límites', folderId: p1.id })).body;
ok((await files(beto.token)).items.some((i) => i.id === inP1.id && i.kind === 'note' && i.folderId === p1.id), 'una nota creada con folderId queda en esa carpeta');
const versionBefore = (await call(beto.token, 'GET', `/notes/${inP1.id}`)).body.version;
const movedNote = await call(beto.token, 'PATCH', `/notes/${inP1.id}`, { folderId: null });
const versionAfter = (await call(beto.token, 'GET', `/notes/${inP1.id}`)).body.version;
ok(
  movedNote.status === 200 && (await files(beto.token)).items.some((i) => i.id === inP1.id && i.folderId === null) && versionAfter === versionBefore,
  'mover la nota a la raíz no cambia su versión',
);
ok((await call(ana.token, 'POST', '/notes', { title: 'Intrusa', folderId: p1.id })).status === 404, 'Ana no puede crear notas en una carpeta de Beto');
ok(!(await files(ana.token)).folders.some((f) => f.id === calc.id || f.id === p1.id), 'Ana no ve las carpetas de Beto');
await call(beto.token, 'POST', '/notes', { title: 'Derivadas', folderId: calc.id });
await call(beto.token, 'POST', '/notes', { title: 'Ejercicio 1', folderId: p1.id });
await call(beto.token, 'POST', '/notes', { title: 'Ejercicio 2', folderId: p1.id });
ok((await call(beto.token, 'DELETE', `/folders/${calc.id}`)).status === 409, 'una carpeta con contenido no se puede eliminar');
const emptiedCalc = await call(beto.token, 'POST', `/folders/${calc.id}/empty`);
ok(
  emptiedCalc.body?.deleted === 1 && (await files(beto.token)).items.filter((i) => i.folderId === p1.id).length === 2,
  'vaciar «Cálculo» borra solo su nota directa; las de «Parcial 1» siguen',
);
ok((await call(beto.token, 'POST', `/folders/${p1.id}/empty`)).body?.deleted === 2, 'vaciar «Parcial 1» borra sus dos notas');
ok((await call(beto.token, 'DELETE', `/folders/${p1.id}`)).status === 200, 'se elimina «Parcial 1» ya vacía');
ok((await call(beto.token, 'DELETE', `/folders/${calc.id}`)).status === 200, 'se elimina «Cálculo» aunque una nota borrada la referenciaba');
ok(!(await files(beto.token)).folders.some((f) => f.id === calc.id || f.id === p1.id), 'las carpetas eliminadas ya no aparecen');

// ---- Directo: módulos compartidos y chat ----
const stream = (await call(beto.token, 'POST', `/communities/${c.id}/streams`, { title: 'Repaso de integrales' })).body;
ok(stream.id, 'Beto inicia un directo con el permiso concedido');
const liveNote = (await call(beto.token, 'POST', '/notes', { title: 'Apuntes del directo', streamId: stream.id })).body;
const liveTree = await files(beto.token);
const commFolder = liveTree.folders.find((f) => f.id === liveTree.items.find((i) => i.id === liveNote.id)?.folderId);
const directosFolder = liveTree.folders.find((f) => f.id === commFolder?.parentId);
ok(
  commFolder?.kind === 'community' && commFolder.communityId === c.id && directosFolder?.kind === 'directos' && directosFolder.parentId === null,
  'la nota del directo queda en «Directos / [comunidad]»',
);
const liveView = (await call(beto.token, 'GET', `/notes/${liveNote.id}`)).body;
ok(liveView.community?.id === c.id && liveView.isOwner === true && liveView.canEdit === true, 'la nota del directo queda vinculada a la comunidad');
ok((await call(ana.token, 'GET', `/notes/${liveNote.id}`)).body.canEdit === false, 'Ana (miembro) lee la nota vinculada sin poder editarla');
const linked = (await call(ana.token, 'GET', `/communities/${c.id}/notes`)).body;
ok(linked.some((n: any) => n.id === liveNote.id && n.stream?.id === stream.id && n.locked === false), 'la nota vinculada aparece en la comunidad con su directo');
ok((await call(beto.token, 'POST', '/notes', { title: 'Sin directo', streamId: randomUUID() })).status === 404, 'una nota para un directo inexistente → 404');
ok((await call(beto.token, 'POST', `/communities/${c.id}/streams`, { title: 'Otro' })).status === 409, 'no puede abrir dos directos a la vez');
const sAna = (await call(ana.token, 'GET', `/streams/${stream.id}`)).body;
const sBeto = (await call(beto.token, 'GET', `/streams/${stream.id}`)).body;
ok(sBeto.publishUrl && !sAna.publishUrl && sAna.playback.webrtc, 'solo el anfitrión recibe URL de emisión; Ana recibe URL de reproducción');

const pathName = new URL(sBeto.publishUrl).pathname.split('/')[1];
const pubToken = new URL(sBeto.publishUrl).searchParams.get('token');
const readToken = new URL(sAna.playback.webrtc).searchParams.get('token');
const auth = (action: string, token: string | null, path = pathName) =>
  call(null, 'POST', '/internal/media/auth', { action, path, query: token ? `token=${token}` : '' });
ok((await auth('publish', pubToken)).status === 200, 'el servidor de video deja emitir con el token del anfitrión');
ok((await auth('publish', readToken)).status === 401, 'un token de espectador no permite emitir');
ok((await auth('read', readToken)).status === 200, 'el token de espectador permite ver');
ok((await auth('read', readToken, 's_00000000000000000000000000000000')).status === 401, 'un token no sirve para otro directo');
ok((await auth('read', null)).status === 401, 'sin token no se puede ver');

ws.send(JSON.stringify({ type: 'subscribe', channel: `stream:${stream.id}` }));
await until(async () => inbox, (m) => m.some((x) => x.type === 'subscribed'));
const mod = await call(ana.token, 'POST', `/streams/${stream.id}/modules`, { type: 'code', content: { code: 'print(42)', language: 'python' } });
ok(mod.status === 201, 'Ana comparte un módulo en el directo');
await until(async () => inbox, (m) => m.some((x) => x.type === 'module.shared'));
ok(inbox.some((x) => x.type === 'module.shared' && x.data.sharedBy.name === 'Ana Docente'), 'Beto recibe el módulo en tiempo real');
await call(ana.token, 'POST', `/streams/${stream.id}/chat`, { text: '¿Se ve bien?' });
await until(async () => inbox, (m) => m.some((x) => x.type === 'chat.message'));
ok(inbox.some((x) => x.type === 'chat.message'), 'el chat llega en tiempo real');
ok((await call(ana.token, 'GET', `/streams/${stream.id}/modules`)).body.length === 1, 'los módulos compartidos quedan en la sesión');
ok((await call(beto.token, 'POST', `/notes/${liveNote.id}/unlink`)).status === 409, 'no se puede desligar la nota con el directo en vivo');
ok((await call(beto.token, 'POST', `/streams/${stream.id}/end`)).status === 200, 'Beto termina el directo');
ok((await auth('publish', pubToken)).status === 401, 'tras terminar ya no se puede volver a emitir');
const early = await call(beto.token, 'POST', `/notes/${liveNote.id}/unlink`, { version: liveView.version + 5 });
ok(early.status === 409 && !(await files(beto.token)).items.some((i) => i.locked), 'desligar con una versión aún sin guardar → 409 y no crea copia');
const unlinked = await call(beto.token, 'POST', `/notes/${liveNote.id}/unlink`, { version: liveView.version });
ok(unlinked.status === 200 && unlinked.body.frozenId, 'Beto desliga la nota tras el directo');
const frozenId = unlinked.body.frozenId;
ok((await call(beto.token, 'GET', `/notes/${liveNote.id}`)).body.community === null, 'la original queda sin vínculo');
ok((await call(ana.token, 'GET', `/notes/${liveNote.id}`)).status === 403, 'Ana ya no puede leer la original');
ok((await call(ana.token, 'GET', `/notes/${frozenId}`)).body.canEdit === false, 'Ana lee la copia congelada');
const frozen = (await call(beto.token, 'GET', `/notes/${frozenId}`)).body;
ok(
  frozen.canEdit === false && frozen.isOwner === true && frozen.locked === true && frozen.folderId === commFolder?.id,
  'Beto ve su copia congelada en solo lectura, en «Directos / [comunidad]»',
);
ok(
  (await call(beto.token, 'PUT', `/notes/${frozenId}`, { opId: randomUUID(), version: frozen.version + 1, title: 'Cambio', modules: [] })).status === 409,
  'ni el autor puede editar la copia congelada',
);
const afterUnlink = (await call(ana.token, 'GET', `/communities/${c.id}/notes`)).body;
ok(
  afterUnlink.some((n: any) => n.id === frozenId && n.locked === true) && !afterUnlink.some((n: any) => n.id === liveNote.id),
  'la comunidad ve la copia congelada y ya no la original',
);

// ---- Recordatorios ----
const rem = await call(beto.token, 'POST', '/reminders', { title: 'Repasar integrales', fireAt: new Date(Date.now() + 2000).toISOString() });
ok(rem.status === 201, 'Beto crea un recordatorio para dentro de 2 s');
await until(async () => inbox, (m) => m.some((x) => x.data?.type === 'ReminderDue'), 30000);
ok(inbox.some((x) => x.data?.type === 'ReminderDue'), 'el recordatorio llega como notificación');

// ---- Validaciones ----
ok((await call(beto.token, 'POST', '/communities', { name: 'x', visibility: 'public' })).status === 400, 'un nombre muy corto se rechaza con 400');
ok((await call(beto.token, 'GET', '/notes/no-es-uuid')).status === 404, 'un id mal formado responde 404');

ws.close();
console.log(failures ? `\n${failures} comprobación(es) fallaron` : '\nTodo en orden');
process.exit(failures ? 1 : 0);
