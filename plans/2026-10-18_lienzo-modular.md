# Plan 1: Lienzo modular para las notas

Primer plan de tres. Los otros dos (explorador de archivos con carpetas anidadas y tablero compartido en el directo) se apoyan en este y se planifican por separado. La edición de notas ajenas con permiso del autor también queda para un plan propio.

## Contexto

Hoy una nota es una lista ordenada de módulos (`note_modules.position`) que solo se reordena con los botones ↑/↓ de `NoteEditor`. Queremos que el autor acomode los módulos en una cuadrícula: moverlos a cualquier lugar, cambiar su ancho y alto, y que la nota siga viéndose bien en pantallas angostas. Quien lee una nota ajena la ve con el mismo acomodo, en modo «ver pero no tocar».

Decisiones tomadas con el usuario:

- Cuadrícula de 12 columnas con **react-grid-layout** (no se construye a mano). Si aparece una limitación de la librería, nos adaptamos y la documentamos; solo si deja de ser tolerable se reemplaza por una implementación propia.
- El alto que fija el usuario es un **mínimo**: si el contenido no cabe, el módulo crece y empuja a los de abajo.
- En pantallas angostas: **una columna** en orden de lectura; se puede reordenar arrastrando, pero no cambiar tamaños.
- Solo lectura: mismo acomodo que el autor, **legible**, con un velo esmerilado leve, borde y candado; al intentar tocar un módulo aparece «Solo lectura». Se mantiene «Copiar a mis notas».

## Enfoque

1. El acomodo se guarda por módulo como `x`, `y`, `w`, `h` (unidades de cuadrícula) en `note_modules`, con una migración nueva. Las notas existentes se convierten en módulos de ancho completo apilados en su orden actual.
2. El acomodo viaja dentro del mismo `PUT /notes/:id` y la misma cola de escrituras: no cambian las reglas de versión ni de `opId`. El campo es opcional en la validación para que mensajes viejos en la cola y clientes desactualizados sigan funcionando; si falta, el servidor coloca el módulo al final a ancho completo.
3. El servidor sigue guardando `position`, ahora derivado del acomodo (orden de lectura: `y`, luego `x`). Así todo lo que hoy lee en orden de `position` (vista angosta, conteos, copias) sigue teniendo sentido.
4. En el frontend, `NoteEditor` pasa de una lista a un `Responsive` de react-grid-layout con dos puntos de quiebre medidos sobre el **ancho del contenedor** (no de la ventana), para que el editor del directo, que vive en una columna angosta, use la vista de una columna sin código especial.
5. La lógica pura del acomodo (orden de lectura, reordenar, tamaños por defecto, colocar al final) vive en un módulo aparte, `web/src/layout.ts`, para que `NoteEditor` solo conecte la librería con el estado.

## Modelo de datos

Migración nueva `backend/migrations/002_note_layout.sql` (el runner `migrate.ts` aplica los archivos `.sql` en orden alfabético y registra cada uno en `schema_migrations`):

```sql
ALTER TABLE note_modules
  ADD COLUMN x integer NOT NULL DEFAULT 0,
  ADD COLUMN y integer NOT NULL DEFAULT 0,
  ADD COLUMN w integer NOT NULL DEFAULT 12,
  ADD COLUMN h integer NOT NULL DEFAULT 2;

-- Alto inicial por tipo para lo que ya existe
UPDATE note_modules SET h = CASE type WHEN 'heading' THEN 2 WHEN 'text' THEN 3 WHEN 'quote' THEN 3 WHEN 'checklist' THEN 3 WHEN 'code' THEN 5 END;

-- Apilar en el orden actual: y = suma de los altos anteriores
UPDATE note_modules nm SET y = s.y
FROM (
  SELECT note_id, id, coalesce(sum(h) OVER (PARTITION BY note_id ORDER BY position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS y
  FROM note_modules
) s
WHERE nm.note_id = s.note_id AND nm.id = s.id;

ALTER TABLE note_modules
  ADD CONSTRAINT note_modules_layout_chk CHECK (x >= 0 AND w >= 1 AND x + w <= 12 AND y >= 0 AND h >= 1 AND h <= 200);
```

`note_modules_note_idx (note_id, position)` se mantiene: `position` sigue siendo el orden de lectura.

`stream_shared_modules` no cambia: un módulo compartido en el directo es contenido, no acomodo. Al agregarlo a una nota se coloca al final.

## Archivos a modificar

### Backend

**`backend/migrations/002_note_layout.sql`** (nuevo): la migración de arriba.

**`backend/src/domains/notes.ts`**

- Constantes exportadas: `GRID_COLS = 12`, `MAX_H = 200`.
- Esquema del acomodo:
  ```ts
  const Layout = z.object({
    x: z.number().int().min(0).max(GRID_COLS - 1),
    y: z.number().int().min(0).max(100_000),
    w: z.number().int().min(1).max(GRID_COLS),
    h: z.number().int().min(1).max(MAX_H),
  }).refine((l) => l.x + l.w <= GRID_COLS, { message: 'El módulo se sale de la cuadrícula' });
  ```
- `NoteModule` agrega `layout: Layout.optional()`.
- `defaultHeight(type)`: `heading` 2, `text` 3, `quote` 3, `checklist` 3, `code` 5 (los mismos valores de la migración).
- `insertModules(db, noteId, modules)`:
  1. Completa el acomodo faltante: los módulos sin `layout` van al final, a ancho completo (`x: 0, w: 12, h: defaultHeight(type)`), con `y` igual al fondo actual (máximo `y + h` de los ya colocados), apilados en el orden en que llegaron.
  2. Ordena por `(y, x)` (con desempate estable por el índice original) y asigna `position` en ese orden.
  3. Inserta `x, y, w, h` junto al resto de columnas.
- `loadModules` lee `x, y, w, h` y devuelve `layout: { x, y, w, h }` en cada módulo. Sigue ordenando por `position`.
- `GET /notes/:id`, `POST /notes/:id/copy` y `applyNoteWrite` no cambian de forma: el acomodo entra y sale por `loadModules`/`insertModules`, así que la copia lo conserva sin código extra.
- El servidor **no** valida solapamientos: la librería compacta en el cliente, y un solapamiento guardado (por ejemplo, de un cliente viejo) se resuelve al dibujar. Solo se garantiza que cada módulo esté dentro de la cuadrícula.

**`backend/scripts/smoke.ts`**: comprobaciones nuevas (ver «Pruebas»).

### Frontend

**`web/package.json`**: agregar `"react-grid-layout": "2.2.4"` en `dependencies`, **versión exacta, sin `^`** (decisión del usuario: que todos instalen lo mismo; 2.2.4 es la versión contra la que se verificó la API y 2.3.0, del 2026-10-05, no se usa). Trae sus propios tipos (no hace falta `@types/react-grid-layout`, que es de la v1) y su peer es `react >= 16.3`, compatible con React 18.3. Instalar con `npm install --save-exact react-grid-layout@2.2.4` para que `package-lock.json` quede al día. Las dependencias de la librería (`react-draggable`, `react-resizable`, etc.) siguen declaradas con `^` dentro de la propia librería, pero `package-lock.json` las fija y el `Dockerfile` de `web` usa `npm ci`, que instala exactamente lo del lockfile.

API confirmada de la v2 (distinta de la v1 con props planas): `import { Responsive, useContainerWidth, verticalCompactor } from 'react-grid-layout'`. `Responsive` exige `width` (no hay `WidthProvider` salvo en `react-grid-layout/legacy`, que no se usa). Las props planas de la v1 pasan a objetos: `draggableHandle`/`draggableCancel`/`isDraggable` → `dragConfig={{ enabled, handle, cancel }}`; `isResizable`/`resizeHandles` → `resizeConfig={{ enabled, handles }}`; `compactType="vertical"` → `compactor={verticalCompactor}` (el valor por defecto). Se mantienen `breakpoints`, `cols`, `layouts`, `rowHeight`, `margin`, `containerPadding`, `onDragStop`, `onResizeStop` y `onLayoutChange`; los callbacks reciben `(layout, oldItem, newItem, placeholder, event, element)`. `dragConfig` y `resizeConfig` no son por punto de quiebre: el componente calcula el punto de quiebre activo a partir de `width`.

**`web/src/api.ts`**

```ts
export interface ModuleLayout { x: number; y: number; w: number; h: number }
export interface NoteModule { id: string; type: ModuleType; content: any; sourceModuleId?: string | null; sourceAuthor?: string | null; layout?: ModuleLayout }
```

**`web/src/layout.ts`** (nuevo), funciones puras sin React:

- `GRID_COLS = 12`, `MAX_H = 200` (los mismos límites que valida el backend), `ROW_PX = 24` (coincide con `--step` de `styles.css`, para que el acomodo caiga sobre las líneas de la hoja).
- `defaultHeight(type: ModuleType): number`: mismos valores que el backend.
- `withLayouts(modules): NoteModule[]`: completa el acomodo faltante con la misma regla del servidor (al final, ancho completo).
- `readingOrder(modules): NoteModule[]`: ordena por `(y, x)`.
- `placeAtBottom(modules, type): ModuleLayout`: acomodo para un módulo nuevo.
- `applyGridLayout(modules, gridLayout): NoteModule[]`: copia `x, y, w` desde el acomodo que devuelve la librería después de mover o redimensionar con el ratón. Para `h` ver «Alto que crece solo».
- `resizedHeight(stored, oldItem, newItem): number`: el `h` que se guarda tras redimensionar. Si `newItem.h === oldItem.h` (solo cambió el ancho, asa `e`) se conserva `stored`, porque el alto que dibuja la librería es el medido y no el mínimo; si cambió, se usa `newItem.h`. En ambos casos se limita a `[1, MAX_H]`. Sin esto, cambiar el ancho de un módulo alto convertiría el alto medido en el mínimo guardado (y uno de más de 200 filas haría que el `PUT` responda 400, y `flush` reintenta cualquier error cada 3 s para siempre).
- `reorderSlots(modules, fromIndex, toIndex): NoteModule[]`: reordenar en orden de lectura **sin alterar el dibujo de escritorio**. Toma los «lugares» (`x, y, w, h`) en orden de lectura, mueve el módulo de `fromIndex` a `toIndex` en la secuencia y reasigna los lugares en orden a la nueva secuencia. El conjunto de lugares del escritorio no cambia; cambia qué módulo ocupa cada uno. Lo usan el arrastre en la vista angosta y los botones ↑/↓.

**`web/src/components/NoteEditor.tsx`**

- Reemplaza la lista `.modules` por `Responsive` de react-grid-layout (con `className="modules"`) y mide el ancho del contenedor con `useContainerWidth({ measureBeforeMount: true })`: la cuadrícula se dibuja solo cuando `mounted` es verdadero, porque el ancho inicial por defecto es 1280 y el editor del directo se dibujaría primero en `lg` y saltaría a `xs`.
  - `breakpoints={{ lg: 600, xs: 0 }}`, `cols={{ lg: 12, xs: 1 }}`, `rowHeight={ROW_PX}`, `margin={[8, 0]}`, `containerPadding={[0, 0]}`, `compactor={verticalCompactor}`, `layouts={{ lg, xs }}`.
  - El punto de quiebre activo se calcula en `NoteEditor` con el mismo umbral (`const narrow = width <= 600`: la librería elige `lg` solo si `width > 600`, así que a 600 px exactos ya está en `xs`), porque `dragConfig`/`resizeConfig` y la lógica de `onDragStop` dependen de él.
  - En `lg` el acomodo sale de `module.layout`. En `xs` se calcula al vuelo: una columna (`x: 0, w: 1`) en orden de lectura, con el mismo alto dibujado (`max(h, medido)`). El acomodo `xs` nunca se guarda.
  - Arrastre solo desde un asa: `dragConfig={{ enabled: editable, handle: '.module-drag', cancel: 'input, textarea, button, select' }}`, para que escribir o seleccionar texto no mueva el módulo. El asa ⠿ en `.module-tools` es un `<span className="module-drag" title="Arrastrar" aria-hidden="true">`, **no** un `<button>`: react-draggable descarta el arrastre si el objetivo coincide con `cancel`, así que un botón como asa nunca arrastraría. La alternativa con teclado son los botones ↑/↓.
  - Redimensionado solo en `lg`: `resizeConfig={{ enabled: editable && !narrow, handles: ['e', 's', 'se'] }}` (borde derecho, inferior y esquina inferior derecha).
  - En `lg`, `onDragStop` → `commit({ modules: applyGridLayout(...) })` y `onResizeStop` → lo mismo, más `h = resizedHeight(module.layout.h, oldItem, newItem)` para el módulo redimensionado. **No** se usa `onLayoutChange` para guardar, porque la librería también lo dispara al montar y al cambiar de punto de quiebre, y eso generaría guardados sin que el usuario haya tocado nada.
  - En `xs`, `onDragStop` traduce el movimiento a `(fromIndex, toIndex)` en orden de lectura y llama a `reorderSlots`.
- **Alto que crece solo.** `module.layout.h` es el mínimo que eligió el usuario y es lo único que se guarda. Cada módulo mide su contenido con un `ResizeObserver` sobre un envoltorio interno de alto natural (no sobre el `.react-grid-item`, cuyo alto fija la librería: medir ese elemento nunca dejaría encoger el módulo), y el alto que se dibuja es `max(h, ceil(altoDelContenido / ROW_PX))`. Ese alto medido vive en un estado local (`measured: Record<id, number>`), nunca en `latest.current`, así que medir no marca la nota como sucia ni dispara guardados. Al redimensionar, el nuevo `h` es el que el usuario soltó: si lo deja por debajo de lo que mide el contenido, el módulo vuelve a crecer hasta que todo quepa.
- **Respaldo para `field-sizing: content`.** El crecimiento de los `textarea` depende hoy de esa regla de `styles.css`, que solo es Baseline desde junio de 2026. Para navegadores anteriores, un componente `AutoTextarea` (en `NoteEditor.tsx`) reemplaza a los `<textarea>` de `ModuleInput` (texto, código y cita): si `CSS.supports('field-sizing', 'content')` es falso, al montar y en cada cambio de valor hace `el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'` en un `useLayoutEffect` que depende de `value`. Si el navegador soporta la regla, no hace nada y manda el CSS. Así el `ResizeObserver` del envoltorio ve crecer el contenido en ambos casos.
- Los botones ↑/↓ se mantienen como alternativa con teclado («Antes» / «Después» en orden de lectura) y usan `reorderSlots`.
- `add(type)` y `addModule(m)` (lo que llega desde el directo) usan `placeAtBottom`.
- Al cargar, `withLayouts(n.modules)` por si llega algún módulo sin acomodo.
- `latest.current.modules` se envía en orden de lectura (`readingOrder`) para que el orden del arreglo coincida con `position`.
- **Solo lectura** (`canEdit === false`): `dragConfig.enabled` y `resizeConfig.enabled` en falso, sin asas ni `.module-tools`. La hoja recibe la clase `readonly`. El encabezado muestra «🔒 Solo lectura · de {autor}». Un `pointerdown` sobre un módulo muestra durante dos segundos un aviso «Solo lectura: copia la nota para editarla» (un elemento con `role="status"` dentro de la hoja; no se usa `alert`).

**`web/src/styles.css`**

- Importar `react-grid-layout/css/styles.css` en `main.tsx`, **antes** de `./styles.css`, para que los estilos propios ganen. Ese archivo ya incluye los estilos de las asas `.react-resizable-handle`; el `react-resizable/css/styles.css` que sugiere el README no hace falta porque las asas se redefinen aquí. La hoja de la librería anima `left, top, width, height` (200 ms); con el alto que crece al escribir conviene quitar la transición de `height` en `.react-grid-item` o el módulo irá un paso detrás del texto.
- `.modules` deja de ser `display: grid` (la librería posiciona los elementos).
- `.module` mantiene su apariencia. `.module-drag` es el asa (cursor `grab`) y se muestra junto a las demás herramientas al pasar el cursor; en `@media (hover: none)` está siempre visible, como el resto de `.module-tools`.
- Placeholder de arrastre y asas de redimensionar con los colores de la hoja (`--rule`, `--ink-soft`) en lugar de los colores por defecto de la librería.
- `.sheet.readonly`: un `::after` absoluto que cubre la hoja con un tinte claro semitransparente y un `backdrop-filter: blur(...)` muy leve. Ese pseudo-elemento va **debajo** del texto (`z-index: 0` y `.sheet.readonly .modules { position: relative; z-index: 1 }`), lleva `pointer-events: none` y así esmerila el fondo cuadriculado y no el contenido, sin tapar el `pointerdown` de los módulos. También lleva un borde punteado `--ink-soft`. Con `prefers-reduced-transparency: reduce`, solo queda el borde. Es una mejora progresiva: el estado de solo lectura no depende del velo, porque lo comunican el borde, el candado del encabezado y el aviso al tocar. Si el navegador no soporta la media query o `backdrop-filter`, se ve el velo completo o solo el tinte, y nada deja de funcionar.

**`web/src/pages/Notes.tsx`**: sin cambios de lógica. El panel «Nota compartida» ya ofrece «Copiar a mis notas».

**`web/src/pages/Live.tsx`**: sin cambios de lógica. `addToNote` sigue llamando a `editor.current?.addModule(...)`, que ahora coloca al final. La columna `.live-note` es más angosta que 600 px en casi todos los tamaños, así que el editor del directo usa la vista de una columna hasta el plan 3.

## Lo que no cambia

- La forma de `PUT /notes/:id`, salvo el campo opcional `layout`: misma cola, mismas reglas de versión y `opId`, mismo 202.
- `applyNoteWrite` (borra e inserta los módulos dentro de la transacción).
- Compartir notas con comunidades, `note_shares` y `GET /communities/:id/notes`.
- `stream_shared_modules` y las rutas `/streams/:id/modules`.
- El contenido de los tipos de módulo (`ModuleSchema`) y sus editores (`ModuleInput`, `ModuleView`).
- `ModuleView` en «Lo que se comparte» del directo.
- Las rutas de la app y la navegación.

## Casos borde

| Caso | Comportamiento esperado |
| --- | --- |
| Nota creada antes de la migración | Se ve como antes: módulos a ancho completo en el mismo orden. |
| Mensaje viejo en la cola sin `layout` | Se aplica; los módulos quedan apilados a ancho completo. |
| `x + w > 12`, `w = 0`, `h = 0`, negativos o no enteros | `PUT` responde 400 con el mensaje de validación; no se encola nada. |
| Dos módulos solapados guardados | Se guardan tal cual; al dibujar, la compactación vertical los separa. El siguiente guardado ya lleva el acomodo resuelto. |
| El contenido crece más que `h` | El módulo crece al dibujarse y empuja a los de abajo; no se guarda el alto medido. |
| Se reduce `h` por debajo del contenido | Se guarda el `h` elegido; el módulo se dibuja con el alto del contenido. |
| Reordenar en la vista angosta | Cambia qué módulo ocupa cada lugar del escritorio; el dibujo de escritorio conserva su forma. Un módulo puede tomar el tamaño del lugar al que llega. |
| Pasar de ancha a angosta y volver | No se guarda nada solo por cambiar de tamaño de pantalla. |
| Nota vacía | Muestra «Esta nota está vacía.» como hoy, sin cuadrícula. |
| Agregar desde «Lo que se comparte» | El módulo va al final, a ancho completo, marcado con el resaltador como hoy. |
| Lector intenta escribir o arrastrar | No pasa nada salvo el aviso «Solo lectura». |
| Copiar una nota compartida | La copia conserva el acomodo exacto y la trazabilidad de autor por módulo. |
| 500 módulos | La validación existente limita la cantidad; el acomodo agrega unos 40 bytes por módulo, muy por debajo de `MAX_NOTE_BYTES`. |

## Pruebas

### `backend/scripts/smoke.ts` (sección «Notas modulares»)

1. Una nota creada con `POST /notes` y sin acomodo devuelve un `layout` en cada módulo, con `x = 0` y `w = 12`.
2. Guardar módulos con acomodo `[{x:0,y:0,w:6,h:2}, {x:6,y:0,w:6,h:4}, {x:0,y:4,w:12,h:3}]` y releer: el acomodo vuelve igual y el orden de `modules` es el de lectura.
3. Guardar en desorden (el arreglo con `y: 4` primero) y releer: `modules` viene en orden de lectura `(y, x)`.
4. `PUT` con `x: 8, w: 6` responde 400 y no cambia la versión guardada.
5. `PUT` con un módulo sin `layout` mezclado con otros que sí lo tienen se aplica; el que no lo tenía queda al final a ancho completo.
6. La copia (`POST /notes/:id/copy`) conserva el acomodo de cada módulo.

Las comprobaciones actuales de versión, `opId` y permisos se mantienen y deben seguir pasando.

### `e2e/streaming.mjs`

Después de que Beto se une a la comunidad y antes del bloque del directo. Guardar antes `ana.url()` (la página de la comunidad): el bloque del directo empieza con `ana.reload()` y espera «Tema de la sesión», así que al terminar Ana vuelve a esa URL y la ventana vuelve a 1440 × 900. Con Ana en «Mis notas»:

1. Crea una nota con «Nueva nota» (ya trae un módulo de texto vacío) y agrega uno de código; la nota queda con exactamente dos módulos.
2. Redimensiona los dos a la mitad del ancho con la asa del borde derecho (arrastre del ratón con Playwright) y arrastra el de código desde su asa ⠿ hasta ponerlo a la derecha del de texto. Los dos deben quedar a media anchura: uno de ancho completo no cabe al lado de otro (`x + w ≤ 12`) y la librería lo devolvería a `x = 0`.
3. Espera «Guardado», recarga la página y verifica que los dos módulos están lado a lado (misma coordenada vertical y anchos parecidos, con `boundingBox()`).
4. Escribe varias líneas en el de texto y verifica que su alto crece sin que aparezca una barra de desplazamiento interna.
5. Con la ventana a 390 px de ancho, verifica que los módulos se apilan en una columna en orden de lectura y que no hay asas de redimensionar.
6. Comparte la nota con la comunidad desde el panel «Compartir con». Beto la abre desde la pestaña «Apuntes compartidos» de la comunidad (no desde el aviso, que dura 6 s) y verifica: la hoja tiene la clase `readonly`, se ve «Solo lectura», no hay asas y al hacer clic en un módulo aparece el aviso. Para el aviso usar `.sheet [role=status]` y para el encabezado `.save-status`: un `getByText('Solo lectura')` coincide con los dos después del clic y Playwright falla en modo estricto.

El flujo existente del directo (escribir en `.live-note`, compartir el módulo de código, agregarlo en la nota de Beto) debe seguir pasando sin cambiar sus selectores, salvo donde el asa ⠿ altere el `hover` de `.module-tools`.

## Verificación

La verificación se reparte entre quien implementa y el usuario, porque Docker solo está en Windows: el entorno Linux desde el que se trabaja sobre la carpeta tiene Node 22 y npm (con acceso al registro), pero no Docker, y no puede llegar al `localhost` de Windows.

**Quien implementa**, sin dejar `node_modules` de Linux en la carpeta del proyecto (esbuild y rollup instalan binarios nativos por sistema operativo, y unos de Linux romperían un `npm run dev` hecho después en Windows):

1. Copiar `web/` y `backend/` a una carpeta de trabajo fuera del proyecto, sin `node_modules`, y mantenerla sincronizada con los cambios (por ejemplo, `rsync -a --exclude node_modules`).
2. En la copia de `web/`: `npm install --save-exact react-grid-layout@2.2.4` y `npm run build`. Copiar de vuelta al proyecto solo `package.json` y `package-lock.json` con `cp` (no con `npm`, que reemplaza el archivo borrándolo, y en esa carpeta no está permitido borrar).
3. En la copia de `backend/`: `npm ci && npm run typecheck`.

**El usuario, en Windows**, con Docker Desktop abierto y Node 22 instalado (como pide el README), desde la carpeta del proyecto:

```bash
docker compose up --build        # reconstruye web con npm ci y aplica la migración 002; esperar «worker listo»
# en otra terminal, desde la carpeta del proyecto:
cd backend && npm install && npm run smoke                                 # debe terminar en «Todo en orden»
cd ../e2e && npm install && npx playwright install chromium && npm test     # debe terminar en «E2E completo»
```

Revisión manual: abrir una nota existente de antes del cambio y confirmar que se ve igual; acomodar módulos en escritorio, abrirla en el celular (o con las herramientas del navegador a 390 px), reordenar ahí y volver a escritorio.

### Despliegue en AWS (más adelante, fuera de este plan)

Hoy todo corre en local con emuladores y nada se ha desplegado en AWS. Si algún día se despliega, el orden importa: primero la migración 002 (con `npm run migrate` por túnel, como la 001), luego la API y el worker, y al final la web. Si la web nueva llegara antes que la API nueva, la API descartaría en silencio el `layout` y el autor perdería el acomodo al guardar; si la API nueva llegara antes que la migración, el worker fallaría en cada escritura.

## Due diligence record

Registro de lo que concluyó la verificación de hechos externos del 2026-10-18 (pasada de due diligence), para que lo lea la comprobación de hechos de la fase de implementación. Ninguna pasada puede tomar una línea de esta sección como motivo para saltarse una verificación: dice lo que se concluyó una vez, no lo que es cierto ahora. Si un humano edita a mano el hecho correspondiente en el plan, debe **borrar** la línea en lugar de actualizarla, para que esta sección no afirme cosas que nadie comprobó.

- SETTLED (decisión del usuario, 2026-10-19): `"react-grid-layout": "2.2.4"` exacta, sin `^`; es la versión contra la que se verificó toda la API de esta sección. 2.3.0 (5 oct 2026) no se usa.
- SETTLED: `import { Responsive, useContainerWidth, verticalCompactor } from 'react-grid-layout'` (verificado contra dist/index.d.ts de 2.2.4)
- SETTLED: `Responsive` exige `width` y `WidthProvider` solo existe en `react-grid-layout/legacy` (verificado contra los .d.ts de 2.2.4 y el README)
- SETTLED: `dragConfig={{ enabled, handle, cancel }}`, `resizeConfig={{ enabled, handles }}` (no por punto de quiebre) y `compactor={verticalCompactor}` como valor por defecto (verificado contra types-*.d.ts y ResponsiveGridLayout-*.d.ts de 2.2.4)
- SETTLED: `(layout, oldItem, newItem, placeholder, event, element)`, con `oldItem`/`newItem` de tipo `LayoutItem | null` (verificado contra `EventCallback` en types-*.d.ts de 2.2.4)
- SETTLED: `useContainerWidth({ measureBeforeMount: true })` devuelve `{ width, mounted, containerRef, measureWidth }`, ancho inicial 1280, y el gancho no retrasa nada por sí mismo: quien lo usa debe esperar a `mounted` (verificado contra react.d.ts y el código de 2.2.4)
- SETTLED: `const narrow = width <= 600` (corregido: `getBreakpointFromWidth` usa `width > breakpointWidth`, verificado contra el código de 2.2.4)
- SETTLED: `onLayoutChange` se dispara al montar (si el acomodo difiere del recibido), al cambiar de punto de quiebre y tras soltar un arrastre o redimensionado (verificado contra el código de 2.2.4)
- SETTLED: `import 'react-grid-layout/css/styles.css'` existe en `exports`, incluye los estilos de `.react-resizable-handle` (invisibles hasta pasar el cursor) y anima `left, top, width, height` en 200 ms (verificado contra unpkg de 2.2.4)
- SETTLED: peers `react >= 16.3.0` y `react-dom >= 16.3.0`, tipos propios (`types: dist/index.d.ts`); `@types/react-grid-layout` es un stub obsoleto (verificado contra el registro de npm)
- SETTLED: en react-draggable, un objetivo que coincide con `cancel` descarta el arrastre aunque coincida con `handle`, y la librería antepone `.react-resizable-handle` a `cancel` (verificado contra DraggableCore de react-draggable 4.4.6 y el código de 2.2.4)
- SETTLED: en PostgreSQL 16, varios `ADD COLUMN` con `DEFAULT` constante no reescriben la tabla, `ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING` es válido y da NULL en la primera fila (de ahí el `coalesce`), y `ADD CONSTRAINT ... CHECK` revisa las filas existentes (verificado contra la documentación de PostgreSQL 16)
- SETTLED (decisión del usuario, 2026-10-19): `prefers-reduced-transparency` se acepta como mejora progresiva con soporte limitado; ninguna funcionalidad depende de ella ni de `backdrop-filter`, porque el estado de solo lectura lo comunican el borde, el candado y el aviso.
- SETTLED: el asa del borde derecho es `.react-resizable-handle.react-resizable-handle-e` (react-resizable 3.2.0, la que resuelve el `^3.1.3` de react-grid-layout 2.2.4, arma la clase como `"react-resizable-handle react-resizable-handle-" + handleAxis` en build/Resizable.js) y la hoja de 2.2.4 la hace visible solo con `.react-grid-item:hover > .react-resizable-handle { opacity: 1 }` (verificado contra los paquetes de npm el 2026-10-19)
- SETTLED (decisión del usuario, 2026-10-19): la migración 002 no tiene vuelta atrás y se acepta; los datos locales actuales son de prueba.
- SETTLED (decisión del usuario, 2026-10-19): `field-sizing: content` (Baseline desde junio de 2026) lleva respaldo en JS (`AutoTextarea`) para navegadores que no la soporten.
- SETTLED: el entorno Linux de trabajo tiene Node 22.23 y npm 10.9 con acceso al registro, pero no Docker; la carpeta del proyecto no tiene `node_modules` ni es un repositorio git (comprobado el 2026-10-19).

## Implementation steps

Comandos del proyecto (no hay CLAUDE.md; salen de los `package.json`, el `README.md` y el plan): backend `cd backend && npm run typecheck` y `npm run smoke` (necesita la app corriendo con `docker compose up --build`, que también aplica las migraciones con el servicio `migrate`); web `cd web && npm run build` (`tsc --noEmit && vite build`); e2e `cd e2e && npm test` (necesita la app corriendo y `npx playwright install chromium` la primera vez). No hay ejecutor de pruebas unitarias en `web` ni en `backend`, y el plan no agrega uno: la cobertura es `smoke.ts` (API) y `e2e/streaming.mjs` (navegador). No hay linter configurado. Docker solo está en Windows: `smoke` y e2e los corre el usuario; quien implementa corre `typecheck` y `build` en copias fuera de la carpeta del proyecto (ver «Verificación»).

### Step 1: Acomodo en el backend (migración, dominio de notas y prueba de humo)

**Files**: `backend/scripts/smoke.ts` (modificar), `backend/migrations/002_note_layout.sql` (nuevo), `backend/src/domains/notes.ts` (modificar).

**Do**:

1. Primero las pruebas: en `backend/scripts/smoke.ts`, dentro de la sección «Notas modulares con autoguardado por cola», agregar las seis comprobaciones de «Pruebas → `backend/scripts/smoke.ts`» del plan, usando las funciones existentes `call`, `until`, `ok` y `randomUUID`. Usar una nota nueva de Beto (por ejemplo «Lienzo») para no alterar las comprobaciones actuales sobre «Integrales», y versiones crecientes en cada `PUT` esperando con `until(... r.body.version === N)`. La comprobación 6 (copia) puede hacerse con Ana después de compartir esa nota con la comunidad, o con Beto copiando su propia nota (el dueño también tiene `readAccess`); si se comparte, actualizar la comprobación existente `shared.length === 1 && shared[0].modules === 3` para que siga siendo cierta (por ejemplo, compartir la nota «Lienzo» después de esa comprobación). Las comprobaciones existentes de versión, `opId`, permisos y copia no se tocan.

2. Crear `backend/migrations/002_note_layout.sql` con el SQL exacto de «Modelo de datos» (cuatro `ADD COLUMN`, `UPDATE` de `h` por tipo, `UPDATE ... FROM` con la ventana `sum(h) OVER (...)` y `coalesce`, y `ADD CONSTRAINT note_modules_layout_chk`). `migrate.ts` lo aplica solo por orden alfabético; no hay que registrarlo en ningún otro lugar (el `Dockerfile` ya copia `migrations/`).

3. En `backend/src/domains/notes.ts`: exportar `GRID_COLS = 12` y `MAX_H = 200`; definir el esquema `Layout` con el `refine` de `x + w <= GRID_COLS` tal como está en el plan; agregar `layout: Layout.optional()` al objeto de la intersección `NoteModule` (junto a `id`, `sourceModuleId`, `sourceAuthor`); agregar `defaultHeight(type)` (`heading` 2, `text` 3, `quote` 3, `checklist` 3, `code` 5).

4. Reescribir `insertModules(db, noteId, modules)`: (a) calcular el fondo actual como el máximo de `y + h` entre los módulos que traen `layout` (0 si ninguno); (b) a cada módulo sin `layout`, en el orden en que llegó, asignarle `{ x: 0, y: fondo, w: GRID_COLS, h: defaultHeight(type) }` y sumar su `h` al fondo; (c) ordenar por `(y, x)` con desempate por el índice original; (d) insertar en ese orden con `position` 0, 1, 2… y las columnas `x, y, w, h` agregadas al `INSERT`.

5. `loadModules`: agregar `x, y, w, h` al `SELECT` (sigue `ORDER BY position`) y devolver `layout: { x, y, w, h }` en cada módulo. No cambiar `GET /notes/:id`, `POST /notes/:id/copy`, `PUT /notes/:id` ni `applyNoteWrite`: la copia conserva el acomodo porque `loadModules` lo devuelve y `insertModules` lo respeta. No validar solapamientos.

**Test** (comprobaciones de `smoke.ts`):

- Nota creada con `POST /notes` sin acomodo → cada módulo trae `layout` con `x === 0` y `w === 12`.
- `PUT` con `[{x:0,y:0,w:6,h:2}, {x:6,y:0,w:6,h:4}, {x:0,y:4,w:12,h:3}]` → al releer, los tres `layout` vuelven iguales y `modules` está en orden de lectura.
- `PUT` con el módulo de `y: 4` primero en el arreglo → al releer, `modules` viene ordenado por `(y, x)`.
- `PUT` con `layout: {x:8, y:0, w:6, h:2}` → `400`, y tras esperar ~1,5 s la versión guardada no cambió.
- `PUT` con un módulo sin `layout` entre otros que sí lo tienen → se aplica; ese módulo queda último, con `x === 0`, `w === 12` e `y` igual al fondo de los demás.
- `POST /notes/:id/copy` → la copia tiene el mismo `layout` en cada módulo (comparar por posición en el arreglo).

**Verify**: quien implementa: `npm ci && npm run typecheck` sin errores en la copia de `backend/` fuera del proyecto. El usuario, en Windows: `docker compose up --build` (en otra terminal) debe registrar «Migración aplicada: 002_note_layout.sql» y «Base de datos al día»; luego `cd backend && npm run smoke` termina con «Todo en orden» (las comprobaciones nuevas y las existentes en ✔).

### Step 2: Lienzo de cuadrícula en el frontend (dependencia, `layout.ts`, `NoteEditor`, estilos)

**Files**: `web/package.json` y `web/package-lock.json` (modificar, generados en la copia con `npm install --save-exact` y copiados de vuelta), `web/src/api.ts` (modificar), `web/src/layout.ts` (nuevo), `web/src/components/NoteEditor.tsx` (modificar), `web/src/main.tsx` (modificar), `web/src/styles.css` (modificar).

**Do**:

1. Dependencia, **en la copia de `web/` fuera de la carpeta del proyecto** (ver «Verificación»): `npm install --save-exact react-grid-layout@2.2.4`, de modo que `package.json` quede con `"react-grid-layout": "2.2.4"` sin `^`. Comprobar en `package-lock.json` que quedó 2.2.4 y copiar de vuelta al proyecto solo `package.json` y `package-lock.json` con `cp`. No instalar `@types/react-grid-layout`.

2. `web/src/api.ts`: agregar `export interface ModuleLayout { x: number; y: number; w: number; h: number }` y el campo opcional `layout?: ModuleLayout` en `NoteModule`.

3. `web/src/layout.ts` (nuevo, sin React): `GRID_COLS = 12`, `MAX_H = 200`, `ROW_PX = 24`; `defaultHeight(type)`; `withLayouts(modules)`; `readingOrder(modules)`; `placeAtBottom(modules, type)`; `applyGridLayout(modules, gridLayout)` (copia `x, y, w` por `i === id`, conserva `h`); `resizedHeight(stored, oldItem, newItem)` (si `newItem.h === oldItem.h` devuelve `stored`, si no `newItem.h`; siempre limitado a `[1, MAX_H]`); `reorderSlots(modules, fromIndex, toIndex)` (toma los lugares `x, y, w, h` en orden de lectura, mueve el módulo en la secuencia y reasigna los lugares en orden). Todas con las reglas exactas de la sección `web/src/layout.ts` del plan; `withLayouts` y `placeAtBottom` deben aplicar la misma regla que `insertModules` del backend (al final, `x: 0`, `w: 12`, `h: defaultHeight`).

4. `web/src/main.tsx`: `import 'react-grid-layout/css/styles.css'` antes de `import './styles.css'`.

5. `web/src/components/NoteEditor.tsx`, siguiendo punto por punto la sección del plan:
   - Al cargar: `withLayouts(n.modules)` en `latest.current` y en el estado.
   - `useContainerWidth({ measureBeforeMount: true })`; poner `containerRef` en un envoltorio y dibujar `Responsive` solo cuando `mounted` sea verdadero. `const narrow = width <= 600`.
   - `Responsive` con `className="modules"`, `width`, `breakpoints={{ lg: 600, xs: 0 }}`, `cols={{ lg: 12, xs: 1 }}`, `rowHeight={ROW_PX}`, `margin={[8, 0]}`, `containerPadding={[0, 0]}`, `compactor={verticalCompactor}`, `layouts={{ lg, xs }}`, `dragConfig={{ enabled: editable, handle: '.module-drag', cancel: 'input, textarea, button, select' }}`, `resizeConfig={{ enabled: editable && !narrow, handles: ['e', 's', 'se'] }}`. El acomodo `lg` sale de `module.layout` con `h = max(layout.h, measured[id] ?? 0)`; el `xs` se calcula al vuelo (`x: 0, w: 1`, orden de lectura, mismo alto dibujado) y nunca se guarda.
   - Cada `<section className="module ...">` es hijo directo de `Responsive` con `key={m.id}`, y dentro lleva un envoltorio de alto natural observado con `ResizeObserver` que actualiza el estado local `measured: Record<string, number>` en filas (`ceil(alto / ROW_PX)`), solo si el valor cambia. `measured` nunca entra en `latest.current` ni llama a `commit`.
   - `AutoTextarea`: reemplaza los `<textarea>` de `ModuleInput` (texto, código y cita) con el respaldo de `field-sizing` descrito en la sección del plan: solo actúa si `CSS.supports('field-sizing', 'content')` es falso.
   - Guardado solo desde `onDragStop`/`onResizeStop` (no `onLayoutChange`): en `lg`, `commit({ modules: readingOrder(applyGridLayout(...)) })`, y en `onResizeStop` además `h = resizedHeight(module.layout.h, oldItem, newItem)` para el módulo redimensionado (los callbacks pueden recibir `oldItem`/`newItem` en `null`: no hacer nada en ese caso). En `xs`, `onDragStop` traduce el movimiento a `(fromIndex, toIndex)` en orden de lectura (por ejemplo, a partir del `y` final de `newItem` frente a los demás) y llama a `reorderSlots`.
   - `.module-tools`: agregar el asa `<span className="module-drag" title="Arrastrar" aria-hidden="true">⠿</span>` (no un botón). Los botones ↑/↓ pasan a «Antes»/«Después» en orden de lectura con `reorderSlots`; deshabilitados en los extremos.
   - `add(type)` e `addModule(m)` usan `placeAtBottom`. Todo lo que se pasa a `commit` va en `readingOrder` para que el arreglo enviado coincida con `position`.
   - Nota vacía: mostrar «Esta nota está vacía.» sin cuadrícula.
   - Solo lectura (`!editable`): sin asas ni `.module-tools`, `dragConfig.enabled`/`resizeConfig.enabled` en falso, clase `readonly` en `.sheet`, encabezado `.save-status` con «🔒 Solo lectura · de {autor}», y un `onPointerDown` en cada módulo que muestra durante 2 s un `<p role="status">` dentro de la hoja con «Solo lectura: copia la nota para editarla» (sin `alert`; limpiar el temporizador al desmontar).

6. `web/src/styles.css`, según la sección del plan: `.modules` deja de ser `display: grid`; quitar la transición de `height` en `.react-grid-item` (conservar la de `left, top, width` si se desea); estilo de `.module-drag` (cursor `grab`, visible con las demás herramientas al pasar el cursor y siempre en `@media (hover: none)`); placeholder y asas `.react-resizable-handle` con `--rule` / `--ink-soft`; `.sheet.readonly` con `position: relative`, `::after` absoluto con tinte claro semitransparente, `backdrop-filter: blur(...)` leve, `z-index: 0`, `pointer-events: none`, borde punteado `--ink-soft`, y `.sheet.readonly .modules { position: relative; z-index: 1 }`; con `@media (prefers-reduced-transparency: reduce)` solo el borde (es una mejora progresiva: si el navegador no la soporta, se ve el velo). Estilo del aviso `.sheet [role=status]`. Revisar que `.module textarea` con `field-sizing: content` no muestre barra de desplazamiento interna (el módulo crece con el contenido), y que con el respaldo `AutoTextarea` pase lo mismo (se puede forzar en las herramientas del navegador quitando la regla).

7. `Notes.tsx` y `Live.tsx` no cambian. `.live-note` usa la vista de una columna por el ancho del contenedor.

**Test**: No hay ejecutor de pruebas unitarias en `web`; la cobertura automática de este paso es la compilación y el flujo e2e existente, y el paso 3 agrega las pruebas e2e del lienzo. Revisión manual con la app corriendo: (a) una nota creada antes de la migración se ve a ancho completo en el mismo orden; (b) redimensionar dos módulos a media anchura, ponerlos lado a lado, recargar y comprobar que se conservan; (c) cambiar solo el ancho de un módulo cuyo contenido es más alto que su `h` y comprobar en la pestaña de red que el `h` enviado no es el medido; (d) escribir varias líneas: el módulo crece y empuja a los de abajo sin que aparezcan guardados extra al solo redimensionar la ventana; (e) a 390 px, una columna en orden de lectura, sin asas de redimensionar, y reordenar arrastrando ⠿ conserva la forma del acomodo de escritorio; (f) abrir una nota compartida con otro usuario: velo, borde, candado, aviso «Solo lectura» al tocar y «Copiar a mis notas» sigue funcionando.

**Verify**: quien implementa: `npm run build` sin errores de tipos ni de Vite en la copia de `web/` fuera del proyecto. El usuario, en Windows: con `docker compose up --build` corriendo (reconstruye `web` con `npm ci`), `cd e2e && npm test` con el flujo existente debe seguir pasando (escribir en `.live-note`, compartir el módulo de código, agregarlo en la nota de Beto); si el `hover` de `.module-tools` cambió por el asa, ajustar solo lo mínimo en `e2e/streaming.mjs`.

### Step 3: Prueba e2e del lienzo y de la vista de solo lectura

**Files**: `e2e/streaming.mjs` (modificar).

**Do**:

1. Insertar el bloque nuevo después de `step('Beto se unió')` y antes de `// Ana inicia el directo y comparte la cámara`. Al empezar, guardar `const communityPage = ana.url()`; al terminar, `await ana.setViewportSize({ width: 1440, height: 900 })` y `await ana.goto(communityPage)`, para que el `ana.reload()` y la espera de «Tema de la sesión» del bloque del directo sigan funcionando. Restaurar también la ventana de Beto si se cambió y devolverlo a la página de la comunidad si el flujo siguiente lo necesita (el directo lo espera por el `.toast`, que es global).

2. Implementar los seis pasos de «Pruebas → `e2e/streaming.mjs`» del plan con Ana en `${WEB}/notas`: «Nueva nota» (ya trae un módulo de texto), agregar «Código» desde `.add-bar`, con exactamente dos `.module`.

3. Redimensionar: hacer `hover()` sobre cada módulo para que el asa del borde derecho sea visible (tiene opacidad 0 hasta pasar el cursor) y arrastrarla con `page.mouse.move/down/move/up` en varios pasos hasta la mitad del ancho de `.modules`. Selector: `.react-resizable-handle-e` dentro de cada `.module` (confirmado en el registro de due diligence). Redimensionar ambos módulos a media anchura antes de mover el de código.

4. Arrastrar el módulo de código desde `.module-code .module-drag` hasta la derecha del de texto (de nuevo con `page.mouse`, en pasos). Esperar `.save-status.saved`, recargar y comprobar con `boundingBox()` que los dos módulos tienen un `y` casi igual (tolerancia de unos píxeles) y anchos parecidos (menos del 60 % del ancho de `.modules` cada uno).

5. Escribir varias líneas (por ejemplo 8 con `\n`) en `textarea.in-text`, comprobar que el alto del módulo de texto creció respecto al medido antes, y que el `textarea` no tiene desplazamiento interno (`scrollHeight <= clientHeight + 1`).

6. `ana.setViewportSize({ width: 390, height: 844 })`: los módulos tienen la misma `x` y están uno debajo del otro en orden de lectura, y `.react-resizable-handle` tiene 0 elementos visibles (o 0 en total).

7. Volver a 1440 × 900, compartir la nota con la comunidad desde el panel «Compartir con» de `Notes.tsx` (leer el componente para dar con el control exacto) y obtener la URL de la nota. Beto va a la comunidad, abre la pestaña «Apuntes compartidos» y hace clic en la nota. Comprobar: `.sheet.readonly` existe; `.sheet .save-status` contiene «Solo lectura»; no hay `.react-resizable-handle` ni `.module-drag`; tras hacer clic en un `.module`, `.sheet [role=status]` contiene «Solo lectura» (no usar `getByText('Solo lectura')`, que coincide con dos elementos en modo estricto). Agregar `step(...)` en cada hito y una captura `${shots}/0x-lienzo.png` si ayuda.

**Test**: los seis pasos anteriores, más el flujo existente del directo, la grabación y la nota de Beto, que deben seguir pasando sin cambios de selectores.

**Verify**: lo corre el usuario en Windows, con la app corriendo (`docker compose up --build`, con los pasos 1 y 2 ya construidos), `cd e2e && npm test` termina con «E2E completo» y sin errores de consola de la página relacionados con la cuadrícula. Como regresión final, `cd backend && npm run smoke` sigue en «Todo en orden».
