import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { paths } from './config.js';

fs.mkdirSync(path.dirname(paths.db), { recursive: true });

export const db = new DatabaseSync(paths.db);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
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
`);

migrateUsers();
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS users_local_email ON users(email) WHERE provider = 'local';
CREATE UNIQUE INDEX IF NOT EXISTS users_external ON users(provider, external_id) WHERE external_id IS NOT NULL;
`);

/**
 * v0.1 had `users(email UNIQUE, password_hash NOT NULL)`. SSO users have no password and an email is only
 * unique per provider (never link accounts by email: a local account could pre-claim someone's address).
 */
function migrateUsers() {
  const cols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (cols.some((c) => c.name === 'provider')) return;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE users_v2 (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'local',
      external_id TEXT,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT,
      last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users_v2 (id, provider, email, name, password_hash, created_at)
      SELECT id, 'local', email, name, password_hash, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_v2 RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

export const newId = () => randomUUID();

// ---------- typed rows ----------
export interface UserRow {
  id: string;
  provider: 'local' | 'entra';
  external_id: string | null;
  email: string;
  name: string;
  password_hash: string | null;
}
export interface AppRow {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string;
  status: 'provisioning' | 'ready' | 'running' | 'idle' | 'error';
  phase: string | null;
  repo_id: string | null;
  repo_name: string | null;
  repo_web_url: string | null;
  repo_clone_url: string | null;
  agent_session_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
export interface MessageRow {
  id: string;
  app_id: string;
  run_id: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}
export interface EnvRow {
  id: string;
  app_id: string;
  name: string;
  namespace: string;
  branch: string;
  commit_sha: string | null;
  image: string | null;
  url: string | null;
  status: 'building' | 'deploying' | 'ready' | 'failed' | 'deleted';
  message: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface PullRequestRow {
  id: number;
  app_id: string;
  title: string;
  source_branch: string;
  status: string;
  web_url: string | null;
}
export interface EventRow {
  seq: number;
  app_id: string;
  run_id: string | null;
  type: string;
  payload: string;
  created_at: string;
}

type SqlValue = string | number | null;

export function one<T>(sql: string, ...params: SqlValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T>(sql: string, ...params: SqlValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: SqlValue[]) {
  return db.prepare(sql).run(...params);
}

/** Partial update helper for applications. */
export function updateApp(id: string, patch: Partial<Omit<AppRow, 'id' | 'owner_id'>>) {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  run(
    `UPDATE applications SET ${set}, updated_at = datetime('now') WHERE id = ?`,
    ...keys.map((k) => (patch[k] ?? null) as SqlValue),
    id,
  );
}

export function upsertEnv(env: Partial<EnvRow> & Pick<EnvRow, 'app_id' | 'name' | 'namespace' | 'branch' | 'status'>) {
  const existing = one<EnvRow>('SELECT * FROM environments WHERE name = ?', env.name);
  if (!existing) {
    const id = newId();
    run(
      `INSERT INTO environments (id, app_id, name, namespace, branch, commit_sha, image, url, status, message, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, env.app_id, env.name, env.namespace, env.branch,
      env.commit_sha ?? null, env.image ?? null, env.url ?? null, env.status, env.message ?? null, env.expires_at ?? null,
    );
    return one<EnvRow>('SELECT * FROM environments WHERE id = ?', id)!;
  }
  const merged = { ...existing, ...env };
  run(
    `UPDATE environments SET branch=?, commit_sha=?, image=?, url=?, status=?, message=?, expires_at=?, updated_at=datetime('now') WHERE id=?`,
    merged.branch, merged.commit_sha, merged.image, merged.url, merged.status, merged.message, merged.expires_at, existing.id,
  );
  return one<EnvRow>('SELECT * FROM environments WHERE id = ?', existing.id)!;
}
