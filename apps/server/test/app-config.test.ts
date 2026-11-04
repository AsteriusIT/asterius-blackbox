import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { apiRoutes } from '../src/routes/api.js';
import { createSession, createUser } from '../src/auth.js';
import { configFor, configNames, decrypt, encrypt } from '../src/app-config.js';
import { all, newId, run } from '../src/db.js';

const server = Fastify();
server.setErrorHandler((err, _req, reply) => reply.code(err instanceof ZodError ? 400 : 500).send({ error: (err as Error).message })); // as in index.ts
await server.register(apiRoutes);

describe('application configuration & secrets', () => {
  it('encrypts with authentication', () => {
    const c = encrypt('s3cr3t');
    expect(c).not.toContain('s3cr3t');
    expect(decrypt(c)).toBe('s3cr3t');
    const [v, iv, tag, data] = c.split(':');
    const tampered = `${v}:${iv}:${tag}:${Buffer.from('x' + Buffer.from(data!, 'base64').toString('latin1')).toString('base64')}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('stores values encrypted, masks secrets, scopes per environment, and only shows names to the agent', async () => {
    const owner = await createUser('cfg@x.io', 'C', 'password1');
    const viewer = await createUser('cfgv@x.io', 'V', 'password1');
    const appId = newId();
    await run("INSERT INTO applications (id, owner_id, name, slug, description, status) VALUES (?, ?, 'Cfg', ?, '', 'idle')", appId, owner.id, appId);
    await run("INSERT INTO app_members (app_id, subject, role) VALUES (?, ?, 'viewer')", appId, `user:${viewer.id}`);
    const h = { authorization: `Bearer ${await createSession(owner.id)}` };
    const put = (payload: object) => server.inject({ method: 'PUT', url: `/api/apps/${appId}/config`, headers: h, payload });

    expect((await put({ key: 'stripe-key', value: 'x' })).statusCode).toBe(400);
    expect((await put({ key: 'STRIPE_KEY', value: 'sk_live_123' })).statusCode).toBe(200);
    expect((await put({ key: 'API_URL', value: 'https://api.example.com', secret: false })).statusCode).toBe(200);
    expect((await put({ key: 'API_URL', value: 'https://staging.example.com', secret: false, env: 'staging' })).statusCode).toBe(200);

    const raw = await all<{ value_enc: string }>('SELECT value_enc FROM app_config WHERE app_id = ?', appId);
    expect(raw.some((r) => r.value_enc.includes('sk_live'))).toBe(false);

    const listed = (await server.inject({ url: `/api/apps/${appId}/config`, headers: h })).json();
    expect(listed.find((c: { key: string }) => c.key === 'STRIPE_KEY')).toMatchObject({ secret: true, value: null });
    expect(listed.find((c: { key: string; env: string }) => c.key === 'API_URL' && c.env === '*').value).toBe('https://api.example.com');

    expect(await configFor(appId, 'main')).toEqual({ STRIPE_KEY: 'sk_live_123', API_URL: 'https://api.example.com' });
    expect(await configFor(appId, 'staging')).toEqual({ STRIPE_KEY: 'sk_live_123', API_URL: 'https://staging.example.com' });

    // viewers cannot read or write configuration
    const hv = { authorization: `Bearer ${await createSession(viewer.id)}` };
    expect((await server.inject({ url: `/api/apps/${appId}/config`, headers: hv })).statusCode).toBe(404);

    // the agent's list_app_config tool reads names only
    const names = await configNames(appId);
    expect(names.map((c) => c.key)).toEqual(['API_URL', 'API_URL', 'STRIPE_KEY']);
    expect(JSON.stringify(names)).not.toContain('sk_live');

    expect((await server.inject({ method: 'DELETE', url: `/api/apps/${appId}/config/STRIPE_KEY`, headers: h })).statusCode).toBe(200);
    expect(Object.keys(await configFor(appId, 'main'))).toEqual(['API_URL']);
  });
});
