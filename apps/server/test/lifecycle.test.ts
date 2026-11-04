import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import Fastify from 'fastify';
import { apiRoutes } from '../src/routes/api.js';
import { createSession, createUser } from '../src/auth.js';
import { createApplication } from '../src/applications.js';
import { all, one, type AppRow } from '../src/db.js';

const server = Fastify();
await server.register(apiRoutes);
const as = (t: string) => ({ authorization: `Bearer ${t}` });
const until = async (cond: () => Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('archive / delete', () => {
  it('archives read-only, restores, then deletes everything but the audit trail', async () => {
    const owner = await createUser('o@x.io', 'Olga', 'password1');
    const bob = await createUser('b@x.io', 'Bob', 'password1');
    const [to, tb] = [await createSession(owner.id), await createSession(bob.id)];
    const app = await createApplication(owner.id, { name: 'Doomed', description: '', prompt: 'hi' });
    await until(async () => Boolean((await one<AppRow>('SELECT repo_id FROM applications WHERE id = ?', app.id))?.repo_id));
    const repo = (await one<AppRow>('SELECT * FROM applications WHERE id = ?', app.id))!.repo_clone_url!;
    expect(fs.existsSync(repo)).toBe(true);
    const url = `/api/apps/${app.id}`;
    await server.inject({ method: 'POST', url: `${url}/members`, headers: as(to), payload: { email: 'b@x.io', role: 'editor' } });

    // editors cannot archive; the owner can, which cancels the queued kickoff run
    expect((await server.inject({ method: 'POST', url: `${url}/archive`, headers: as(tb) })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: `${url}/archive`, headers: as(to) })).statusCode).toBe(200);
    expect((await server.inject({ url, headers: as(to) })).json().app.status).toBe('archived');
    expect((await all("SELECT 1 FROM runs WHERE app_id = ? AND status = 'queued'", app.id)).length).toBe(0);
    const msg = await server.inject({ method: 'POST', url: `${url}/messages`, headers: as(tb), payload: { content: 'x' } });
    expect(msg.statusCode).toBe(409);

    expect((await server.inject({ method: 'POST', url: `${url}/unarchive`, headers: as(to) })).statusCode).toBe(200);
    expect((await server.inject({ url, headers: as(to) })).json().app.status).toBe('idle');

    // delete needs the exact name
    expect((await server.inject({ method: 'DELETE', url, headers: as(to), payload: { confirm: 'doomed' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'DELETE', url, headers: as(tb), payload: { confirm: 'Doomed' } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url, headers: as(to), payload: { confirm: 'Doomed' } })).statusCode).toBe(200);
    expect(await one('SELECT 1 FROM applications WHERE id = ?', app.id)).toBeUndefined();
    expect(await all('SELECT 1 FROM messages WHERE app_id = ?', app.id)).toEqual([]);
    expect(fs.existsSync(repo)).toBe(false);
    const trail = (await all<{ action: string }>('SELECT action FROM audit_log WHERE app_id = ? ORDER BY at', app.id)).map((r) => r.action);
    expect(trail).toEqual(expect.arrayContaining(['app.created', 'app.archived', 'app.restored', 'app.deleted']));
  });
});
