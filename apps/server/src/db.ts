import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { config, paths } from './config.js';

/**
 * Storage: SQLite (local dev, single instance) or Postgres (DATABASE_URL=postgres://…, several replicas).
 * The SQL is written once: on Postgres, `datetime('now')` and `json_extract(text, '$.a.b')` are provided
 * as SQL functions, and `?` placeholders are rewritten to `$n`.
 */

export type SqlValue = string | number | null;

export interface Driver {
  readonly dialect: 'sqlite' | 'postgres';
  query<T>(sql: string, params?: SqlValue[]): Promise<{ rows: T[]; changes: number }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function sqliteDriver(file: string): Driver {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return {
    dialect: 'sqlite',
    // Runs synchronously at call time, so un-awaited writes keep their call order.
    async query<T>(sql: string, params: SqlValue[] = []) {
      const st = d.prepare(sql);
      if (/^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: st.all(...params) as T[], changes: 0 };
      return { rows: [], changes: Number(st.run(...params).changes) };
    },
    async exec(sql: string) {
      d.exec(sql);
    },
    async close() {
      d.close();
    },
  };
}

// count(*) / bigserial / numeric come back as strings by default
pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, Number);

const toPg = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

export function postgresDriver(conn: pg.Pool | pg.PoolClient): Driver {
  return {
    dialect: 'postgres',
    async query<T>(sql: string, params: SqlValue[] = []) {
      const r = await conn.query(toPg(sql), params);
      return { rows: r.rows as T[], changes: r.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await conn.query(sql);
    },
    async close() {
      if ('end' in conn) await conn.end();
    },
  };
}

// ---------- migrations ----------
const PG_FUNCTIONS = `
CREATE OR REPLACE FUNCTION datetime(t text) RETURNS text LANGUAGE sql AS
  $$ SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') $$;
CREATE OR REPLACE FUNCTION json_extract(j text, p text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT (j::jsonb) #>> string_to_array(substr(p, 3), '.') $$;
`;

/** The few DDL differences between the two dialects. */
const ddl = (d: Driver, sql: string) => (d.dialect === 'postgres' ? sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGSERIAL PRIMARY KEY') : sql);

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'local', -- local | entra
  external_id TEXT,                       -- entra: <tenant id>:<object id>
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stream_tickets (
  ticket TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  -- provisioning | ready | running | idle | error
  status TEXT NOT NULL DEFAULT 'provisioning',
  phase TEXT,
  repo_id TEXT,
  repo_name TEXT,
  repo_web_url TEXT,
  repo_clone_url TEXT,
  agent_session_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  run_id TEXT,
  role TEXT NOT NULL, -- user | assistant | system
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  status TEXT NOT NULL, -- running | succeeded | failed | stopped
  cost_usd REAL,
  num_turns INTEGER,
  summary TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  run_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_app_seq ON events(app_id, seq);
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  namespace TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT,
  image TEXT,
  url TEXT,
  -- building | deploying | ready | failed | deleted
  status TEXT NOT NULL,
  message TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER NOT NULL,
  app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  status TEXT NOT NULL,
  web_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (app_id, id)
);
`;

export interface Migration {
  id: number;
  name: string;
  up: (d: Driver) => Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  { id: 1, name: 'base schema', up: (d) => d.exec(ddl(d, BASE_SCHEMA)) },
  {
    id: 2,
    name: 'users: sign-in providers',
    up: async (d) => {
      // v0.1 had users(email UNIQUE, password_hash NOT NULL). SSO users have no password and an email is only
      // unique per provider (never link accounts by email: a local account could pre-claim someone's address).
      if (d.dialect === 'sqlite') {
        const cols = (await d.query<{ name: string }>('PRAGMA table_info(users)')).rows;
        if (!cols.some((c) => c.name === 'provider'))
          await d.exec(`
            PRAGMA foreign_keys = OFF;
            BEGIN;
            CREATE TABLE users_v2 (
              id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'local', external_id TEXT, email TEXT NOT NULL,
              name TEXT NOT NULL, password_hash TEXT, last_login_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO users_v2 (id, provider, email, name, password_hash, created_at)
              SELECT id, 'local', email, name, password_hash, created_at FROM users;
            DROP TABLE users;
            ALTER TABLE users_v2 RENAME TO users;
            COMMIT;
            PRAGMA foreign_keys = ON;
          `);
      }
      await d.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_local_email ON users(email) WHERE provider = 'local';
        CREATE UNIQUE INDEX IF NOT EXISTS users_external ON users(provider, external_id) WHERE external_id IS NOT NULL;
      `);
    },
  },
  {
    id: 3,
    name: 'port_runs',
    up: (d) =>
      d.exec(`CREATE TABLE IF NOT EXISTS port_runs (
        run_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        action TEXT NOT NULL,
        finished INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`),
  },
  {
    id: 4,
    name: 'run queue',
    up: (d) =>
      d.exec(`
        ALTER TABLE runs ADD COLUMN prompt TEXT;
        ALTER TABLE runs ADD COLUMN worker TEXT;
        ALTER TABLE runs ADD COLUMN heartbeat_at TEXT;
        ALTER TABLE runs ADD COLUMN queued_at TEXT;
        CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
        CREATE UNIQUE INDEX IF NOT EXISTS runs_one_queued ON runs(app_id) WHERE status = 'queued';
        CREATE UNIQUE INDEX IF NOT EXISTS runs_one_running ON runs(app_id) WHERE status = 'running';
      `),
  },
  { id: 5, name: 'events created_at index (retention)', up: (d) => d.exec('CREATE INDEX IF NOT EXISTS events_type_created ON events(type, created_at)') },
  {
    id: 6,
    name: 'audit log',
    up: (d) =>
      d.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          at TEXT NOT NULL,
          action TEXT NOT NULL,
          via TEXT NOT NULL,
          actor_id TEXT,
          actor_email TEXT,
          app_id TEXT,
          target TEXT,
          detail TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);
        CREATE INDEX IF NOT EXISTS audit_app ON audit_log(app_id, at);
      `),
  },
  {
    id: 7,
    name: 'shared applications',
    up: (d) =>
      d.exec(`
        ALTER TABLE users ADD COLUMN groups TEXT;
        CREATE TABLE IF NOT EXISTS app_members (
          app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
          subject TEXT NOT NULL, -- user:<id> | group:<entra group object id>
          role TEXT NOT NULL,    -- viewer | editor
          added_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (app_id, subject)
        );
        CREATE INDEX IF NOT EXISTS app_members_subject ON app_members(subject);
      `),
  },
  {
    id: 8,
    name: 'budgets',
    up: (d) => d.exec('CREATE TABLE IF NOT EXISTS budgets (scope TEXT PRIMARY KEY, monthly_usd REAL NOT NULL)'),
  },
  {
    id: 9,
    name: 'plan approval per app, message metadata',
    up: (d) =>
      d.exec(`
        ALTER TABLE applications ADD COLUMN require_plan_approval INTEGER; -- NULL: platform default
        ALTER TABLE messages ADD COLUMN meta TEXT; -- JSON, e.g. {"type":"plan","needsApproval":true}
      `),
  },
  {
    id: 10,
    name: 'pull request feedback tracking',
    up: (d) => d.exec('ALTER TABLE pull_requests ADD COLUMN feedback_seen TEXT'),
  },
  {
    id: 11,
    name: 'application configuration and secrets',
    up: (d) =>
      d.exec(`CREATE TABLE IF NOT EXISTS app_config (
        app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        env TEXT NOT NULL DEFAULT '*', -- '*' = every environment, else an environment slug
        key TEXT NOT NULL,
        value_enc TEXT NOT NULL,       -- AES-256-GCM, see app-config.ts
        secret INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (app_id, env, key)
      )`),
  },
  {
    id: 12,
    name: 'pinned environments and deploy specs',
    up: (d) =>
      d.exec(`
        ALTER TABLE environments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE environments ADD COLUMN spec TEXT; -- JSON DeploySpec of the last agent deploy (promotion / redeploy)
      `),
  },
  {
    id: 13,
    name: 'application template',
    up: (d) => d.exec('ALTER TABLE applications ADD COLUMN template TEXT'),
  },
  {
    id: 14,
    name: 'imported repositories',
    up: (d) => d.exec('ALTER TABLE applications ADD COLUMN repo_source TEXT'), // NULL: created by Blackbox
  },
];

/** Apply pending numbered migrations (idempotent; serialized across replicas on Postgres). */
export async function migrate(d: Driver, migrations = MIGRATIONS) {
  await d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set((await d.query<{ id: number }>('SELECT id FROM schema_migrations')).rows.map((r) => Number(r.id)));
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await m.up(d);
    await d.query('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [m.id, m.name, new Date().toISOString()]);
  }
}

let pool: pg.Pool | undefined;

async function open(): Promise<Driver> {
  if (!config.DATABASE_URL?.startsWith('postgres')) {
    const d = sqliteDriver(paths.db);
    await migrate(d);
    return d;
  }
  pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_SIZE });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(726200)');
    const d = postgresDriver(client);
    await d.exec(PG_FUNCTIONS);
    await migrate(d);
  } finally {
    await client.query('SELECT pg_advisory_unlock(726200)').catch(() => undefined);
    client.release();
  }
  return postgresDriver(pool);
}

export const driver = await open();

let localLock: Promise<unknown> = Promise.resolve();
/**
 * Run `fn` exclusively: in-process on SQLite, in a transaction holding a cluster-wide advisory lock on Postgres
 * (e.g. claiming queued runs from several workers without exceeding the limits).
 */
export async function withLock<T>(key: number, fn: (d: Driver) => Promise<T>): Promise<T> {
  if (!pool) {
    const p = localLock.then(() => fn(driver));
    localLock = p.catch(() => undefined);
    return p;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [key]);
    const res = await fn(postgresDriver(client));
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
export const dialect = driver.dialect;
export const newId = () => randomUUID();

// ---------- typed rows (API-visible ones are shared with the web UI) ----------
export type { AppRow, EnvRow, MessageRow, PullRequestRow } from '@blackbox/shared';
import type { AppRow, EnvRow } from '@blackbox/shared';
export interface UserRow {
  id: string;
  provider: 'local' | 'entra';
  external_id: string | null;
  email: string;
  name: string;
  password_hash: string | null;
  /** Entra group object ids (JSON array) from the last sign-in. */
  groups?: string | null;
}
export interface EventRow {
  seq: number;
  app_id: string;
  run_id: string | null;
  type: string;
  payload: string;
  created_at: string;
}

export async function one<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
  return (await driver.query<T>(sql, params)).rows[0];
}
export async function all<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
  return (await driver.query<T>(sql, params)).rows;
}
export async function run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }> {
  return { changes: (await driver.query(sql, params)).changes };
}

/** Partial update helper for applications. */
export async function updateApp(id: string, patch: Partial<Omit<AppRow, 'id' | 'owner_id'>>) {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  await run(`UPDATE applications SET ${set}, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => (patch[k] ?? null) as SqlValue), id);
}

export async function upsertEnv(env: Partial<EnvRow> & Pick<EnvRow, 'app_id' | 'name' | 'namespace' | 'branch' | 'status'>) {
  const existing = await one<EnvRow>('SELECT * FROM environments WHERE name = ?', env.name);
  if (!existing) {
    const id = newId();
    await run(
      `INSERT INTO environments (id, app_id, name, namespace, branch, commit_sha, image, url, status, message, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      env.app_id,
      env.name,
      env.namespace,
      env.branch,
      env.commit_sha ?? null,
      env.image ?? null,
      env.url ?? null,
      env.status,
      env.message ?? null,
      env.expires_at ?? null,
    );
    return (await one<EnvRow>('SELECT * FROM environments WHERE id = ?', id))!;
  }
  const merged = { ...existing, ...env };
  await run(
    `UPDATE environments SET branch=?, commit_sha=?, image=?, url=?, status=?, message=?, expires_at=?, pinned=?, spec=?, updated_at=datetime('now') WHERE id=?`,
    merged.branch,
    merged.commit_sha,
    merged.image,
    merged.url,
    merged.status,
    merged.message,
    merged.expires_at,
    merged.pinned ?? 0,
    merged.spec ?? null,
    existing.id,
  );
  return (await one<EnvRow>('SELECT * FROM environments WHERE id = ?', existing.id))!;
}
