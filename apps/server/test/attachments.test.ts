import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => import('./fake-sdk.js'));
const { sdk, init, say, result, until } = await import('./fake-sdk.js');
const Fastify = (await import('fastify')).default;
const { apiRoutes } = await import('../src/routes/api.js');
const { createSession, createUser } = await import('../src/auth.js');
const { startScheduler } = await import('../src/agent/runner.js');
const { all } = await import('../src/db.js');

const server = Fastify();
await server.register(apiRoutes);
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

describe('chat attachments', () => {
  it('stores files and hands images and text files to the agent', async () => {
    sdk.script = async function* () {
      yield init('s');
      yield say('ok');
      yield result();
    };
    await startScheduler();
    const u = await createUser('att@x.io', 'A', 'password1');
    const headers = { authorization: `Bearer ${await createSession(u.id)}` };
    const app = (await server.inject({ method: 'POST', url: '/api/apps', headers, payload: { name: 'Attach', description: '', prompt: 'start' } })).json();
    const idle = async () =>
      (await all("SELECT 1 FROM runs WHERE app_id = ? AND status IN ('queued', 'running')", app.id)).length === 0 && sdk.calls.length > 0;
    await until(idle);

    const bad = await server.inject({
      method: 'POST',
      url: `/api/apps/${app.id}/messages`,
      headers,
      payload: { content: 'x', attachments: [{ name: 'a.exe', mediaType: 'application/x-msdownload', data: 'AA==' }] },
    });
    expect(bad.statusCode).toBe(400);

    const res = await server.inject({
      method: 'POST',
      url: `/api/apps/${app.id}/messages`,
      headers,
      payload: {
        content: 'Make it look like this, with this data',
        attachments: [
          { name: 'mockup.png', mediaType: 'image/png', data: PNG },
          { name: 'books.csv', mediaType: 'text/csv', data: Buffer.from('title,author\nDune,Herbert\n').toString('base64') },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    await until(async () => sdk.calls.length === 2 && (await idle()));

    const content = sdk.calls[1]!.contents[0] as { type: string; text?: string; source?: { media_type: string } }[];
    expect(content.map((b) => b.type)).toEqual(['text', 'image', 'text']);
    expect(content[0]!.text).toBe('Make it look like this, with this data');
    expect(content[1]!.source!.media_type).toBe('image/png');
    expect(content[2]!.text).toMatch(/Attached file books\.csv[\s\S]*Dune,Herbert/);

    // the UI can download them back (viewer access)
    const msg = (await server.inject({ url: `/api/apps/${app.id}/messages`, headers })).json().find((m: { meta?: string }) => m.meta?.includes('mockup'));
    const file = JSON.parse(msg.meta).attachments[0].file as string;
    const dl = await server.inject({ url: `/api/apps/${app.id}/attachments/${file}`, headers });
    expect(dl.headers['content-type']).toBe('image/png');
    expect(dl.rawPayload.toString('base64')).toBe(PNG);
  });
});
