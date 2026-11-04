import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { all, run } from './db.js';
import type { ConfigEntry } from '@blackbox/shared';

/**
 * Configuration and secrets of generated applications, set by people in the UI and injected into previews
 * (they land in the environment's Kubernetes Secret `app-env`). Values are encrypted at rest with AES-256-GCM.
 * The agent only ever sees the names, so nothing secret ends up in prompts, logs or the repository.
 *
 * Key: SECRETS_KEY (32 bytes, base64 or hex) — required with several replicas; locally a key is generated once
 * under DATA_DIR/secrets.key.
 */

export const CONFIG_KEY = /^[A-Z_][A-Z0-9_]{0,99}$/;
export const ALL_ENVS = '*';

let key: Buffer | undefined;
function encryptionKey() {
  if (key) return key;
  const raw = config.SECRETS_KEY;
  if (raw) key = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? 'hex' : 'base64');
  else {
    const file = path.join(config.DATA_DIR, 'secrets.key');
    if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  }
  if (key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes (base64 or hex)');
  return key;
}

export function encrypt(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function decrypt(stored: string) {
  const [v, iv, tag, data] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('unreadable configuration value');
  const d = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

interface ConfigRow {
  env: string;
  key: string;
  value_enc: string;
  secret: number;
  updated_at: string;
}

/** For the UI: secrets are masked. */
export async function listConfig(appId: string): Promise<ConfigEntry[]> {
  const rows = await all<ConfigRow>('SELECT env, key, value_enc, secret, updated_at FROM app_config WHERE app_id = ? ORDER BY key, env', appId);
  return rows.map((r) => ({ env: r.env, key: r.key, secret: r.secret === 1, value: r.secret === 1 ? null : decrypt(r.value_enc), updatedAt: r.updated_at }));
}

export async function setConfig(appId: string, entry: { key: string; value: string; secret: boolean; env?: string }) {
  await run(
    `INSERT INTO app_config (app_id, env, key, value_enc, secret, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (app_id, env, key) DO UPDATE SET value_enc = excluded.value_enc, secret = excluded.secret, updated_at = excluded.updated_at`,
    appId,
    entry.env || ALL_ENVS,
    entry.key,
    encrypt(entry.value),
    entry.secret ? 1 : 0,
    new Date().toISOString(),
  );
}

export async function deleteConfig(appId: string, key: string, env = ALL_ENVS) {
  return (await run('DELETE FROM app_config WHERE app_id = ? AND key = ? AND env = ?', appId, key, env)).changes > 0;
}

/** Values injected into one environment: app-wide entries, overridden by the environment's own. */
export async function configFor(appId: string, envSlug: string): Promise<Record<string, string>> {
  const rows = await all<ConfigRow>(
    "SELECT env, key, value_enc FROM app_config WHERE app_id = ? AND env IN ('*', ?) ORDER BY CASE env WHEN '*' THEN 0 ELSE 1 END",
    appId,
    envSlug,
  );
  return Object.fromEntries(rows.map((r) => [r.key, decrypt(r.value_enc)]));
}

/** For the agent: names only. */
export async function configNames(appId: string) {
  return all<{ key: string; env: string; secret: number }>('SELECT key, env, secret FROM app_config WHERE app_id = ? ORDER BY key, env', appId);
}
