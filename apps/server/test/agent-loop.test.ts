import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Full agent loop against the local git provider, with a scripted fake of the SDK's query().
 * The fake reads the prompt stream like the real SDK and emits scripted messages for each user turn.
 */
vi.mock('@anthropic-ai/claude-agent-sdk', () => import('./fake-sdk.js'));
const { sdk, init, say, result, until } = await import('./fake-sdk.js');

const { createUser, createSession } = await import('../src/auth.js');
const Fastify = (await import('fastify')).default;
const { apiRoutes } = await import('../src/routes/api.js');
const { createApplication } = await import('../src/applications.js');
const { sendUserMessage, stopRun, isRunning, startScheduler } = await import('../src/agent/runner.js');
const { all, one } = await import('../src/db.js');
type AppRow = import('../src/db.js').AppRow;

const runs = (appId: string) =>
  all<{ status: string; cost_usd: number | null }>('SELECT status, cost_usd FROM runs WHERE app_id = ? ORDER BY started_at', appId);
const appRow = async (id: string) => (await one<AppRow>('SELECT * FROM applications WHERE id = ?', id))!;
const idle = (id: string) => async () => {
  const r = await runs(id);
  const app = await appRow(id);
  return !isRunning(id) && r.length > 0 && r.every((x) => x.status !== 'running' && x.status !== 'queued') && !['running', 'queued'].includes(app.status);
};

describe('agent loop (local git provider, fake SDK)', () => {
  it('provisions, runs, opens a PR, resumes, folds feedback and stops', async () => {
    await startScheduler();
    const user = await createUser('loop@x.io', 'Loop', 'password1');
    // ---- turn 1: kickoff → PR → final message
    let blocked: unknown;
    sdk.script = async function* (_text, { tools, cwd }) {
      yield init('sess-1');
      await tools.find((t) => t.name === 'share_plan')!.handler({ summary: 'A hello page', steps: [{ title: 'Say hello' }] });
      const pr = tools.find((t) => t.name === 'create_pull_request')!;
      const git = (...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' });
      const commitAndPush = (branch: string, file: string, content: string) => {
        git('checkout', '-q', '-B', branch, 'origin/main');
        fs.writeFileSync(path.join(cwd, file), content);
        git('add', file);
        git('commit', '-q', '-m', `add ${file}`);
        git('push', '-q', 'origin', branch);
      };
      commitAndPush('feature/leak', 'config.js', 'export const key = "AKIAIOSFODNN7ABCDEFG";\n');
      blocked = await pr.handler({ sourceBranch: 'feature/leak', title: 'Leak', description: 'desc' });
      commitAndPush('feature/hello', 'hello.txt', 'hello\n');
      await pr.handler({ sourceBranch: 'feature/hello', title: 'Hello', description: 'desc' });
      yield say('Your app is ready.');
      yield result(0.5);
    };
    const app = await createApplication(user.id, { name: 'Loop App', description: 'test', prompt: 'Build hello world' });
    await until(idle(app.id));

    expect(blocked).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/blocked[\s\S]*config\.js:1 \[aws-access-key\]/) }] });
    expect(await appRow(app.id)).toMatchObject({ status: 'idle', phase: 'done', agent_session_id: 'sess-1', repo_name: 'loop-app' });
    expect(sdk.calls[0]!.prompts[0]).toMatch(/A new application was just created[\s\S]*Build hello world/);
    expect(await runs(app.id)).toEqual([{ status: 'succeeded', cost_usd: 0.5 }]);
    expect(await all<{ id: number; source_branch: string }>('SELECT id, source_branch FROM pull_requests WHERE app_id = ?', app.id)).toEqual([
      { id: 1, source_branch: 'feature/hello' },
    ]);
    const msgs = await all<{ role: string; content: string }>('SELECT role, content FROM messages WHERE app_id = ? ORDER BY created_at, id', app.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(msgs[1]!.content).toMatch(/Here is the plan[\s\S]*Say hello/);
    expect(JSON.parse((await one<{ meta: string }>('SELECT meta FROM messages WHERE app_id = ? AND meta IS NOT NULL', app.id))!.meta)).toEqual({
      type: 'plan',
      needsApproval: false,
    });
    expect(msgs[2]!.content).toBe('Your app is ready.');
    const types = (await all<{ type: string }>('SELECT type FROM events WHERE app_id = ? ORDER BY seq', app.id)).map((e) => e.type);
    const audited = (await all<{ action: string; via: string }>('SELECT action, via FROM audit_log WHERE app_id = ? ORDER BY at', app.id)).map(
      (r) => `${r.via}:${r.action}`,
    );
    expect(audited).toEqual(['api:app.created', 'system:repo.created', 'agent:pr.opened']);
    expect(types).toEqual(expect.arrayContaining(['progress', 'run.started', 'pr.updated', 'message.created', 'run.finished', 'notification']));

    // ---- turn 2: resume the same session; feedback sent mid-run is folded into it
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sdk.script = async function* (text) {
      if (!text.includes('[New message')) await gate;
      yield say(`ack: ${text.split('\n').at(-1)}`);
      yield result(0.25);
    };
    expect(await sendUserMessage(await appRow(app.id), 'Add a footer')).toEqual({ queued: true });
    await until(() => isRunning(app.id));
    await until(() => sdk.calls.length === 2 && sdk.calls[1]!.prompts.length === 1);
    expect(await sendUserMessage(await appRow(app.id), 'Make it blue')).toEqual({ delivered: true });
    await until(async () => Boolean(await one("SELECT 1 FROM events WHERE app_id = ? AND type = 'activity' AND payload LIKE '%feedback%'", app.id)));
    release();
    await until(idle(app.id));
    expect(sdk.calls[1]!.resume).toBe('sess-1');
    expect(sdk.calls[1]!.prompts).toEqual(['Add a footer', expect.stringMatching(/New message from the user[\s\S]*Make it blue/)]);
    expect((await runs(app.id)).map((r) => r.status)).toEqual(['succeeded', 'succeeded']);

    // ---- turn 3: stopRun aborts a long run
    sdk.script = async function* (_t, { signal }) {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      yield result();
    };
    await sendUserMessage(await appRow(app.id), 'Do something long');
    await until(() => isRunning(app.id) && sdk.calls.length === 3 && sdk.calls[2]!.prompts.length === 1);
    expect(await stopRun(app.id)).toBe(true);
    await until(idle(app.id));
    expect((await runs(app.id)).at(-1)!.status).toBe('stopped');

    // ---- history & replay (HTTP)
    const server = Fastify();
    await server.register(apiRoutes);
    const headers = { authorization: `Bearer ${await createSession(user.id)}` };
    const history = (await server.inject({ url: `/api/apps/${app.id}/runs`, headers })).json();
    expect(history.map((h: { status: string }) => h.status)).toEqual(['stopped', 'succeeded', 'succeeded']);
    const first = history.at(-1);
    expect(first).toMatchObject({ cost_usd: 0.5, pullRequests: [{ id: 1, title: 'Hello' }] });
    expect(first.durationSeconds).toBeGreaterThanOrEqual(0);
    const replay = (await server.inject({ url: `/api/apps/${app.id}/events?runId=${first.id}`, headers })).json();
    expect(replay.length).toBeGreaterThan(2);
    expect(replay.every((e: { runId: string }) => e.runId === first.id)).toBe(true);

    // ---- diff of the PR's branch
    const diff = (await server.inject({ url: `/api/apps/${app.id}/diff?branch=feature/hello`, headers })).json();
    expect(diff.files).toEqual([
      expect.objectContaining({ path: 'hello.txt', additions: 1, deletions: 0, binary: false, patch: expect.stringContaining('+hello') }),
    ]);
    expect((await server.inject({ url: `/api/apps/${app.id}/diff?branch=..%2Fetc`, headers })).statusCode).toBe(400);
    expect((await server.inject({ url: `/api/apps/${app.id}/diff?branch=feature/nope`, headers })).statusCode).toBe(404);
    expect((await appRow(app.id)).status).toBe('idle');
  });
});
