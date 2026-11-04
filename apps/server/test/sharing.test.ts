import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { apiRoutes } from '../src/routes/api.js';
import { createSession, createUser } from '../src/auth.js';
import { createApplication } from '../src/applications.js';
import { audienceOf } from '../src/access.js';
import { run } from '../src/db.js';
import { systemPromptAppend } from '../src/agent/prompt.js';

const server = Fastify();
await server.register(apiRoutes);
const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe('shared applications', () => {
  it('lets owners share with users and Entra groups by role', async () => {
    const owner = await createUser('own@x.io', 'Owner', 'password1');
    const bob = await createUser('bob@x.io', 'Bob', 'password1');
    const carol = await createUser('carol@x.io', 'Carol', 'password1');
    await run('UPDATE users SET groups = ? WHERE id = ?', JSON.stringify(['6f1c2a43-8a2e-4a7f-9a55-0c1d2e3f4a5b']), carol.id);
    const [to, tb, tc] = [await createSession(owner.id), await createSession(bob.id), await createSession(carol.id)];
    const app = await createApplication(owner.id, { name: 'Shared', description: '', prompt: 'hi' });
    const url = `/api/apps/${app.id}`;

    expect((await server.inject({ url, headers: as(tb) })).statusCode).toBe(404);

    // viewer can read, not chat; only the owner manages members
    expect((await server.inject({ method: 'POST', url: `${url}/members`, headers: as(to), payload: { email: 'bob@x.io', role: 'viewer' } })).statusCode).toBe(
      200,
    );
    const asBob = await server.inject({ url, headers: as(tb) });
    expect(asBob.statusCode).toBe(200);
    expect(asBob.json().role).toBe('viewer');
    expect((await server.inject({ method: 'POST', url: `${url}/messages`, headers: as(tb), payload: { content: 'x' } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: `${url}/members`, headers: as(tb), payload: { email: 'carol@x.io', role: 'editor' } })).statusCode).toBe(
      404,
    );

    // editor can chat
    await server.inject({ method: 'POST', url: `${url}/members`, headers: as(to), payload: { email: 'bob@x.io', role: 'editor' } });
    expect((await server.inject({ method: 'POST', url: `${url}/messages`, headers: as(tb), payload: { content: 'add a page' } })).statusCode).toBe(200);

    // per-app plan approval (editors); the planner prompt follows it
    const patched = await server.inject({ method: 'PATCH', url, headers: as(tb), payload: { requirePlanApproval: true } });
    expect(patched.json().require_plan_approval).toBe(1);
    expect(systemPromptAppend(patched.json())).toMatch(/stop and wait for the user to confirm/);

    // Entra group membership
    expect((await server.inject({ url: '/api/apps', headers: as(tc) })).json()).toHaveLength(0);
    const g = await server.inject({
      method: 'POST',
      url: `${url}/members`,
      headers: as(to),
      payload: { groupId: '6f1c2a43-8a2e-4a7f-9a55-0c1d2e3f4a5b', role: 'viewer' },
    });
    expect(g.body).toContain('ok');
    expect((await server.inject({ url: '/api/apps', headers: as(tc) })).json().map((a: { id: string }) => a.id)).toEqual([app.id]);

    // live events reach everyone who has access
    expect((await audienceOf(app.id)).sort()).toEqual([owner.id, bob.id, carol.id].sort());

    const members = (await server.inject({ url: `${url}/members`, headers: as(tb) })).json();
    expect(members.owner.email).toBe('own@x.io');
    expect(members.members.map((m: { role: string }) => m.role).sort()).toEqual(['editor', 'viewer']);

    // unknown email, removal
    expect(
      (await server.inject({ method: 'POST', url: `${url}/members`, headers: as(to), payload: { email: 'nobody@x.io', role: 'viewer' } })).statusCode,
    ).toBe(404);
    await server.inject({ method: 'DELETE', url: `${url}/members/${encodeURIComponent(`user:${bob.id}`)}`, headers: as(to) });
    expect((await server.inject({ url, headers: as(tb) })).statusCode).toBe(404);
  });
});
