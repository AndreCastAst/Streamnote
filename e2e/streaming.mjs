import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

// Prueba de punta a punta con dos navegadores y cámara simulada. Requiere la app corriendo.
//   cd e2e && npm install && npx playwright install chromium && npm test
const WEB = process.env.WEB_URL ?? 'http://localhost:5173';
const shots = new URL('./capturas', import.meta.url).pathname;
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
await beto.getByRole('textbox', { name: 'Código de invitación' }).fill(code);
await beto.getByRole('button', { name: 'Unirme', exact: true }).click();
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

// Arrastra con el ratón desde el centro de `handle`, pasando por cada desplazamiento de `path` (medidos desde el inicio)
async function drag(page, handle, path) {
  const b = await handle.boundingBox();
  if (!b) throw new Error('el asa no está visible');
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (const [dx, dy] of path) await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
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

// El alto que guarda el autor es un mínimo: el módulo crece con el texto, sin desplazamiento interno
const heightBefore = (await textModule.boundingBox()).height;
const textArea = ana.locator('.sheet textarea.in-text');
await textArea.fill(Array.from({ length: 8 }, (_, i) => `Línea ${i + 1}: aceleración constante`).join('\n'));
await until(ana, async () => (await textModule.boundingBox()).height > heightBefore + 48, 'el módulo de texto no creció al escribir varias líneas');
const scroll = await textArea.evaluate((t) => ({ scroll: t.scrollHeight, client: t.clientHeight }));
if (scroll.scroll > scroll.client + 1) throw new Error(`el textarea tiene desplazamiento interno (${scroll.scroll} > ${scroll.client})`);
await ana.locator('.sheet .save-status.saved').waitFor({ timeout: 10000 });
step(`el módulo de texto creció de ${Math.round(heightBefore)} a ${Math.round((await textModule.boundingBox()).height)} px sin barra de desplazamiento`);

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
