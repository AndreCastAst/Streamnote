import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Prueba de punta a punta con dos navegadores y cámara simulada. Requiere la app corriendo.
//   cd e2e && npm install && npx playwright install chromium && npm test
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const shots = fileURLToPath(new URL('./capturas', import.meta.url)); // ruta válida también en Windows
mkdirSync(shots, { recursive: true });
const run = Math.random().toString(36).slice(2, 7);
const step = (m) => console.log(`• ${m}`);

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = () => browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
const ana = await (await ctx()).newPage();
const beto = await (await ctx()).newPage();
for (const [n, p] of [['ana', ana], ['beto', beto]]) {
  p.on('console', (m) => m.type() === 'error' && console.log(`  [${n} console] ${m.text()}`));
  p.on('pageerror', (e) => console.log(`  [${n} pageerror] ${e.message}`));
}

async function login(page, email, name) {
  await page.goto(WEB);
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Nombre').fill(name);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByRole('heading', { name: 'Tus comunidades' }).waitFor();
}

await ana.goto(WEB);
await ana.screenshot({ path: `${shots}/01-login.png` });
await login(ana, `ana.${run}@upao.edu.pe`, 'Ana Torres');
await login(beto, `beto.${run}@upao.edu.pe`, 'Beto Ramírez');
step('dos sesiones iniciadas');

// Ana crea la comunidad
await ana.getByLabel('Nombre', { exact: true }).fill(`Física I ${run}`);
await ana.getByLabel('Descripción').fill('Sección A, ciclo 2026-II');
await ana.getByRole('button', { name: 'Crear comunidad' }).click();
await ana.getByText('Código de invitación:').waitFor();
const code = (await ana.locator('.invite .code').textContent()).trim();
step(`comunidad creada, código ${code}`);

// Beto se une con el código
// Se busca el botón dentro del formulario del código: la lista de comunidades públicas también tiene botones «Unirme»
const joinForm = beto.locator('form').filter({ has: beto.getByRole('textbox', { name: 'Código de invitación' }) });
await joinForm.getByRole('textbox', { name: 'Código de invitación' }).fill(code);
await joinForm.getByRole('button', { name: 'Unirme', exact: true }).click();
await beto.getByRole('tab', { name: 'Miembros' }).waitFor();
step('Beto se unió');

// Lienzo de la nota: Ana acomoda dos módulos lado a lado y Beto los ve en solo lectura
const communityPage = ana.url();
const communityName = `Física I ${run}`;
const noteTitle = `Lienzo ${run}`;
const near = (a, b, tol = 4) => Math.abs(a - b) <= tol;

// Reintenta `fn` hasta que devuelva algo verdadero; si no llega a tiempo, falla con `msg`
async function until(page, fn, msg, timeout = 10000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(msg);
    await page.waitForTimeout(250);
  }
}

// Cajas de la cuadrícula y de los dos módulos de la hoja
async function sheetBoxes(page) {
  const [grid, text, code] = await Promise.all(
    ['.sheet .modules', '.sheet .module-text', '.sheet .module-code'].map((s) => page.locator(s).boundingBox()),
  );
  return { grid, text, code };
}

// Texto a la izquierda y código a la derecha, a la misma altura y a media anchura cada uno
function sideBySide({ grid, text, code }) {
  if (!grid || !text || !code) return false;
  const half = grid.width * 0.6;
  return near(text.y, code.y) && code.x >= text.x + text.width - 1 && text.width < half && code.width < half && near(text.width, code.width, grid.width * 0.1);
}

// Arrastra con el ratón desde el centro de `handle`, pasando por cada desplazamiento de `path` (medidos desde el inicio).
// Con `release` falso no suelta: sirve para mirar la vista previa antes de soltar (luego, `page.mouse.up()`)
async function drag(page, handle, path, release = true) {
  const b = await handle.boundingBox();
  if (!b) throw new Error('el asa no está visible');
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const [dx, dy] of path) await page.mouse.move(x + dx, y + dy, { steps: 12 });
  if (release) await page.mouse.up();
}

// Espera el PUT de la nota cuyo cuerpo cumple `test`. Al soltar, React actualiza el estado de forma
// asíncrona y «Guardado» puede ser aún el del guardado anterior: por eso se espera el PUT concreto
function savedNote(page, test) {
  return page
    .waitForResponse(
      (r) => {
        if (r.request().method() !== 'PUT' || !/\/notes\/[^/]+$/.test(new URL(r.url()).pathname)) return false;
        let body;
        try {
          body = r.request().postDataJSON();
        } catch {
          return false;
        }
        return Boolean(body?.modules && test(body));
      },
      { timeout: 15000 },
    )
    .then((r) => {
      if (!r.ok()) throw new Error(`el guardado de la nota respondió ${r.status()}`);
      return r;
    });
}

// Acomodo guardado de cada tipo de módulo en el cuerpo de un PUT
const layoutsByType = (body) => Object.fromEntries(body.modules.map((m) => [m.type, m.layout]));

// Tres cajas en una misma fila, cada una a un tercio (menos del 40 % de la cuadrícula)
function inThirds(grid, boxes) {
  if (!grid || boxes.some((b) => !b)) return false;
  const [first] = boxes;
  return boxes.every((b) => near(b.y, first.y) && b.width < grid.width * 0.4 && near(b.width, first.width, grid.width * 0.1));
}

// Lleva el borde derecho del módulo a la mitad de la cuadrícula (6 de 12 columnas, con margen de 8 px)
async function toHalfWidth(page, module) {
  const grid = await page.locator('.sheet .modules').boundingBox();
  const target = grid.x + grid.width / 2 - 4;
  await module.hover(); // el asa tiene opacidad 0 hasta pasar el cursor
  const box = await module.boundingBox();
  await drag(page, module.locator('.react-resizable-handle-e'), [[target - (box.x + box.width), 0]]);
  await until(page, async () => near((await module.boundingBox()).width, grid.width / 2 - 4, 3), 'el módulo no quedó a media anchura');
}

await ana.goto(`${WEB}/notas`);
await ana.getByRole('button', { name: 'Nueva nota' }).click();
await ana.locator('.sheet .module-text').waitFor();
await ana.getByLabel('Título de la nota').fill(noteTitle);
await ana.locator('.sheet .add-bar').getByRole('button', { name: 'Código', exact: true }).click();
await ana.locator('.sheet .module-code').waitFor();
const moduleCount = await ana.locator('.sheet .module').count();
if (moduleCount !== 2) throw new Error(`la nota nueva tiene ${moduleCount} módulos y se esperaban 2`);
step('nota nueva con un módulo de texto y uno de código');

const textModule = ana.locator('.sheet .module-text');
const codeNoteModule = ana.locator('.sheet .module-code');
await toHalfWidth(ana, textModule);
await toHalfWidth(ana, codeNoteModule);
step('los dos módulos quedaron a media anchura');

// Al soltar, React actualiza el estado fuera de un evento suyo (de forma asíncrona), así que «Guardado»
// puede ser aún el del guardado anterior: se espera el PUT que lleva el código en la columna 7, arriba
const sideBySideSaved = ana.waitForResponse(
  (r) => {
    if (r.request().method() !== 'PUT' || !/\/notes\/[^/]+$/.test(new URL(r.url()).pathname)) return false;
    let body;
    try {
      body = r.request().postDataJSON();
    } catch {
      return false;
    }
    const l = body?.modules?.find((m) => m.type === 'code')?.layout;
    return l?.x === 6 && l.y === 0 && l.w === 6;
  },
  { timeout: 15000 },
);
{
  const { grid, text, code } = await sheetBoxes(ana);
  const left = grid.x + grid.width / 2 + 4; // borde izquierdo de la columna 7
  await codeNoteModule.hover(); // las herramientas, con el asa ⠿, aparecen al pasar el cursor
  // Primero a la derecha y luego hacia arriba, para no pasar por encima del módulo de texto
  await drag(ana, codeNoteModule.locator('.module-drag'), [[left - code.x, 0], [left - code.x, text.y - code.y]]);
}
await until(ana, async () => sideBySide(await sheetBoxes(ana)), 'el módulo de código no quedó a la derecha del de texto');
const layoutSave = await sideBySideSaved;
if (!layoutSave.ok()) throw new Error(`el guardado del acomodo respondió ${layoutSave.status()}`);
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
step('módulo de código arrastrado junto al de texto; acomodo guardado');

// La escritura pasa por la cola: se recarga hasta que el acomodo guardado vuelva del servidor
let kept = false;
for (let i = 0; i < 10 && !kept; i++) {
  if (i) await ana.waitForTimeout(1000);
  await ana.reload();
  await ana.locator('.sheet .module-code').waitFor();
  await ana.waitForTimeout(500); // deja que se midan los módulos
  kept = sideBySide(await sheetBoxes(ana));
}
if (!kept) throw new Error('tras recargar, los módulos ya no están lado a lado');
await ana.screenshot({ path: `${shots}/01b-lienzo.png` });
step('tras recargar, los módulos siguen lado a lado');

// Reparto de la fila: Ana agrega una lista y la arrastra al tercio derecho del módulo de código. Antes de
// soltar, la vista previa ya muestra la fila repartida a un tercio (el hueco gris es donde caerá la lista)
const listModule = ana.locator('.sheet .module-checklist');
await ana.locator('.sheet .add-bar').getByRole('button', { name: 'Lista', exact: true }).click();
await listModule.waitFor();
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
step('Ana agregó un módulo de lista al final');
{
  const { code } = await sheetBoxes(ana);
  await listModule.hover(); // el asa ⠿ tiene opacidad 0 hasta pasar el cursor
  const handle = await listModule.locator('.module-drag').boundingBox();
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  const to = { x: code.x + code.width * 0.9, y: code.y + code.height / 2 };
  await drag(ana, listModule.locator('.module-drag'), [[to.x - from.x, to.y - from.y]], false);
}
await until(
  ana,
  async () => {
    const { grid, text, code } = await sheetBoxes(ana);
    const [placeholder, list] = await Promise.all([ana.locator('.sheet .react-grid-placeholder').boundingBox(), listModule.boundingBox()]);
    return inThirds(grid, [text, code, placeholder]) && list && list.width < grid.width * 0.4 && placeholder.x >= code.x + code.width - 1;
  },
  'antes de soltar, la vista previa no muestra la fila repartida a un tercio',
);
await ana.screenshot({ path: `${shots}/01e-lienzo-vista-previa.png` });
step('antes de soltar, la vista previa muestra texto, código y lista a un tercio');
const thirdsSaved = savedNote(ana, (body) => {
  const l = layoutsByType(body);
  return [l.text, l.code, l.checklist].every((x) => x && x.y === l.text.y && x.w === 4) && l.text.x === 0 && l.code.x === 4 && l.checklist.x === 8;
});
await ana.mouse.up();
await thirdsSaved;
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
step('al soltar se guardó la fila repartida a un tercio');

const thirdsNow = async () => {
  const { grid, text, code } = await sheetBoxes(ana);
  return inThirds(grid, [text, code, await listModule.boundingBox()]);
};
let thirdsKept = false;
for (let i = 0; i < 10 && !thirdsKept; i++) {
  if (i) await ana.waitForTimeout(1000);
  await ana.reload();
  await listModule.waitFor();
  await ana.waitForTimeout(500); // deja que se midan los módulos
  thirdsKept = await thirdsNow();
}
if (!thirdsKept) throw new Error('tras recargar, la fila ya no está repartida a un tercio');
step('tras recargar, texto, código y lista siguen en una fila a un tercio');

// Sacar la lista de la fila repartida, soltándola debajo de todo: texto y código vuelven a la mitad
const halvesSaved = savedNote(ana, (body) => {
  const l = layoutsByType(body);
  return l.text?.w === 6 && l.code?.w === 6 && l.text.y === l.code.y && l.checklist?.y > l.text.y;
});
{
  const grid = await ana.locator('.sheet .modules').boundingBox();
  await listModule.hover();
  const handle = await listModule.locator('.module-drag').boundingBox();
  await drag(ana, listModule.locator('.module-drag'), [[0, grid.y + grid.height + 3 * 24 - (handle.y + handle.height / 2)]]);
}
await halvesSaved;
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
await until(ana, async () => sideBySide(await sheetBoxes(ana)), 'al sacar la lista de la fila, texto y código no volvieron a la mitad');
step('al sacar la lista de la fila, texto y código vuelven a la mitad');

// Se elimina la lista para que el resto del bloque siga con dos módulos
await listModule.hover();
await listModule.getByRole('button', { name: 'Eliminar módulo' }).click();
await until(ana, async () => (await ana.locator('.sheet .module').count()) === 2, 'la lista no se eliminó');
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
step('lista eliminada; quedan el texto y el código');

// El alto que guarda el autor es un mínimo: el módulo crece con el texto, sin desplazamiento interno
const heightBefore = (await textModule.boundingBox()).height;
const textArea = ana.locator('.sheet textarea.in-text');
await textArea.fill(Array.from({ length: 8 }, (_, i) => `Línea ${i + 1}: aceleración constante`).join('\n'));
await until(ana, async () => (await textModule.boundingBox()).height > heightBefore + 48, 'el módulo de texto no creció al escribir varias líneas');
const scroll = await textArea.evaluate((t) => ({ scroll: t.scrollHeight, client: t.clientHeight }));
if (scroll.scroll > scroll.client + 1) throw new Error(`el textarea tiene desplazamiento interno (${scroll.scroll} > ${scroll.client})`);
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
step(`el módulo de texto creció de ${Math.round(heightBefore)} a ${Math.round((await textModule.boundingBox()).height)} px sin barra de desplazamiento`);

// Alto libre: agrandado con el asa inferior por encima del contenido, se conserva aunque se borre texto
const resizeHeight = async (dy) => {
  await textModule.hover(); // las asas tienen opacidad 0 hasta pasar el cursor
  await drag(ana, textModule.locator('.react-resizable-handle-s'), [[0, dy]]);
};
const textHeight = async () => (await textModule.boundingBox()).height;
{
  const rowsBefore = Math.round((await textHeight()) / 24);
  const tallSaved = savedNote(ana, (body) => layoutsByType(body).text?.h >= rowsBefore + 3);
  await resizeHeight(4 * 24);
  await tallSaved;
}
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
const tallHeight = await textHeight();
const oneLineSaved = savedNote(ana, (body) => body.modules.find((m) => m.type === 'text')?.content?.text === 'Línea 1');
await textArea.fill('Línea 1');
await oneLineSaved;
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
await ana.waitForTimeout(500); // deja que se vuelva a medir el módulo
if (!near(await textHeight(), tallHeight, 4)) throw new Error(`el alto libre no se conservó al borrar texto (${Math.round(await textHeight())} y se esperaban ${Math.round(tallHeight)} px)`);
step(`el alto libre de ${Math.round(tallHeight)} px se conserva al dejar una sola línea`);

// Achicado con el asa hasta el tope del contenido, el módulo vuelve a seguir a su texto y se encoge al borrarlo
{
  const shortSaved = savedNote(ana, (body) => layoutsByType(body).text?.h <= 3);
  await resizeHeight(-tallHeight);
  await shortSaved;
}
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
await ana.waitForTimeout(500);
const minHeight = await textHeight();
if (minHeight >= tallHeight - 48) throw new Error(`el asa no achicó el módulo de texto (${Math.round(minHeight)} px)`);
await textArea.fill(Array.from({ length: 6 }, (_, i) => `Línea ${i + 1}`).join('\n'));
await until(ana, async () => (await textHeight()) > minHeight + 48, 'el módulo de texto no creció al volver a escribir varias líneas');
const multiHeight = await textHeight();
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
await textArea.fill('Línea 1');
await until(ana, async () => near(await textHeight(), minHeight, 4), 'el módulo de texto no se encogió al borrar las líneas');
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
step(`achicado hasta el tope, el módulo sigue a su texto: ${Math.round(multiHeight)} px con varias líneas y ${Math.round(await textHeight())} px con una`);

// Pantalla angosta: una columna en orden de lectura y sin asas de redimensionar
await ana.setViewportSize({ width: 390, height: 844 });
await until(
  ana,
  async () => {
    const { text, code } = await sheetBoxes(ana);
    return text && code && near(text.x, code.x, 1) && text.y + text.height <= code.y + 1;
  },
  'a 390 px los módulos no quedaron en una columna en orden de lectura',
);
const narrowHandles = await ana.locator('.sheet .react-resizable-handle:visible').count();
if (narrowHandles) throw new Error(`a 390 px hay ${narrowHandles} asas de redimensionar visibles`);
await ana.screenshot({ path: `${shots}/01c-lienzo-angosto.png` });
step('a 390 px los módulos se apilan en una columna, sin asas de redimensionar');

// De vuelta en escritorio, el acomodo sigue igual: pasar a angosta no lo cambió
await ana.setViewportSize({ width: 1440, height: 900 });
await until(ana, async () => sideBySide(await sheetBoxes(ana)), 'al volver a 1440 px se perdió el acomodo de escritorio');

// Ana comparte la nota con la comunidad desde «Compartir con»
const noteUrl = ana.url();
const shareBox = ana.getByRole('checkbox', { name: communityName, exact: true });
await shareBox.click();
await until(ana, () => shareBox.isChecked(), 'la nota no quedó compartida con la comunidad');
step('Ana compartió la nota con la comunidad');

// Beto la abre desde «Apuntes compartidos»: mismo acomodo, en solo lectura
await beto.goto(communityPage);
await beto.getByRole('tab', { name: 'Apuntes compartidos' }).click();
await beto.locator('a.row-link').filter({ hasText: noteTitle }).click();
await beto.waitForURL(noteUrl);
await beto.locator('.sheet.readonly').waitFor();
await beto.locator('.sheet .module-code').waitFor();
const head = (await beto.locator('.sheet .save-status').textContent()) ?? '';
if (!head.includes('Solo lectura')) throw new Error(`el encabezado de la nota no dice «Solo lectura»: ${head}`);
await until(beto, async () => sideBySide(await sheetBoxes(beto)), 'Beto no ve los módulos lado a lado como los acomodó Ana');
const readonlyHandles = await beto.locator('.sheet .react-resizable-handle:visible').count();
const readonlyDrag = await beto.locator('.sheet .module-drag').count();
const readonlyFields = await beto.locator('.sheet textarea, .sheet input').count();
if (readonlyHandles || readonlyDrag || readonlyFields)
  throw new Error(`la nota ajena se puede tocar: ${readonlyHandles} asas, ${readonlyDrag} asas ⠿, ${readonlyFields} campos`);
await beto.locator('.sheet .module').first().click();
await beto.locator('.sheet [role=status]').filter({ hasText: 'Solo lectura' }).waitFor({ timeout: 3000 });
await beto.screenshot({ path: `${shots}/01d-lienzo-solo-lectura.png` });
step('Beto ve la nota de Ana con el mismo acomodo, en solo lectura, y el aviso al tocarla');

// Todo vuelve a como lo espera el bloque del directo
await beto.goto(communityPage);
await beto.getByRole('tab', { name: 'Miembros' }).waitFor();
await ana.setViewportSize({ width: 1440, height: 900 });
await ana.goto(communityPage);

// Ana inicia el directo y comparte la cámara
await ana.reload();
await ana.getByLabel('Tema de la sesión').fill('Cinemática: MRUV');
await ana.screenshot({ path: `${shots}/02-comunidad.png` });
await ana.getByRole('button', { name: 'Iniciar directo' }).click();
await ana.getByRole('button', { name: 'Compartir cámara' }).click();
await ana.locator('.stage-state.live').waitFor({ timeout: 20000 });
const liveUrl = ana.url();
step('Ana está emitiendo por WHIP');

// Beto recibe el aviso y entra
await beto.locator('.toast').filter({ hasText: 'está en vivo' }).waitFor({ timeout: 20000 });
step('Beto recibió el aviso en vivo');
await beto.locator('.toast').click();
await beto.getByText('Viendo en directo').waitFor({ timeout: 30000 });
await beto.waitForFunction(() => document.querySelector('.stage video')?.videoWidth >= 160, null, { timeout: 30000 });
const size = await beto.locator('.stage video').evaluate((v) => ({ w: v.videoWidth, h: v.videoHeight }));
step(`Beto ve el video por WHEP (${size.w}×${size.h})`);
if (!size.w) throw new Error('el video no tiene dimensiones');
await beto.waitForTimeout(2000);
const luma = await beto.locator('.stage video').evaluate((v) => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 36;
  const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data; let s = 0;
  for (let i = 0; i < d.length; i += 4) s += d[i + 1];
  return Math.round(s / (d.length / 4));
});
step(`brillo medio (canal verde) del video recibido: ${luma}`);
if (luma < 20) throw new Error('el video recibido está en negro');

// Ana escribe en su nota y comparte un módulo
await ana.locator('.live-note textarea.in-text').first().fill('Ecuación clave: x = x₀ + v₀t + ½at²');
await ana.locator('.live-note .add-bar').getByRole('button', { name: 'Código' }).click();
await ana.locator('.live-note .in-code textarea').fill('def posicion(x0, v0, a, t):\n    return x0 + v0*t + 0.5*a*t**2');
await ana.locator('.live-note .save-status.saved').waitFor({ timeout: 10000 });
step('autoguardado de Ana confirmado');
const codeModule = ana.locator('.live-note .module-code');
await codeModule.hover();
await codeModule.getByRole('button', { name: 'Compartir en el directo' }).click();
await codeModule.getByRole('button', { name: 'Compartido' }).waitFor();

// Beto lo recibe y lo agrega a su nota
const item = beto.locator('.shared-item').filter({ hasText: 'posicion' });
await item.waitFor({ timeout: 10000 });
await item.getByRole('button', { name: 'Agregar a mi nota' }).click();
await beto.locator('.live-note .module.borrowed .highlight-tag', { hasText: 'de Ana Torres' }).waitFor();
await beto.locator('.live-note .save-status.saved').waitFor({ timeout: 10000 });
step('Beto agregó el módulo de Ana a su nota (queda marcado con resaltador)');

// Chat
await beto.getByLabel('Mensaje').fill('¿La aceleración es constante?');
await beto.getByRole('button', { name: 'Enviar' }).click();
await ana.locator('.chat li', { hasText: 'aceleración' }).waitFor();
step('el chat llegó a Ana');
await beto.waitForTimeout(1500);
await ana.screenshot({ path: `${shots}/03-directo-anfitriona.png` });
await beto.screenshot({ path: `${shots}/04-directo-espectador.png` });

// Ana termina; la grabación se procesa
await ana.waitForTimeout(4000);
await ana.getByRole('button', { name: 'Terminar directo' }).click();
await beto.getByText('El directo terminó.').waitFor({ timeout: 15000 });
step('directo terminado; Beto lo vio en tiempo real');

const communityUrl = await ana.locator('.live-head a').getAttribute('href');
await ana.goto(`${WEB}${communityUrl}`);
const rec = ana.locator('.recording').first();
for (let i = 0; i < 40 && !(await rec.count()); i++) {
  await ana.waitForTimeout(2000);
  await ana.reload();
}
await rec.waitFor({ timeout: 5000 });
step(`grabación lista: ${(await rec.locator('.rec-state').textContent()).trim()}`);

// Beto, como miembro, solo puede pedir que se conserve
await beto.goto(`${WEB}${communityUrl}`);
await beto.getByRole('button', { name: 'Pedir que se conserve' }).click();
await ana.locator('.toast').filter({ hasText: 'pide conservar' }).waitFor({ timeout: 15000 });
step('Ana recibió la solicitud de conservar');
await rec.getByRole('button', { name: 'Ver' }).click();
await ana.waitForTimeout(2500);
const dur = await rec.locator('video').evaluate((v) => v.duration);
step(`el MP4 de S3 se reproduce (${dur.toFixed(1)} s)`);
await ana.screenshot({ path: `${shots}/05-grabacion.png` });
await rec.getByRole('button', { name: 'Conservar' }).click();
await rec.locator('.rec-state.kept').waitFor();
step(`conservada: ${(await rec.locator('.rec-state').textContent()).trim()}`);

// La nota de Beto en "Mis notas"
await beto.goto(`${WEB}/notas`);
await beto.getByText('tomada en un directo').first().click();
await beto.locator('.sheet .highlight-tag').first().waitFor();
await beto.screenshot({ path: `${shots}/06-nota-beto.png` });
step('la nota del directo quedó en Mis notas de Beto');

console.log(`\nE2E completo. Sala: ${liveUrl}`);
await browser.close();
