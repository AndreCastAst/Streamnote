// Acceso a PostgreSQL con parámetros con nombre (:nombre).
// - PgDb: conexión directa (local, pruebas).
// - DataApiDb: RDS Data API sobre HTTP (AWS); las Lambda no necesitan VPC ni RDS Proxy.
import pg from 'pg';
import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  type SqlParameter,
  type Field,
} from '@aws-sdk/client-rds-data';

export type Params = Record<string, unknown>;

export interface Db {
  query<T = any>(sql: string, params?: Params): Promise<T[]>;
  one<T = any>(sql: string, params?: Params): Promise<T | undefined>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Convierte ':nombre' a '$n' respetando '::cast' y literales entre comillas. */
export function toPositional(sql: string, params: Params = {}): { text: string; values: unknown[] } {
  const order: string[] = [];
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      const end = sql.indexOf("'", i + 1);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === ':' && sql[i + 1] === ':') {
      out += '::';
      i += 2;
      continue;
    }
    if (ch === ':' && /[a-zA-Z_]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      if (!(name in params)) throw new Error(`Falta el parámetro :${name}`);
      let idx = order.indexOf(name);
      if (idx === -1) {
        order.push(name);
        idx = order.length - 1;
      }
      out += `$${idx + 1}`;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, values: order.map((n) => serialize(params[n])) };
}

function serialize(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) return JSON.stringify(v);
  return v;
}

export class PgDb implements Db {
  private constructor(private client: pg.Pool | pg.PoolClient) {}

  static connect(url: string): PgDb {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    return new PgDb(pool);
  }

  async query<T>(sql: string, params?: Params): Promise<T[]> {
    const { text, values } = toPositional(sql, params);
    const res = await this.client.query(text, values);
    return res.rows as T[];
  }

  async one<T>(sql: string, params?: Params): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (!(this.client instanceof pg.Pool)) return fn(this);
    const conn = await this.client.connect();
    try {
      await conn.query('BEGIN');
      const result = await fn(new PgDb(conn));
      await conn.query('COMMIT');
      return result;
    } catch (e) {
      await conn.query('ROLLBACK');
      throw e;
    } finally {
      conn.release();
    }
  }

  async close() {
    if (this.client instanceof pg.Pool) await this.client.end();
  }
}

/** RDS Data API. Devuelve filas como objetos (formatRecordsAs: JSON). */
export class DataApiDb implements Db {
  constructor(
    private client: RDSDataClient,
    private opts: { resourceArn: string; secretArn: string; database: string },
    private transactionId?: string,
  ) {}

  async query<T>(sql: string, params: Params = {}): Promise<T[]> {
    const parameters: SqlParameter[] = Object.entries(params).map(([name, value]) => toSqlParameter(name, value));
    const res = await this.client.send(
      new ExecuteStatementCommand({
        ...this.opts,
        sql,
        parameters,
        transactionId: this.transactionId,
        formatRecordsAs: 'JSON',
      }),
    );
    return res.formattedRecords ? (JSON.parse(res.formattedRecords) as T[]) : [];
  }

  async one<T>(sql: string, params?: Params): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.transactionId) return fn(this);
    const { transactionId } = await this.client.send(new BeginTransactionCommand(this.opts));
    const inner = new DataApiDb(this.client, this.opts, transactionId);
    try {
      const result = await fn(inner);
      await this.client.send(new CommitTransactionCommand({ resourceArn: this.opts.resourceArn, secretArn: this.opts.secretArn, transactionId }));
      return result;
    } catch (e) {
      await this.client.send(new RollbackTransactionCommand({ resourceArn: this.opts.resourceArn, secretArn: this.opts.secretArn, transactionId }));
      throw e;
    }
  }

  async close() {}
}

function toSqlParameter(name: string, value: unknown): SqlParameter {
  let field: Field;
  let typeHint: SqlParameter['typeHint'];
  if (value === null || value === undefined) field = { isNull: true };
  else if (typeof value === 'boolean') field = { booleanValue: value };
  else if (typeof value === 'number') field = Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
  else if (value instanceof Date) {
    field = { stringValue: value.toISOString().replace('T', ' ').replace('Z', '') };
    typeHint = 'TIMESTAMP';
  } else if (typeof value === 'object') {
    field = { stringValue: JSON.stringify(value) };
    typeHint = 'JSON';
  } else {
    const s = String(value);
    field = { stringValue: s };
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) typeHint = 'UUID';
  }
  return { name, value: field, typeHint };
}
