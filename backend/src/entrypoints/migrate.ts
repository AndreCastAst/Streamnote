// Aplica las migraciones SQL pendientes, en orden. Idempotente.
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../config.js';

const cfg = loadConfig();
const dir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const client = new pg.Client({ connectionString: cfg.db.url });

for (let attempt = 1; ; attempt++) {
  try {
    await client.connect();
    break;
  } catch (e) {
    if (attempt >= 30) throw e;
    console.log(`Esperando a PostgreSQL (${attempt})...`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(file)) continue;
  await client.query('BEGIN');
  try {
    await client.query(await readFile(join(dir, file), 'utf8'));
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`Migración aplicada: ${file}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
await client.end();
console.log('Base de datos al día');
