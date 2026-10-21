# Plan 2: Explorador de archivos con carpetas y pestañas

Segundo de los tres planes de la funcionalidad de notas modulares. El plan 1 (`plans/2026-10-18_lienzo-modular.md`) y sus ajustes (`plans/2026-10-20_lienzo-ajustes.md`) ya están implementados. El plan 3 (tablero compartido del directo) queda fuera de este.

## Contexto

Hoy «Mis notas» (`/notas`) es una lista plana ordenada por fecha, y cada nota se abre en otra página (`/notes/:id`) con el panel «Compartir con» a la derecha. Las notas que se toman en un directo se crean solas (`POST /notes` con `streamId` desde `Live.tsx`) y quedan privadas, mezcladas con las demás.

El usuario pidió poder crear varios archivos, revisarlos ordenadamente en un panel lateral y organizarlos en carpetas, como el explorador de archivos de una PC; y que las notas de los directos tengan su lugar y su relación con la comunidad.

Decisiones tomadas con el usuario (2026-10-20):

- **Panel lateral «Mis archivos»** con un árbol de **carpetas anidadas** (sin límite de profundidad; una carpeta no puede quedar dentro de sí misma). Las carpetas se modelan aparte de las notas, para que en el futuro contengan otros tipos de archivo.
- **Pestañas**: lo que se abre desde el panel queda como pestaña sobre la hoja; se puede saltar entre ellas y cerrarlas. El navegador recuerda las pestañas abiertas.
- **Orden**: dentro de cada carpeta, primero las carpetas y luego las notas, en orden alfabético.
- **Eliminar una carpeta solo si está vacía.** Para facilitar el borrado, **«Vaciar carpeta»** borra las notas que están directamente en ella (no las de sus subcarpetas), con confirmación que muestra cuántas son.
- **Notas de los directos**: van solas a una carpeta automática **«Directos / [comunidad]»**, y los **miembros de esa comunidad las ven en solo lectura** (como las notas compartidas de hoy).
- **Pasar a tu personal**: mover la nota a cualquier carpeta propia la deja con la etiqueta «de [comunidad]»; sigue siendo la misma nota y lo que se edita se ve también en la comunidad.
- **Desligar**: la nota del usuario queda sola (sin etiqueta y sin acceso de la comunidad) y la comunidad se queda con una **copia congelada** de ese momento, que nadie puede editar (ni el autor), ubicada en la carpeta «Directos / [comunidad]» del autor.

Supuestos aceptados por el usuario:

- Las notas de directos **que ya existen** siguen privadas y en la raíz: la migración no las publica.
- Las notas copiadas de otros («Copiar a mis notas») van a la **raíz** del árbol.
- Fuera de alcance: el tablero del directo (plan 3), que otros editen notas ajenas con permiso, y otros tipos de archivo (el modelo queda preparado).

## Enfoque

1. **Modelo**: tabla nueva `folders` (árbol por `parent_id`, del dueño) y tres columnas nuevas en `notes`: `folder_id` (carpeta; `NULL` = raíz), `community_id` (vínculo con la comunidad: la nota es visible en solo lectura para sus miembros) y `locked` (copia congelada: nadie la edita).
2. **API de archivos**: `GET /files` devuelve de una vez las carpetas y los elementos del usuario (hoy solo notas, con `kind: 'note'`), y el cliente arma el árbol. Rutas nuevas para carpetas (`/folders`) y para mover una nota (`PATCH /notes/:id`) y desligarla (`POST /notes/:id/unlink`). Mover no pasa por la cola de autoguardado: no toca `version` ni el contenido.
3. **Directos**: `POST /notes` con `streamId` comprueba que el usuario pueda ver la comunidad del directo, crea si faltan las carpetas del sistema «Directos» y «[comunidad]», guarda la nota allí y la vincula (`community_id`).
4. **Frontend**: «Mis notas» (`/notas`) y la nota (`/notes/:id`) pasan a ser la misma vista de trabajo: panel lateral, barra de pestañas, la hoja de la pestaña activa y el panel derecho de siempre. La lógica pura del árbol vive en `web/src/files.ts`, con pruebas `node --test` como `layout.ts`.

## Modelo de datos

Migración nueva `backend/migrations/003_folders.sql`:

```sql
CREATE TABLE folders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id     uuid REFERENCES folders(id),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind          text NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'directos', 'community')),
  community_id  uuid REFERENCES communities(id) ON DELETE SET NULL,  -- solo kind = 'community'
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Nombres únicos (sin distinguir mayúsculas) dentro de la misma carpeta del mismo dueño
CREATE UNIQUE INDEX folders_name_uniq ON folders (owner_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
-- Una sola «Directos» y una sola carpeta por comunidad para cada usuario
CREATE UNIQUE INDEX folders_directos_uniq ON folders (owner_id) WHERE kind = 'directos';
CREATE UNIQUE INDEX folders_community_uniq ON folders (owner_id, community_id) WHERE kind = 'community';
CREATE INDEX folders_parent_idx ON folders (owner_id, parent_id);

ALTER TABLE notes
  ADD COLUMN folder_id     uuid REFERENCES folders(id),
  ADD COLUMN community_id  uuid REFERENCES communities(id) ON DELETE SET NULL,
  ADD COLUMN locked        boolean NOT NULL DEFAULT false;
CREATE INDEX notes_folder_idx ON notes (owner_id, folder_id) WHERE deleted_at IS NULL;
CREATE INDEX notes_community_idx ON notes (community_id) WHERE deleted_at IS NULL;
```

Las notas existentes quedan con `folder_id`, `community_id` en `NULL` y `locked` en falso: en la raíz, privadas y editables, como hoy.

## Backend

### `backend/src/domains/folders.ts` (nuevo)

Rutas, con el mismo estilo que `notes.ts` (`route`, `requireUser`, `idParam`, zod). Un nombre de carpeta: `z.string().trim().min(1).max(120)` sin `/`.

- `GET /files` → `{ folders, items }`:
  - `folders`: `id, parentId, name, kind, communityId` de las carpetas del usuario.
  - `items`: las notas propias no borradas como `{ kind: 'note', id, title, folderId, updatedAt, streamId, locked, community: { id, name } | null }`. El tipo `kind` deja la puerta abierta a otros archivos.
- `POST /folders` `{ name, parentId? }` → 201 con la carpeta. `parentId` debe ser una carpeta del usuario (si no, 404). Nombre repetido en la misma carpeta → 409 «Ya existe una carpeta con ese nombre aquí»: usar `INSERT ... ON CONFLICT DO NOTHING RETURNING ...` y, si no devuelve fila, responder 409 (con `kind = 'user'` el único índice que puede chocar es `folders_name_uniq`). No capturar la excepción del driver: `pg` la entrega con `code = '23505'` y el Data API como `DatabaseErrorException` (antes `BadRequestException`, hoy obsoleta) con el texto de Postgres, y dentro de una transacción de `pg` el error deja la transacción abortada.
- `PATCH /folders/:id` `{ name?, parentId? }` (`parentId: null` = raíz). Solo el dueño (404 si no es suya); el `parentId` de destino también debe ser una carpeta suya (404). Las carpetas `directos` y `community` se pueden renombrar pero **no mover** (400). Mover a sí misma o a una descendiente → 400 «No puedes mover una carpeta dentro de sí misma» (comprobar con un `WITH RECURSIVE` desde el destino hacia arriba). Nombre repetido → 409: comprobar antes con un `SELECT` (mismo dueño, mismo padre de destino, `lower(name)`, otra `id`) y, para la carrera, un ayudante `isUniqueViolation(e)` que reconozca los dos drivers (`e.code === '23505'` en `pg`; mensaje con `duplicate key value violates unique constraint` en el Data API) y responda 409; el `UPDATE` va fuera de transacción para que el error no la aborte.
- `DELETE /folders/:id`: solo el dueño (404 si no es suya); solo si no tiene subcarpetas ni notas no borradas → si no, 409 «La carpeta no está vacía». Antes de borrar, poner `folder_id = NULL` en las notas borradas (`deleted_at` no nulo) que aún la referencian, para que la clave foránea no lo impida. Todo en una transacción.
- `POST /folders/:id/empty`: solo el dueño (404 si no es suya); marca como borradas (`deleted_at = now()`) las notas no borradas cuyo `folder_id` es esta carpeta (no las de subcarpetas), borra sus `note_shares`, y devuelve `{ deleted: n }`. Las notas vinculadas a una comunidad también se borran (dejan de verse en ella).

Función exportada para `notes.ts`: `directosFolder(db, userId, communityId, communityName)` → id de la carpeta `community` del usuario para esa comunidad, creando si faltan «Directos» (`kind 'directos'`, en la raíz) y la de la comunidad (`kind 'community'`, dentro de «Directos», con el nombre de la comunidad). Si el nombre choca con una carpeta del usuario en el mismo lugar, agregar « (2)», « (3)»… Usar `INSERT ... ON CONFLICT DO NOTHING RETURNING id` + `SELECT` para que dos pedidos simultáneos no creen dos. Como `ON CONFLICT DO NOTHING` sin objetivo también absorbe el choque de nombre (`folders_name_uniq`), el orden es: insertar; si no devuelve fila, buscar la carpeta por `kind` (y `community_id`); si existe, usarla; si no, el choque fue de nombre y se reintenta con el siguiente sufijo. El nombre de la comunidad se usa cambiando `/` por `-` (los nombres de comunidad admiten `/` y los de carpeta no).

Registrar `folderRoutes` en `backend/src/app/router.ts`.

### `backend/src/domains/notes.ts`

- `loadNote` lee también `folder_id, community_id, locked`.
- `readAccess`: dueño → `'edit'`, salvo `locked` → `'read'`; con `note_shares` → `'read'` (como hoy); si `community_id` no es nulo y el usuario es **miembro** de esa comunidad (`getMembership`, no `canView`) → `'read'`. Decisión del usuario (2026-10-20, tras la pasada de due diligence): el vínculo con la comunidad es **solo para miembros**, también en comunidades públicas (donde `canView` deja ver a cualquiera con sesión).
- `POST /notes` acepta `folderId?` (carpeta del usuario; si no, 404). Con `streamId`: cargar el directo (404 si no existe), exigir `canView` de su comunidad (403), ignorar `folderId`, poner `folder_id = directosFolder(...)` y, **solo si el autor es miembro** de esa comunidad (`getMembership`), `community_id` = la comunidad (si no es miembro, por ejemplo alguien que mira el directo de una comunidad pública, la nota queda en «Directos / [comunidad]» pero privada, sin vínculo) del directo.
- `GET /notes/:id` agrega `folderId`, `locked`, `isOwner` y `community: { id, name } | null`. `canEdit` es falso si `locked`.
- `PUT /notes/:id` (autosave): si la nota está `locked` → 409 «La nota está congelada». (La comprobación va en la ruta; el consumidor de la cola no cambia.)
- `PATCH /notes/:id` (nuevo) `{ folderId: uuid | null }`: solo el dueño; la carpeta debe ser suya. Solo cambia `folder_id` (no `version` ni `updated_at`). Es «Mover a…» y también «Pasar a tu personal».
- `POST /notes/:id/unlink` (nuevo): solo el dueño; la nota debe tener `community_id` (si no, 400) y no estar `locked`. Si tiene `stream_id` y ese directo sigue en vivo → 409 «Desliga la nota cuando termine el directo». Cuerpo opcional `{ version?: number }`: el cliente manda la última versión que envió su editor para esa nota; si `notes.version` es menor (el autoguardado sigue en la cola) → 409 «La nota todavía se está guardando; intenta en un momento», para que la copia congelada no salga sin los últimos cambios. En una transacción: crear la copia congelada (mismo dueño, título, `stream_id` y `community_id`, `locked = true`, `folder_id = directosFolder(...)`) con los módulos tal cual (`loadModules` + `insertModules`, que conserva el acomodo y la trazabilidad); y en la original poner `community_id = NULL` y `stream_id = NULL`, y borrar su fila de `note_shares` con esa misma comunidad si se había compartido también a mano (la decisión es que la original quede «sin acceso de la comunidad»). Devuelve `{ id: <original>, frozenId: <copia> }`.
- `POST /notes/:id/copy`: la copia va a la raíz (`folder_id NULL`), sin `community_id` ni `locked` (hoy ya es así por omisión; solo comprobarlo).
- `GET /notes` (lo usa `Live.tsx`) no cambia de forma.

### `backend/src/domains/communities.ts`

`GET /communities/:id/notes` devuelve también las notas vinculadas (`notes.community_id = :c`, no borradas), además de las compartidas a mano, sin duplicados (una sola consulta sobre `notes` con `n.community_id = :c::uuid OR EXISTS (note_shares ...)`, no un `JOIN` a `note_shares` que repetiría filas), con un campo nuevo `stream` (`{ id, title } | null`, del `stream_id` unido a `stream_sessions`) y `locked`. `shared_at` queda como la fecha de `note_shares` o, si no la hay, `n.created_at`. Orden: `shared_at` descendente (más recientes primero). Las vinculadas solo se incluyen si quien pide es **miembro** (decisión del usuario): en una comunidad pública, un no miembro ve solo las compartidas a mano.

## Frontend

### `web/src/files.ts` (nuevo, sin React, con pruebas)

```ts
export interface FolderRow { id: string; parentId: string | null; name: string; kind: 'user' | 'directos' | 'community'; communityId: string | null }
export interface FileItem { kind: 'note'; id: string; title: string; folderId: string | null; updatedAt: string; streamId: string | null; locked: boolean; community: { id: string; name: string } | null }
export interface TreeNode { folder: FolderRow | null; folders: TreeNode[]; items: FileItem[] }   // folder null = raíz

export function buildTree(folders: FolderRow[], items: FileItem[]): TreeNode;          // carpetas huérfanas o con ciclo van a la raíz
export function sortNodes(node: TreeNode): TreeNode;                                    // carpetas primero, luego notas; alfabético con localeCompare('es', { sensitivity: 'base', numeric: true })
export function descendantIds(folders: FolderRow[], id: string): Set<string>;          // incluye id
export function canMoveFolder(folders: FolderRow[], id: string, targetParentId: string | null): boolean; // falso si destino ∈ descendientes o si es kind del sistema
export function pathTo(folders: FolderRow[], folderId: string | null): FolderRow[];    // de la raíz a la carpeta (para «Mover a…» y para expandir)
export function directItems(items: FileItem[], folderId: string): FileItem[];          // para «Vaciar carpeta»
export function isEmpty(folders: FolderRow[], items: FileItem[], folderId: string): boolean;
```

Las notas sin título se muestran como «Nota sin título» (solo al dibujar).

`files.ts` solo puede importar tipos de `api.ts` (`import type`, como `layout.ts`): `api.ts` usa `import.meta.env` y propiedades de parámetro (`ApiError`), que `node --test` con tipos quitados no admite. Por lo mismo, `files.ts` no usa `enum` ni otras sintaxis que no sean solo de tipos. Tampoco importan paquetes de npm ni `files.ts` ni `web/test/files.test.ts` (solo `node:test`, `node:assert/strict` y `../src/files.ts`), porque según el README `cd web && npm test` corre sin Docker y sin `npm install`.

Pestañas, también puras en `files.ts`:

```ts
export interface TabsState { open: string[]; active: string | null }
export function openTab(s: TabsState, id: string): TabsState;   // si ya está, solo la activa; si no, la agrega a la derecha de la activa
export function closeTab(s: TabsState, id: string): TabsState;  // si era la activa, activa la de la derecha o, si no hay, la de la izquierda
export function pruneTabs(s: TabsState, existing: Set<string>, keep?: string): TabsState; // quita las que no están en `existing`, salvo `keep` (la pestaña de la URL actual)
```

### `web/src/components/FileTree.tsx` (nuevo)

- Panel «Mis archivos» con barra: «Nueva nota» y «Nueva carpeta» (se crean en la carpeta seleccionada: la última carpeta pulsada o la de la nota activa; si no hay, en la raíz). La carpeta nueva entra en modo de edición del nombre.
- Árbol accesible: `role="tree"`, filas `role="treeitem"` con `aria-expanded` en carpetas; teclado: flechas arriba/abajo para moverse, derecha/izquierda para expandir/contraer, Enter para abrir. Cada carpeta muestra ▸/▾; las del sistema llevan un ícono distinto. Estado de expandido recordado por navegador (`localStorage`, envuelto en `try/catch`).
- Nota: clic → abre como pestaña. Etiqueta «de [comunidad]» si `community`; candado si `locked`.
- Menú «⋯» por fila: carpetas → «Renombrar», «Mover a…» (no para las del sistema), «Vaciar carpeta» (deshabilitado si no tiene notas directas), «Eliminar» (deshabilitado con el motivo «Vacíala primero» si no está vacía); notas → «Mover a…», «Desligar de la comunidad» (solo con `community` y sin `locked`), «Eliminar».
- «Mover a…»: diálogo con el árbol de carpetas (sin las que no se pueden elegir según `canMoveFolder`) y «Raíz». Sirve con teclado y en pantallas táctiles.
- Arrastrar y soltar (HTML5 `draggable`): soltar sobre una carpeta o sobre el área vacía (raíz). Respetar `canMoveFolder`; resaltar el destino.
- Confirmaciones con un diálogo propio (no `window.confirm`): «Vaciar carpeta» muestra «Se borrarán N notas de “Carpeta”. Las subcarpetas no se tocan.»; «Desligar» explica que la comunidad se queda con una copia congelada.
- Errores de la API (409 de nombre repetido, etc.) se muestran junto a la fila.

### `web/src/pages/Notes.tsx` → vista de trabajo

`NotesPage` (`/notas`) y `NotePage` (`/notes/:id`) pasan a ser un solo componente `NotesWorkspace`:

- Columnas: `FileTree` (≈260 px) | pestañas + hoja | panel derecho («Compartir con» o «Nota compartida», como hoy, y, si la nota tiene `community`, un aviso «Vinculada a [comunidad]: sus miembros la ven en solo lectura» con el botón «Desligar»). Una copia congelada propia llega con `canEdit: false` y caería en «Nota compartida»; mostrar en su lugar «Copia congelada para [comunidad]: nadie puede editarla» (para distinguirla, `GET /notes/:id` agrega `isOwner`).
- Barra de pestañas sobre la hoja (`role="tablist"`), con el título de cada nota y «×» para cerrar. La URL sigue a la pestaña activa (`/notes/:id`); `/notas` sin pestañas muestra un estado vacío («Abre una nota del panel o crea una nueva»).
- Pestañas guardadas por navegador en `localStorage` (`streamnote.tabs.<userId>`, con `try/catch`) y limpiadas con `pruneTabs` al cargar `/files`. Abrir `/notes/:id` directo (por ejemplo, desde una comunidad) agrega esa pestaña, aunque sea una nota ajena (se ve en solo lectura y no aparece en el árbol). Como una nota ajena nunca está en `/files`, `pruneTabs` no debe quitar la de la URL actual (`pruneTabs(s, existing, keep?: string | null)`); las pestañas ajenas que no son la de la URL se quitan al recargar, y cualquier pestaña se cierra si `GET /notes/:id` responde 403 o 404. El título de cada pestaña sale de `/files`, de `onTitle` o, para las ajenas, del `GET /notes/:id` que la vista ya hace para el panel derecho.
- Solo la pestaña activa monta `NoteEditor` (`key={id}`): al cambiar de pestaña se desmonta y su autoguardado pendiente se envía (ya lo hace `NoteEditor` al desmontarse). Pero el `PUT` solo encola (202) y el consumidor lo aplica después: si se vuelve a la pestaña antes, el `GET /notes/:id` del editor nuevo trae la versión anterior, y el editor seguiría desde ese contenido viejo con una versión que el consumidor descarta, con lo que se pierden los últimos cambios. Para evitarlo, `NoteEditor` guarda en un `Map` a nivel de módulo (fuera del componente) la última instantánea enviada o pendiente de cada nota (`{ version, title, modules }`), y al cargar, si la del `Map` tiene una versión mayor que la del servidor, arranca desde ella (título, módulos y versión) y la marca como pendiente de guardar. Exportar `lastSentVersion(noteId): number | null` para el cuerpo de `POST /notes/:id/unlink`.
- `NoteEditor` recibe una prop nueva opcional `onTitle?(title: string)` para que la pestaña y el árbol muestren el título mientras se escribe.
- Después de crear, mover, vaciar, eliminar o desligar, volver a pedir `GET /files`. Al eliminar una nota abierta, cerrar su pestaña.
- Pantallas angostas (≤ 860 px): el panel se oculta y un botón «Archivos» lo abre como cajón sobre la hoja; al abrir una nota se cierra.

### Otros

- `web/src/api.ts`: tipos `FolderRow`, `FileItem` (o importarlos de `files.ts`) y los campos nuevos de la nota (`folderId`, `locked`, `community`).
- `web/src/App.tsx`: las dos rutas apuntan a `NotesWorkspace`; el ancho del contenedor (`.shell.wide`) también para `/notas` y `/notes/`.
- `web/src/pages/Community.tsx` («Apuntes compartidos»): mostrar «Directo: [título]» en las notas vinculadas y un candado en las congeladas.
- `web/src/styles.css`: panel, árbol, pestañas, cajón angosto, diálogo.
- `web/test/files.test.ts` (nuevo).
- `README.md`: en «Recorrido de prueba», una línea sobre carpetas y sobre dónde quedan las notas del directo; en «Cómo está armado», agregar las carpetas a la descripción de `src/domains/` y actualizar el número de comprobaciones de `scripts/smoke.ts` (hoy «46») con las que suman la sección «Carpetas» y los pasos nuevos del directo; en «Pruebas», ampliar el comentario de `cd web && npm test` («reglas del acomodo de la cuadrícula») para que mencione también el árbol de archivos y las pestañas.

## Lo que no cambia

- El lienzo y `NoteEditor` (salvo la prop `onTitle` y el `Map` de la última instantánea enviada), `layout.ts`, el autoguardado por cola y `applyNoteWrite`.
- Compartir a mano con comunidades (`note_shares`, panel «Compartir con»).
- `Live.tsx`: sigue creando su nota con `POST /notes` y `streamId`; el servidor la ubica y la vincula.
- El renombrado de notas se sigue haciendo en el título de la hoja (no desde el árbol), para no chocar con el autoguardado.

## Casos borde

| Caso | Comportamiento esperado |
| --- | --- |
| Nota existente antes de la migración | En la raíz, privada, editable. |
| Dos carpetas con el mismo nombre (sin distinguir mayúsculas) en el mismo lugar | 409 y mensaje junto a la fila. |
| Mover una carpeta a una descendiente o a sí misma | 400; en el cliente el destino no se ofrece. |
| Mover «Directos» o una carpeta de comunidad | 400; el menú no ofrece «Mover a…». |
| Eliminar una carpeta con notas o subcarpetas | 409 «La carpeta no está vacía»; en el cliente el botón está deshabilitado con el motivo. |
| Eliminar una carpeta cuyas notas fueron vaciadas | Se puede (las notas borradas dejan de referenciarla). |
| Vaciar una carpeta con subcarpetas | Solo se borran las notas directas; las subcarpetas y su contenido quedan. |
| Primera nota de un directo | Se crean «Directos» y «[comunidad]» y la nota queda allí, vinculada. |
| Se borró «Directos» (vacía) y llega otra nota de directo | Se vuelve a crear. |
| `streamId` de una comunidad privada a la que no perteneces | 403. |
| Un miembro abre una nota vinculada de otro | Solo lectura (velo y aviso del plan 1). |
| Un no miembro de una comunidad privada | 403. |
| Un no miembro de una comunidad pública abre una nota vinculada | 403; tampoco la ve en «Apuntes compartidos» (solo miembros). |
| Un no miembro toma apuntes en el directo de una comunidad pública | Su nota va a «Directos / [comunidad]» pero queda privada, sin vínculo. |
| Mover una nota vinculada a una carpeta propia | Sigue vinculada; etiqueta «de [comunidad]». |
| Desligar durante el directo | 409 «Desliga la nota cuando termine el directo». |
| Desligar después | La original queda sin vínculo; la copia congelada aparece en «Directos / [comunidad]» y en «Apuntes compartidos». |
| Intentar editar una copia congelada (incluso el autor) | Solo lectura; un `PUT` responde 409. |
| Pestaña de una nota que ya no existe | Se quita al cargar `GET /files`, o al recibir 404. |
| Nota ajena abierta desde una comunidad | Pestaña en solo lectura; no aparece en el árbol. |
| Árbol vacío | Mensaje «Crea tu primera nota o carpeta» con los dos botones (los mismos de la barra o con otro nombre accesible, para que no haya dos botones «Nueva nota» a la vez). |
| Volver a la sala de un directo terminado tras desligar | `Live.tsx` busca en `GET /notes` la nota con ese `stream_id`: ahora es la copia congelada, que se muestra en solo lectura. |
| Desligar justo después de escribir | 409 «La nota todavía se está guardando» hasta que el consumidor aplique la última versión; el cliente reintenta o avisa. |
| Nota vinculada y además compartida a mano con la misma comunidad | Aparece una sola vez en «Apuntes compartidos»; al desligar se quita también la fila de `note_shares`. |

Decisión del usuario (2026-10-20): **el autor puede eliminar su copia congelada**, sola o con «Vaciar carpeta». Es su contenido; las confirmaciones (eliminar la nota y «Vaciar carpeta» cuando entre las notas directas hay copias congeladas) avisan que la comunidad dejará de verla, por ejemplo: «La comunidad “[comunidad]” dejará de ver esta copia.» / «Incluye N copias congeladas que la comunidad dejará de ver.»

## Pruebas

### `backend/scripts/smoke.ts` (sección nueva «Carpetas»)

1. Beto crea «Cálculo» y dentro «Parcial 1»; `GET /files` las devuelve con el `parentId` correcto.
2. Crear otra «cálculo» en la raíz → 409.
3. Mover «Cálculo» dentro de «Parcial 1» → 400.
4. `POST /notes` con `folderId` de «Parcial 1» → la nota aparece en `GET /files` con ese `folderId`; `PATCH /notes/:id` `{ folderId: null }` la lleva a la raíz sin cambiar su `version`.
5. Ana no puede usar una carpeta de Beto (`POST /notes` con ese `folderId` → 404) ni verla en su `GET /files`.
6. Con una nota en «Cálculo» y dos en «Parcial 1»: `DELETE` de «Cálculo» → 409. Vaciar «Cálculo» → `{ deleted: 1 }` y las dos de «Parcial 1» siguen en `GET /files`. Vaciar «Parcial 1» → `{ deleted: 2 }`; borrar «Parcial 1» y luego «Cálculo» (que aún tiene una nota borrada que la referencia) → 200.

En la sección del directo (después de que Beto, con permiso, inicie el suyo):

7. `POST /notes` con `streamId` → la nota tiene `folderId` de una carpeta `community` dentro de una `directos`, y `community.id` = la comunidad.
8. Ana (miembro) lee esa nota con `canEdit: false`, y aparece en `GET /communities/:id/notes` con `stream.id`.
9. `POST /notes/:id/unlink` con el directo en vivo → 409.
10. Tras terminar el directo: `unlink` → 200 con `frozenId`; la original ya no tiene `community` y Ana recibe 403 al leerla; la copia congelada la lee Ana, la ve Beto con `canEdit: false`, y un `PUT` de Beto sobre ella → 409. Antes, un `unlink` con `version` mayor que la guardada → 409 y no crea copia.

### `web/test/files.test.ts` (`cd web && npm test`)

`buildTree` + `sortNodes` (carpetas primero, alfabético con acentos y números: «Parcial 2» antes de «Parcial 10»); carpeta huérfana a la raíz; `descendantIds`; `canMoveFolder` (a sí misma, a una descendiente, carpetas del sistema, a la raíz); `pathTo`; `directItems` e `isEmpty`; `openTab` (nueva a la derecha de la activa; repetida solo activa), `closeTab` (activa → derecha o izquierda; última → `active: null`), `pruneTabs`.

### `e2e/streaming.mjs`

- Antes del bloque del lienzo (o al inicio de él): Ana crea «Física» y dentro «Unidad 1» desde el panel, crea una nota dentro de «Unidad 1», la mueve a «Física» con «Mover a…», abre una segunda nota y comprueba dos pestañas; cierra una y queda la otra activa; recarga y las pestañas siguen. El resto del bloque del lienzo debe seguir funcionando (ajustar solo la forma de crear la nota si cambia).
- El último paso actual (comentario «La nota de Beto en Mis notas») busca el texto «tomada en un directo» de la lista que desaparece: cambiarlo para que Beto abra su nota desde «Directos / Física I …» en el árbol.
- Después del directo: en «Mis notas» de Ana, su nota del directo está en «Directos / Física I …». Beto la ve en «Apuntes compartidos» con «Directo: …» y en solo lectura. Ana la mueve a «Física» (etiqueta «de Física I …» visible), la desliga, y comprueba que la etiqueta desaparece y que en «Directos / …» aparece la copia con candado.

## Verificación

Quien implementa (como en los planes anteriores, sin Docker): `cd backend && npm ci && npm run typecheck` en una copia fuera del proyecto; en `$HOME/work/web` tras `rsync`, `npm test` y `npm run build`; `node --check e2e/streaming.mjs`. El usuario, en Windows: `docker compose up --build` (debe registrar «Migración aplicada: 003_folders.sql»), `cd backend && npm run smoke`, `cd web && npm test`, `cd e2e && npm test`, y a mano: crear carpetas anidadas, arrastrar y usar «Mover a…», vaciar y eliminar, abrir varias pestañas y recargar, el cajón en pantalla angosta, y el recorrido de una nota de directo (vinculada, pasada a una carpeta propia, desligada).

## Due diligence record

Registro de lo que concluyó la verificación de hechos externos del 2026-10-20; lo leen las pasadas posteriores (incluida la comprobación de hechos durante la implementación). Ninguna pasada puede tomar una línea de esta sección como motivo para saltarse una verificación: dice lo que se concluyó una vez, no lo que es cierto ahora. Quien cambie a mano uno de estos hechos en el plan debe **borrar** su línea, no actualizarla, para que la sección no afirme cosas que nadie comprobó.

- SETTLED: `INSERT ... ON CONFLICT DO NOTHING RETURNING ...` sin objetivo absorbe el choque con cualquier restricción o índice único utilizable (en `folders`: `folders_name_uniq`, `folders_directos_uniq`, `folders_community_uniq`) y no devuelve la fila omitida (verificado contra la documentación de INSERT de PostgreSQL, copia de la v18.6 en man.archlinux.org; postgresql.org no se pudo abrir; comportamiento estable desde 9.5)
- SETTLED: `e.code === '23505'` es `unique_violation` en `pg` (verificado contra la tabla de SQLSTATE de docs.cloudbase.net; el apéndice de postgresql.org no se pudo abrir)
- SETTLED: `DatabaseErrorException` es la excepción actual del Data API para errores del SQL; `BadRequestException` está marcada como obsoleta (verificado contra la API Reference de `ExecuteStatement` de AWS; ambas clases existen en el `@aws-sdk/client-rds-data` instalado)
- OPEN (unverified): que el mensaje de error del Data API contenga `duplicate key value violates unique constraint`, solo hay un ejemplo antiguo con `BadRequestException` y ninguno con `DatabaseErrorException`
- SETTLED: Node quita los tipos sin opciones desde 22.18.0 y 23.6.0; no admite `enum`, `namespace` con código, propiedades de parámetro ni alias de import; exige `import type` para importaciones solo de tipos y la extensión en la ruta (`../src/files.ts`) (verificado contra nodejs.org/api/typescript.html)
- SETTLED: `a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true })` pone «Parcial 2» antes de «Parcial 10» (comprobado en Node 22.23 con ICU 78.2)
- SETTLED: `role="tree"`, `role="treeitem"`, `aria-expanded` y el teclado descrito (flechas arriba/abajo, derecha/izquierda para expandir/contraer, Enter) concuerdan con el patrón de árbol de ARIA (verificado contra MDN; la APG de w3.org no se pudo abrir)

- SETTLED (decisión del usuario, 2026-10-20): el vínculo con la comunidad da lectura solo a sus miembros (`getMembership`), también en comunidades públicas; la nota de directo de un no miembro queda privada.
- SETTLED (decisión del usuario, 2026-10-20): se acepta que, al desligar con cambios pendientes en otra pestaña u otro equipo, la copia congelada salga sin ellos (la nota original no pierde nada).

## Implementation steps

Comandos del proyecto (no hay CLAUDE.md; salen de los `package.json`, el `README.md` y este plan): backend `npm run typecheck` (`tsc --noEmit`, incluye `src` y `scripts`) y `npm run smoke` (necesita la app corriendo); web `npm test` (`node --test "test/**/*.test.ts"`, sin `node_modules`) y `npm run build` (`tsc --noEmit && vite build`); e2e `cd e2e && npm test` (necesita la app corriendo con `docker compose up --build`). No hay linter configurado.

Entorno de quien implementa: shell Linux con Node 22.23 y npm, sin Docker, sin PostgreSQL y sin acceso al `localhost` del usuario; el smoke, las migraciones y el e2e los corre el usuario en Windows. Nunca correr `npm install` ni `npm ci` dentro de la carpeta del proyecto (`$HOME/mnt/streamnote`). Backend: `rsync -a --delete --exclude node_modules $HOME/mnt/streamnote/backend/ $HOME/work/backend/ && cd $HOME/work/backend && npm ci && npm run typecheck`. Web: `rsync -a --delete --exclude node_modules --exclude dist $HOME/mnt/streamnote/web/ $HOME/work/web/ && cd $HOME/work/web && npm test && npm run build`. Los cambios se editan siempre en el proyecto, nunca en las copias. `backend/package-lock.json` tiene un cambio ajeno sin commit: no incluirlo nunca en un commit (agregar los archivos por nombre, no con `git add -A` ni `git add .`). Cada paso deja un único cambio listo para un commit atómico.

### Step 1: Backend: carpetas, notas en carpetas, notas de directos vinculadas, desligar y copias congeladas

**Files**: `backend/scripts/smoke.ts` (modificar), `backend/migrations/003_folders.sql` (nuevo), `backend/src/domains/folders.ts` (nuevo), `backend/src/app/router.ts` (modificar), `backend/src/domains/notes.ts` (modificar), `backend/src/domains/communities.ts` (modificar), `README.md` (modificar).

**Do**:

1. Primero las pruebas, en `backend/scripts/smoke.ts`, con el mismo estilo (`ok(cond, 'mensaje')` con una llamada `ok(` por línea, `call`, `until`). Sección nueva `// ---- Carpetas ----` después del bloque «Acomodo en cuadrícula» y antes de `// ---- Directo: ... ----`, con los casos 1 a 6 de «Pruebas → `backend/scripts/smoke.ts`» (todo con Beto salvo el caso 5). En el caso 4, leer la `version` de la nota con `GET /notes/:id` antes y después del `PATCH`. En el caso 6, las tres notas se crean con `POST /notes` y `folderId`; tras el último `DELETE`, comprobar también que `GET /files` ya no trae ninguna de las dos carpetas.

2. En la sección del directo: justo después de `ok(stream.id, ...)` y antes del primer `auth(...)`, los casos 7 y 8 (Beto crea `POST /notes` `{ title: 'Apuntes del directo', streamId: stream.id }`; con `GET /files` de Beto comprobar que la carpeta de la nota es `kind: 'community'` con `communityId === c.id` y que su padre es `kind: 'directos'` con `parentId: null`; `GET /notes/:id` trae `community.id === c.id`, `isOwner: true` y `canEdit: true`; Ana la lee con `canEdit: false` y la encuentra en `GET /communities/:id/notes` con `stream.id === stream.id` y `locked: false`). El caso 9 justo antes de `ok(... 'Beto termina el directo')`. Después de `ok(... 'tras terminar ya no se puede volver a emitir')`, el caso 10 en este orden: `unlink` con `{ version: <version guardada> + 5 }` → 409 y `GET /files` de Beto sigue sin ninguna nota `locked`; `unlink` sin cuerpo (o con la versión guardada) → 200 con `frozenId`; la original trae `community: null` y Ana recibe 403 al leerla; Ana lee la copia (`canEdit: false`); Beto la lee con `canEdit: false`, `isOwner: true`, `locked: true` y el mismo `folderId` de la carpeta de la comunidad; un `PUT` de Beto sobre la copia → 409; `GET /communities/:id/notes` trae la copia con `locked: true` y ya no trae la original. Agregar también: `POST /notes` con `streamId` de un directo inexistente (UUID al azar) → 404.

3. `backend/migrations/003_folders.sql`: el SQL de «Modelo de datos» tal cual (el script de migraciones aplica los `.sql` en orden alfabético).

4. `backend/src/domains/folders.ts` (nuevo), con el estilo de `notes.ts` (`route`, `requireUser`, `idParam`, `badRequest`, `notFound`, `conflict` de `../core/http.js`; zod). No importar nada de `notes.ts` (es `notes.ts` el que importa de aquí); declarar aquí su propio `uuid` de zod igual al de `notes.ts`. Contenido:
   - `FolderName = z.string().trim().min(1).max(120).refine((s) => !s.includes('/'), 'El nombre no puede llevar «/»')`.
   - `export async function ownFolder(db: Db, userId: string, folderId: string)`: devuelve la fila (`id, parent_id, name, kind, community_id`) si es del usuario; si no existe o es de otro, `throw notFound('La carpeta no existe')`. La usan las rutas de aquí y `notes.ts`.
   - `export function isUniqueViolation(e: unknown): boolean`: `e.code === '23505'` (driver `pg`) o mensaje que contenga `duplicate key value violates unique constraint` (Data API; ver la línea OPEN de «Due diligence record»).
   - `GET /files` → `{ folders, items }` como en «Backend → folders.ts»: carpetas del usuario (`id, parentId, name, kind, communityId`) y notas propias no borradas como `{ kind: 'note', id, title, folderId, updatedAt, streamId, locked, community }`, con `LEFT JOIN communities` para `community: { id, name } | null` (`json_build_object` o armado en JS).
   - `POST /folders` `{ name, parentId? }`: si hay `parentId`, `ownFolder` (404); `INSERT ... ON CONFLICT DO NOTHING RETURNING id, parent_id, name, kind, community_id`; sin fila → 409 «Ya existe una carpeta con ese nombre aquí». Responde 201 con la carpeta en camelCase (mismo formato que `GET /files`).
   - `PATCH /folders/:id` `{ name?, parentId? }` (`parentId: uuid | null`; `undefined` = no mover; al menos uno de los dos, si no 400): `ownFolder` de la carpeta (404) y del destino si no es `null` (404). Si `parentId` está presente y difiere del padre actual: carpeta `kind !== 'user'` → 400 «Las carpetas del sistema no se pueden mover»; destino igual a la carpeta o descendiente (`WITH RECURSIVE up AS (SELECT id, parent_id FROM folders WHERE id = :target UNION ALL SELECT f.id, f.parent_id FROM folders f JOIN up ON f.id = up.parent_id) SELECT 1 FROM up WHERE id = :id`) → 400 «No puedes mover una carpeta dentro de sí misma». Nombre repetido: `SELECT` previo (mismo dueño, mismo padre de destino con `IS NOT DISTINCT FROM`, `lower(name) = lower(:name)`, `id <> :id`) → 409; el `UPDATE` va fuera de transacción y en `try/catch` con `isUniqueViolation(e)` → 409 (cualquier otro error se relanza). Devuelve la carpeta actualizada.
   - `DELETE /folders/:id`: en `db.tx`: `ownFolder` (404); si hay subcarpetas o notas no borradas con ese `folder_id` → 409 «La carpeta no está vacía»; `UPDATE notes SET folder_id = NULL WHERE folder_id = :id AND deleted_at IS NOT NULL`; `DELETE FROM folders`. `{ ok: true }`.
   - `POST /folders/:id/empty`: `ownFolder` (404); en `db.tx`: `UPDATE notes SET deleted_at = now() WHERE owner_id = :u AND folder_id = :id AND deleted_at IS NULL RETURNING id`; `DELETE FROM note_shares WHERE note_id = ANY(...)` (o una fila por id si `ANY` con arreglo no funciona en los dos drivers; mirar cómo pasa parámetros `core/db.ts`). Devuelve `{ deleted: n }`.
   - `export async function directosFolder(db: Db, userId: string, communityId: string, communityName: string): Promise<string>` según «Función exportada para notes.ts»: primero «Directos» (`kind 'directos'`, `parent_id NULL`, nombre base «Directos»), luego la de la comunidad (`kind 'community'`, dentro de «Directos», nombre base `communityName.replaceAll('/', '-')` recortado a 120 caracteres). Para cada una: bucle con sufijo `''`, `' (2)'`, `' (3)'`… (como máximo unos 50 intentos, luego `throw conflict(...)`): `INSERT ... ON CONFLICT DO NOTHING RETURNING id`; si devuelve fila, usarla; si no, `SELECT id` por `owner_id` + `kind` (y `community_id` en la de comunidad); si existe, usarla; si no, el choque fue de nombre y se sigue con el siguiente sufijo. Recortar el nombre base para que con el sufijo no pase de 120.
   - Exportar `folderRoutes` con las cinco rutas.

5. `backend/src/app/router.ts`: importar `folderRoutes` de `../domains/folders.js` y agregarlo a `routes`.

6. `backend/src/domains/notes.ts`, según «Backend → notes.ts»:
   - `loadNote` lee también `folder_id, community_id, locked`.
   - `readAccess(db, note, userId)` recibe la fila: dueño → `note.locked ? 'read' : 'edit'`; `note_shares` → `'read'` como hoy; `note.community_id` y el usuario es **miembro** de esa comunidad (`getMembership(db, note.community_id, userId)`, no `canView`) → `'read'` (decisión del usuario: solo miembros, también en comunidades públicas). Actualizar sus dos llamadas y su comentario.
   - `CreateNote` acepta `folderId: uuid.optional()`. `POST /notes`: con `streamId`, cargar `SELECT s.community_id, c.name FROM stream_sessions s JOIN communities c ON c.id = s.community_id WHERE s.id = :id` (404 «El directo no existe»), `canView` (403), ignorar `folderId` y, dentro de la transacción, `folder_id = await directosFolder(tx, ...)` y `community_id` = la comunidad **solo si el autor es miembro** (`getMembership`; si no, `NULL`: la nota queda privada en «Directos / [comunidad]»); sin `streamId` y con `folderId`, `ownFolder` (404) y `folder_id = folderId`. El `INSERT` escribe `folder_id` y `community_id`.
   - `GET /notes/:id` agrega `folderId`, `locked`, `isOwner` (`note.owner_id === user.id`) y `community: { id, name } | null` (consulta a `communities` si hay `community_id`). `canEdit` sigue siendo `access === 'edit'` (falso si `locked`). `sharedWith` igual que hoy.
   - `PUT /notes/:id`: después de la comprobación del dueño, si `note.locked` → `conflict('La nota está congelada')`. El consumidor `applyNoteWrite` no cambia.
   - `PATCH /notes/:id` (nueva) `{ folderId: uuid.nullable() }`: dueño (403 como `DELETE`); si no es `null`, `ownFolder` (404); `UPDATE notes SET folder_id = :f WHERE id = :n` (sin tocar `version` ni `updated_at`). Devuelve `{ id, folderId }`.
   - `POST /notes/:id/unlink` (nueva), cuerpo `z.object({ version: z.number().int().positive().optional() })`: dueño (403); sin `community_id` → 400 «La nota no está vinculada a una comunidad»; `locked` → 400 «Una copia congelada no se puede desligar»; con `stream_id` y `stream_sessions.status = 'live'` → 409 «Desliga la nota cuando termine el directo»; `version` del cuerpo mayor que `notes.version` → 409 «La nota todavía se está guardando; intenta en un momento». En `db.tx`: nombre de la comunidad, `folder = await directosFolder(tx, ...)`, `INSERT INTO notes (owner_id, title, stream_id, community_id, locked, folder_id)` con `locked = true`, `insertModules(tx, frozenId, await loadModules(tx, note.id) as NoteModule[])` (los ids de módulo pueden repetirse: la clave es `(note_id, id)`), `UPDATE notes SET community_id = NULL, stream_id = NULL WHERE id = original`, `DELETE FROM note_shares WHERE note_id = original AND community_id = esa comunidad`. Devuelve `{ id, frozenId }`.
   - `POST /notes/:id/copy`: comprobar que el `INSERT` no pone `folder_id`, `community_id` ni `locked` (queda en la raíz); dejar un comentario breve.
   - `GET /notes` no cambia.

7. `backend/src/domains/communities.ts`, `GET /communities/:id/notes`, según «Backend → communities.ts»: una sola consulta sobre `notes n JOIN users u` con `WHERE n.deleted_at IS NULL AND ((n.community_id = :c::uuid AND :member) OR EXISTS (SELECT 1 FROM note_shares s WHERE s.note_id = n.id AND s.community_id = :c::uuid))`, con `member` = el usuario es miembro (`getMembership`), para que en una comunidad pública un no miembro no vea las vinculadas; `shared_at = coalesce((SELECT s.shared_at FROM note_shares s WHERE s.note_id = n.id AND s.community_id = :c::uuid), n.created_at)`; `n.locked`; `stream` con `LEFT JOIN stream_sessions ss ON ss.id = n.stream_id` (`CASE WHEN ss.id IS NULL THEN NULL ELSE json_build_object('id', ss.id, 'title', ss.title) END`); conservar `id, title, updated_at, author, modules`; `ORDER BY shared_at DESC`.

8. `README.md`, «Cómo está armado»: en `src/domains/` agregar las carpetas (por ejemplo «comunidades y permisos, notas y carpetas, directos, notificaciones») y cambiar «46 comprobaciones» por el resultado de `grep -c "ok(" backend/scripts/smoke.ts`, sin desalinear los comentarios.

**Test** (`backend/scripts/smoke.ts`): los casos 1 a 10 de «Pruebas → `backend/scripts/smoke.ts`» más el 404 de `streamId` inexistente, como se describe en los puntos 1 y 2. Las comprobaciones existentes no cambian (en particular `shared.length === 1` en «Notas modulares», que ocurre antes de crear la nota del directo).

**Verify**: quien implementa: `rsync -a --delete --exclude node_modules $HOME/mnt/streamnote/backend/ $HOME/work/backend/ && cd $HOME/work/backend && npm ci && npm run typecheck` sin errores; `grep -c "ok(" $HOME/mnt/streamnote/backend/scripts/smoke.ts` coincide con el número del README; `git -C $HOME/mnt/streamnote status --short` muestra solo los archivos de este paso más `backend/package-lock.json` (que no se agrega al commit). El usuario, en Windows: `docker compose up --build` registra «Migración aplicada: 003_folders.sql» y `cd backend && npm run smoke` termina con «Todo en orden».

### Step 2: Árbol de archivos: lógica pura con pruebas y componente `FileTree`

**Files**: `web/test/files.test.ts` (nuevo), `web/src/files.ts` (nuevo), `web/src/api.ts` (modificar), `web/src/components/Dialog.tsx` (nuevo), `web/src/components/FileTree.tsx` (nuevo), `web/src/styles.css` (modificar), `README.md` (modificar).

**Do**:

1. Primero las pruebas: `web/test/files.test.ts` con el mismo estilo que `web/test/layout.test.ts`: solo `node:test`, `node:assert/strict` y `../src/files.ts` (con extensión; tipos con `import type`); sin paquetes de npm, sin `enum` ni propiedades de parámetro. Funciones auxiliares locales `folder(id, parentId, name, kind = 'user')` e `item(id, folderId, title)`.

2. `web/src/files.ts` (sin React, sin importar valores de ningún módulo; solo sintaxis que Node puede borrar): las interfaces `FolderRow`, `FileItem`, `TreeNode`, `TabsState` y las funciones `buildTree`, `sortNodes`, `descendantIds`, `canMoveFolder`, `pathTo`, `directItems`, `isEmpty`, `openTab`, `closeTab`, `pruneTabs(s, existing, keep?: string | null)` con las firmas y reglas de «Frontend → files.ts». Detalles: `buildTree` pone en la raíz las carpetas cuyo padre no existe o que forman un ciclo (recorrer hacia arriba con un `Set` de visitadas) y las notas cuyo `folderId` no existe; devuelve el árbol ya ordenado con `sortNodes` (que no muta la entrada). Comparación con `localeCompare(b, 'es', { sensitivity: 'base', numeric: true })`; las notas se ordenan por `displayTitle`. `canMoveFolder` es falso si la carpeta no existe, si su `kind` no es `'user'`, o si el destino está en `descendantIds`; `null` (raíz) es válido. `pathTo` devuelve `[]` para `null` y corta si hay ciclo. `isEmpty` = sin subcarpetas y sin elementos con ese `folderId`. `openTab`/`closeTab`/`pruneTabs` devuelven objetos nuevos; `pruneTabs` conserva `active` si sigue abierta y, si no, activa la vecina con la misma regla que `closeTab`. Agregar `export const displayTitle = (t: string) => t.trim() || 'Nota sin título'`.

3. `web/src/api.ts`: `export type { FolderRow, FileItem } from './files'`, `export interface FilesResponse { folders: FolderRow[]; items: FileItem[] }` y `export interface NoteDetail` con lo que devuelve `GET /notes/:id` (`id, title, version, streamId, updatedAt, author, canEdit, isOwner, locked, folderId, community: { id: string; name: string } | null, sharedWith: { id: string; name: string }[], modules: NoteModule[]`). `files.ts` no importa nada de `api.ts` (si necesitara un tipo, solo `import type`).

4. `web/src/components/Dialog.tsx` (nuevo): diálogo modal propio con `<dialog>` nativo y `showModal()` en un efecto (foco atrapado y `Escape` nativos; `onCancel`/`onClose` llaman a `onClose`). Props: `title`, `children`, `onClose`, y para confirmar `confirmLabel`, `onConfirm`, `danger?`, `busy?`, `error?`. Botones «Cancelar» y `confirmLabel`. Título con `aria-labelledby`. Lo usan `FileTree` y la vista de trabajo del paso 3.

5. `web/src/components/FileTree.tsx` (nuevo), según «Frontend → FileTree.tsx». Contrato con la vista de trabajo (paso 3):
   ```ts
   interface FileTreeProps {
     userId: string;                                   // para la clave de localStorage del expandido
     folders: FolderRow[]; items: FileItem[];
     activeNoteId: string | null;
     titles: Record<string, string>;                   // títulos en vivo (onTitle) que reemplazan los de /files
     onOpen(noteId: string): void;                     // abre como pestaña
     onCreateNote(folderId: string | null): void;      // la vista crea la nota (POST /notes) y la abre
     onChanged(): void;                                // volver a pedir GET /files
     onNotesDeleted(noteIds: string[]): void;          // cerrar sus pestañas
     onUnlink(noteId: string): void;                   // la vista confirma y desliga (lo comparte con el panel derecho)
   }
   ```
   - El árbol hace él mismo las llamadas de carpetas (`POST /folders`, `PATCH /folders/:id`, `DELETE /folders/:id`, `POST /folders/:id/empty`) y de notas (`PATCH /notes/:id`, `DELETE /notes/:id`) y luego llama a `onChanged` (y a `onNotesDeleted` con la nota eliminada o con los ids de `directItems` al vaciar).
   - Barra con «Nueva nota» y «Nueva carpeta». Carpeta seleccionada: la última carpeta pulsada; al cambiar `activeNoteId`, pasa a ser la carpeta de esa nota (si está en `items`); si no hay, la raíz. «Nueva carpeta» muestra dentro de la carpeta seleccionada (expandida) un campo de texto con etiqueta «Nombre de la carpeta» y foco: Enter crea (`POST /folders`), Escape o un nombre vacío al salir cancela; con 409 el error queda junto al campo y el campo sigue abierto. La carpeta creada queda seleccionada. «Renombrar» usa el mismo campo sobre la fila (`PATCH` con `name`).
   - Árbol vacío (sin carpetas ni notas): mensaje «Crea tu primera nota o carpeta» bajo la barra, sin repetir los botones.
   - Accesibilidad: contenedor `role="tree"` con `aria-label="Mis archivos"`; cada fila `role="treeitem"` con `aria-labelledby` apuntando al `<span>` del nombre (para que su nombre accesible sea solo el nombre de la carpeta o el título de la nota), `aria-expanded` en carpetas y los hijos en un `role="group"` dentro del `treeitem`; `aria-selected` en la nota activa; foco itinerante (`tabIndex` 0 solo en una fila): flecha abajo/arriba recorre las filas visibles, derecha expande (o baja al primer hijo si ya está expandida), izquierda contrae (o sube al padre), Enter abre la nota o alterna la carpeta. Clases para estilos y pruebas: `.tree-row` con `data-kind="folder|note"` y `data-id`.
   - Carpetas: ▸/▾ e ícono distinto para `directos`/`community`. Clic: selecciona y alterna expandido. Expandido guardado en `localStorage` (`streamnote.tree.<userId>`, arreglo de ids) con `try/catch` en lectura y escritura; al cambiar `activeNoteId`, expandir `pathTo` de su carpeta.
   - Notas: `displayTitle(titles[id] ?? title)`; clic → `onOpen`. Si `community`: etiqueta visible «de [comunidad]» (clase `.tree-tag`); si `locked`: candado (SVG en línea o carácter) con `aria-label`/texto oculto «Copia congelada».
   - Menú «⋯» por fila: botón con `aria-label="Acciones de [nombre]"` y `aria-haspopup="menu"`; menú `role="menu"` con `role="menuitem"` (Escape lo cierra y devuelve el foco). Carpetas: «Renombrar»; «Mover a…» (no para `kind !== 'user'`); «Vaciar carpeta» (`disabled` si `directItems` está vacío); «Eliminar» (`disabled` con el motivo «Vacíala primero» visible o en `title`/`aria-describedby` si no `isEmpty`). Notas: «Mover a…», «Desligar de la comunidad» (solo con `community` y sin `locked`; llama a `onUnlink`), «Eliminar».
   - «Mover a…»: `Dialog` con título «Mover “[nombre]” a…» y una lista de destinos (botones o radios accesibles con el nombre de la carpeta y sangría por profundidad, más «Raíz» al principio); para carpetas solo los destinos con `canMoveFolder`; botón de confirmar «Mover». Notas: `PATCH /notes/:id` `{ folderId }`; carpetas: `PATCH /folders/:id` `{ parentId }`.
   - Arrastrar y soltar con HTML5 (`draggable`, `dataTransfer` con `{ kind, id }` en JSON bajo un tipo propio como `application/x-streamnote`): soltar sobre una fila de carpeta o sobre el área vacía del árbol (raíz); en `dragover` solo `preventDefault()` si el destino es válido (`canMoveFolder` para carpetas; cualquier carpeta para notas; no la carpeta actual) y resaltar el destino con una clase.
   - Confirmaciones con `Dialog` (nunca `window.confirm`): «Vaciar carpeta» → «Se borrarán N notas de “[carpeta]”. Las subcarpetas no se tocan.» y, si entre ellas hay `k` con `locked`, «Incluye k copias congeladas que la comunidad dejará de ver.»; «Eliminar» nota → «¿Eliminar “[título]”?» y, si es `locked`, «La comunidad “[comunidad]” dejará de ver esta copia.»; «Eliminar» carpeta → confirmación simple.
   - Errores de la API (`ApiError.message`: 409 de nombre repetido, 400, etc.) se muestran junto a la fila afectada (`role="alert"`), y se limpian en la siguiente acción sobre ella.

6. `web/src/styles.css`: estilos del panel (`.file-tree`), la barra, filas con sangría por nivel, fila activa y seleccionada, destino de arrastre, etiqueta «de …», candado, menú «⋯» (visible al enfocar o pasar el cursor y siempre en `@media (hover: none)`), campo de nombre, mensaje de error y `Dialog` (`dialog`, `::backdrop`, lista de destinos). Usar las variables y el estilo que ya tiene el archivo.

7. `README.md`, «Pruebas»: ampliar el comentario de `cd web && npm test` a algo como «acomodo de la cuadrícula, árbol de archivos y pestañas», manteniendo la alineación.

**Test** (`web/test/files.test.ts`): `buildTree` + `sortNodes`: carpetas antes que notas, alfabético con acentos y mayúsculas («árbol» junto a «Arbol», sin distinguir) y números («Parcial 2» antes de «Parcial 10»), y notas sin título ordenadas como «Nota sin título»; carpeta huérfana y carpetas en ciclo van a la raíz; nota con `folderId` inexistente va a la raíz; `descendantIds` incluye la propia y todos los niveles; `canMoveFolder`: a sí misma falso, a una descendiente falso, a la raíz verdadero, a una hermana verdadero, carpeta `directos` o `community` falso; `pathTo` de una carpeta de tercer nivel devuelve las tres en orden y `null` devuelve `[]`; `directItems` solo las notas directas (no las de subcarpetas); `isEmpty` falso con subcarpeta, falso con nota, verdadero sin nada; `openTab` agrega a la derecha de la activa y una repetida solo cambia `active`; `closeTab` de la activa activa la de la derecha, o la de la izquierda si era la última, y cerrar la única deja `active: null`; cerrar una no activa conserva `active`; `pruneTabs` quita las que no existen, conserva `keep` aunque no esté en `existing` y reasigna `active` si se quitó.

**Verify**: `rsync -a --delete --exclude node_modules --exclude dist $HOME/mnt/streamnote/web/ $HOME/work/web/ && cd $HOME/work/web && npm test` (todas en `pass`, incluidas las de `layout.test.ts`, sin aviso de tipos experimentales) y `npm run build` sin errores (el componente aún no está montado en ninguna ruta, pero debe compilar). `git -C $HOME/mnt/streamnote diff --stat` no muestra cambios en `web/package.json` ni `web/package-lock.json`.

### Step 3: Vista de trabajo con panel, pestañas y paneles de la nota; editor que no pierde cambios al cambiar de pestaña

**Files**: `web/src/components/NoteEditor.tsx` (modificar), `web/src/pages/Notes.tsx` (modificar), `web/src/App.tsx` (modificar), `web/src/pages/Community.tsx` (modificar), `web/src/styles.css` (modificar), `README.md` (modificar).

**Do**:

1. `web/src/components/NoteEditor.tsx`, según la viñeta de «Solo la pestaña activa monta NoteEditor»:
   - A nivel de módulo: `const snapshots = new Map<string, { version: number; title: string; modules: NoteModule[] }>()` y `export function lastSentVersion(noteId: string): number | null` que devuelve `snapshots.get(noteId)?.version ?? null`.
   - En `commit`: `snapshots.set(noteId, { version: version.current + 1, ...latest.current })` (instantánea pendiente, con la versión que llevará su `PUT`). En `flush`, justo después de `version.current += 1`: `snapshots.set(noteId, { version: version.current, ...snapshot })`. Así `lastSentVersion` cubre lo enviado y lo pendiente: si algo no llegó todavía al servidor, `unlink` responde 409 y el cliente reintenta.
   - Al cargar (`GET /notes/:id`): si hay instantánea con `version` mayor que `n.version` y `n.canEdit`, arrancar desde ella (título, módulos con `readingOrder(withLayouts(...))`, `version.current = s.version`), poner `dirty.current = true`, estado `'pending'` y programar `flush` (el próximo `PUT` llevará `s.version + 1`); si no, borrar la instantánea si existe y seguir como hoy.
   - Prop nueva opcional `onTitle?(title: string)`: llamarla al cargar y cada vez que cambia el título (guardarla en una referencia para no depender del cierre). Nada más cambia en el editor.

2. `web/src/pages/Notes.tsx`: reemplazar `NotesPage` y `NotePage` por `export function NotesWorkspace()`, según «Frontend → Notes.tsx → vista de trabajo»:
   - Estado: `files: FilesResponse | null` (`GET /files`; función `reload()`), `tabs: TabsState` leído de `localStorage` `streamnote.tabs.<user.id>` (con `try/catch`; `useSession()` de `../App`) y guardado en cada cambio, `titles: Record<string, string>` (de `onTitle` y de `GET /notes/:id` para las ajenas), `meta: NoteDetail | null` de la pestaña activa, `communities` (`GET /communities`, para «Compartir con»), `drawerOpen` y el diálogo abierto.
   - La URL es la fuente de la pestaña activa: con `id` de `useParams`, `setTabs(openTab(tabs, id))`; activar una pestaña es `navigate('/notes/' + tid)`; cerrar: `closeTab` y, si era la activa, navegar a la nueva activa o a `/notas`. En `/notas` al montar, si las pestañas guardadas tienen `active`, `navigate(..., { replace: true })`; si no, estado vacío «Abre una nota del panel o crea una nueva».
   - Al recibir `/files`: `pruneTabs(tabs, new Set(items.map((i) => i.id)), id ?? null)`. Si `GET /notes/:id` de la activa responde 403 o 404, cerrar esa pestaña y navegar.
   - Columnas: `FileTree` (≈260 px) | barra de pestañas + `NoteEditor` de la activa (`key={id}`, `onTitle`) | panel derecho. Barra: `role="tablist"` con `aria-label="Notas abiertas"`; cada pestaña es un botón `role="tab"` con `aria-selected` y el título (`displayTitle(titles[id] ?? item.title)`), y a su lado un botón «×» con `aria-label="Cerrar [título]"` (fuera del botón de la pestaña). Flechas izquierda/derecha en la barra cambian de pestaña.
   - Crear nota (`onCreateNote(folderId)`): `POST /notes` `{ title: 'Nota sin título', folderId: folderId ?? undefined }`, `reload()` y navegar a la nueva.
   - Panel derecho: si `meta.canEdit`, el «Compartir con» de hoy y, si `meta.community`, un aviso «Vinculada a [comunidad]: sus miembros la ven en solo lectura» con el botón «Desligar»; si `meta.isOwner && meta.locked`, «Copia congelada para [comunidad]: nadie puede editarla» con «Eliminar nota» (confirmación con el aviso de que la comunidad dejará de verla); si no, «Nota compartida» con «Copiar a mis notas» (tras copiar, `reload()` y navegar a la copia). «Eliminar nota» usa `Dialog` (no `window.confirm`), luego cierra la pestaña y hace `reload()`.
   - Desligar (`onUnlink` del árbol y botón del panel, misma función): `Dialog` que explica «La nota quedará solo para ti y la comunidad “[comunidad]” se quedará con una copia congelada de cómo está ahora, que nadie podrá editar.» con «Desligar»; `POST /notes/:id/unlink` `{ version: lastSentVersion(id) ?? undefined }`; si responde 409 con «todavía se está guardando», reintentar hasta 5 veces cada 1,5 s mostrando «Guardando antes de desligar…» y, si sigue, mostrar el mensaje; otros errores (409 del directo en vivo, etc.) se muestran en el diálogo. Al terminar, `reload()` y volver a pedir `meta`.
   - Después de crear, mover, vaciar, eliminar o desligar, `reload()`; `onNotesDeleted` cierra esas pestañas.
   - Pantallas ≤ 860 px: el árbol se oculta y un botón «Archivos» (`aria-expanded`) lo abre como cajón sobre la hoja; abrir una nota lo cierra; Escape también.

3. `web/src/App.tsx`: importar `NotesWorkspace`; `/notas` y `/notes/:id` apuntan a él; `wide` también para `location.pathname === '/notas'` y `startsWith('/notes/')`.

4. `web/src/pages/Community.tsx`, `SharedNotesTab`: en la línea de detalle, si `n.stream`, «Directo: [título]»; si `n.locked`, el candado con texto accesible «Copia congelada».

5. `web/src/styles.css`: rejilla de la vista (`260px minmax(0, 1fr) 280px`; entre 861 y 1200 px el panel derecho pasa debajo de la hoja), barra de pestañas (activa resaltada, desbordamiento horizontal con desplazamiento), estado vacío, aviso de vinculada/congelada, botón «Archivos» solo en ≤ 860 px y cajón (fijo, sobre la hoja, con fondo). Quitar o adaptar `.note-page` si deja de usarse.

6. `README.md`, «Recorrido de prueba»: una línea nueva (por ejemplo entre los puntos 5 y 6, o al final) sobre «Mis notas» con carpetas y pestañas, y que la nota del directo queda en «Directos / [comunidad]», visible en solo lectura para los miembros, y que se puede mover a una carpeta propia o desligar.

**Test**: no hay pruebas automáticas nuevas en este paso (las e2e van en el paso 4); `web/test/*.test.ts` debe seguir pasando. Revisión manual del usuario: crear carpetas anidadas, arrastrar y «Mover a…», vaciar y eliminar, abrir varias pestañas y recargar, abrir una nota ajena desde «Apuntes compartidos» (pestaña en solo lectura, fuera del árbol), cambiar de pestaña justo después de escribir y volver (no se pierde lo último), el cajón a 390 px, y el recorrido de una nota de directo (vinculada, movida, desligada).

**Verify**: `rsync -a --delete --exclude node_modules --exclude dist $HOME/mnt/streamnote/web/ $HOME/work/web/ && cd $HOME/work/web && npm test && npm run build` sin errores; `grep -rn "NotesPage\|NotePage" $HOME/mnt/streamnote/web/src` no encuentra nada y `grep -n "window.confirm" $HOME/mnt/streamnote/web/src/pages/Notes.tsx $HOME/mnt/streamnote/web/src/components/FileTree.tsx` tampoco.

### Step 4: Pruebas e2e del explorador, las pestañas y las notas de directos

**Files**: `e2e/streaming.mjs` (modificar).

**Do**:

1. Ayudante nuevo `expand(page, name, within?)`: busca el `treeitem` con ese nombre exacto (dentro de `within` si se pasa) y lo pulsa solo si su `aria-expanded` es `"false"` (el expandido se recuerda por navegador, y pulsar una carpeta abierta la cierra). Usarlo en todos los pasos que abren carpetas. Antes de `await ana.goto(`${WEB}/notas`)` del bloque del lienzo, un bloque nuevo (reutilizando `step` y `until`): Ana va a `/notas`, ve «Crea tu primera nota o carpeta»; «Nueva carpeta», llena «Nombre de la carpeta» con «Física» y Enter; espera `getByRole('treeitem', { name: 'Física', exact: true })`; la pulsa (queda seleccionada) y crea «Unidad 1» igual; comprueba que «Unidad 1» está dentro del `treeitem` de «Física». «Nueva nota» (queda en «Unidad 1»), título `Apunte A ${run}` con «Título de la nota» y espera `.save-status.saved`; comprueba que su `treeitem` está dentro de «Unidad 1». Con «Acciones de Apunte A …» → «Mover a…» → «Física» → «Mover», comprueba que la nota quedó dentro de «Física» y fuera de «Unidad 1». «Nueva nota» otra vez y título `Apunte B ${run}`: hay dos `role=tab` en «Notas abiertas» y B está `aria-selected`. Cierra B con «Cerrar Apunte B …»: queda una pestaña y A activa (URL de A). Abre B desde el árbol: dos pestañas, B activa. Recarga: siguen las dos pestañas y B activa. `step(...)` en cada hito y una captura `01a-explorador.png`.

2. Bloque del lienzo: como `/notas` ahora abre la pestaña guardada, `.sheet .module-text` ya existe antes de crear la nota nueva; guardar `const before = ana.url()` antes de pulsar «Nueva nota» y esperar `ana.waitForURL((u) => u.href !== before && u.pathname.startsWith('/notes/'))` y la pestaña «Nota sin título» seleccionada antes de `.sheet .module-text`. El resto del bloque no cambia (si algún selector choca con el árbol o las pestañas, acotarlo a `.sheet` o a la columna de la hoja, sin cambiar lo que comprueba).

3. Reemplazar el último paso («La nota de Beto en "Mis notas"»): Beto va a `/notas`, expande `treeitem` «Directos» y luego `communityName`, pulsa el `treeitem` «Cinemática: MRUV» y espera `.sheet .highlight-tag`; captura `06-nota-beto.png`.

4. Después de ese paso: Ana va a `/notas`, expande «Directos» y `communityName` y encuentra «Cinemática: MRUV». Beto va a la comunidad (`${WEB}${communityUrl}`), pestaña «Apuntes compartidos», la fila de «Cinemática: MRUV» contiene «Directo: Cinemática: MRUV»; la abre y espera `.sheet.readonly`. Ana, con «Acciones de Cinemática: MRUV» → «Mover a…» → «Física» → «Mover»: la fila queda dentro de «Física» con «de ${communityName}». Luego «Acciones de Cinemática: MRUV» → «Desligar de la comunidad» → «Desligar» en el diálogo; con `until` (hasta ~20 s, por el reintento de «todavía se está guardando») comprueba que la fila en «Física» ya no tiene la etiqueta «de …» y que dentro de `communityName` (bajo «Directos») hay una fila «Cinemática: MRUV» con «Copia congelada». Captura `07-desligada.png` y `step(...)` en cada hito. Debe quedar antes del `console.log('\nE2E completo...')`.

**Test**: los bloques de los puntos 1, 3 y 4, más el flujo existente (lienzo, vista angosta, solo lectura, directo, grabación) sin cambios de lo que comprueba.

**Verify**: quien implementa: `node --check $HOME/mnt/streamnote/e2e/streaming.mjs` sin errores; revisar que los nombres usados («Nueva carpeta», «Nombre de la carpeta», «Acciones de …», «Mover a…», «Mover», «Desligar de la comunidad», «Desligar», «Notas abiertas», «Cerrar …», «Copia congelada», «Directo: …») coinciden con los del código de los pasos 2 y 3 (`grep` en `web/src`). El usuario, en Windows, con `docker compose up --build`: `cd e2e && npm test` termina con «E2E completo».
