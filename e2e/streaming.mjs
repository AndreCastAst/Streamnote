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
