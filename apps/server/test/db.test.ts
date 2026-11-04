import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, sqliteDriver } from '../src/db.js';

describe('migrations', () => {
  it('apply all on an empty database, once', async () => {
    const d = sqliteDriver(':memory:');
    await migrate(d);
    await migrate(d);
    const applied = (await d.query<{ id: number }>('SELECT id FROM schema_migrations ORDER BY id')).rows.map((r) => r.id);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('upgrade a v0.1 users table and keep its rows', async () => {
    const d = sqliteDriver(':memory:');
    await d.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
                  INSERT INTO users (id, email, name, password_hash) VALUES ('u1', 'a@x.io', 'A', 'scrypt:aa:bb');`);
    await migrate(d);
    const cols = (await d.query<{ name: string }>('PRAGMA table_info(users)')).rows.map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['provider', 'external_id', 'last_login_at']));
    expect((await d.query('SELECT id, provider, email, password_hash FROM users')).rows).toEqual([
      { id: 'u1', provider: 'local', email: 'a@x.io', password_hash: 'scrypt:aa:bb' },
    ]);
    // SSO users have no password, and an email is unique per provider only
    await d.exec("INSERT INTO users (id, provider, external_id, email, name) VALUES ('u2', 'entra', 't:o', 'a@x.io', 'A')");
    await expect(d.exec("INSERT INTO users (id, provider, email, name) VALUES ('u3', 'local', 'a@x.io', 'A')")).rejects.toThrow(/UNIQUE/);
  });
});
