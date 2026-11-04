import { describe, expect, it, vi } from 'vitest';

// Limits under test (read when config is first imported).
process.env.AGENT_MAX_CONCURRENT_RUNS = '2';
process.env.AGENT_MAX_RUNS_PER_USER = '1';
process.env.AGENT_RESUME_INTERRUPTED = 'true';

vi.mock('@anthropic-ai/claude-agent-sdk', () => import('./fake-sdk.js'));
const { sdk, init, say, result, until } = await import('./fake-sdk.js');
const { createUser } = await import('../src/auth.js');
const { createApplication } = await import('../src/applications.js');
const { sendUserMessage, startScheduler, WORKER_ID } = await import('../src/agent/runner.js');
const { all, one, run, newId } = await import('../src/db.js');
type AppRow = import('../src/db.js').AppRow;

const status = async (appId: string) => (await one<{ status: string }>('SELECT status FROM applications WHERE id = ?', appId))!.status;
const runStatuses = async (appId: string) =>
  (await all<{ status: string }>('SELECT status FROM runs WHERE app_id = ? ORDER BY started_at', appId)).map((r) => r.status);
const appRow = async (id: string) => (await one<AppRow>('SELECT * FROM applications WHERE id = ?', id))!;

/** Each app's turn waits until released; prompts are recorded per app (cwd = workspace = app id). */
const gates = new Map<string, () => void>();
const release = (appId: string) => {
  const open = gates.get(appId);
  gates.delete(appId);
  open?.();
};
sdk.script = async function* (_text, { appCwd }) {
  const appId = appCwd.split('/').at(-1)!;
  await new Promise<void>((r) => gates.set(appId, r));
  yield init(`sess-${appId}`);
  yield say('ok');
  yield result(0.1);
};
const promptsOf = (appId: string) => sdk.calls.filter((c) => c.cwd.endsWith(appId)).flatMap((c) => c.prompts);

describe('run queue', () => {
  it('resumes runs interrupted by a restart, then enforces the limits', async () => {
    // ---- a run that was executing on this worker when it "crashed"
    const alice = await createUser('alice@x.io', 'Alice', 'password1');
    const a1 = await createApplication(alice.id, { name: 'Alice One', description: '', prompt: 'first' });
    await until(async () => (await appRow(a1.id)).repo_id !== null);
    await run("UPDATE runs SET status = 'stopped' WHERE app_id = ?", a1.id); // pretend the kickoff ran before
    await run("UPDATE applications SET status = 'running', agent_session_id = 'sess-old' WHERE id = ?", a1.id);
    await run("INSERT INTO runs (id, app_id, status, worker, started_at) VALUES (?, ?, 'running', ?, ?)", newId(), a1.id, WORKER_ID, new Date().toISOString());

    await startScheduler();
    await until(() => gates.has(a1.id));
    expect(promptsOf(a1.id)[0]).toMatch(/platform restarted/);
    expect(sdk.calls.at(-1)!.resume).toBe('sess-old');
    expect(await runStatuses(a1.id)).toEqual(['stopped', 'stopped', 'running']);

    // ---- per-user cap (1): Alice's second app waits; global cap (2): Carol waits behind Bob
    const a2 = await createApplication(alice.id, { name: 'Alice Two', description: '', prompt: 'second' });
    const bob = await createUser('bob@x.io', 'Bob', 'password1');
    const b1 = await createApplication(bob.id, { name: 'Bob One', description: '', prompt: 'bob' });
    await until(() => gates.has(b1.id));
    const carol = await createUser('carol@x.io', 'Carol', 'password1');
    const c1 = await createApplication(carol.id, { name: 'Carol One', description: '', prompt: 'carol' });
    await until(async () => (await status(a2.id)) === 'queued' && (await status(c1.id)) === 'queued');
    await new Promise((r) => setTimeout(r, 200));
    expect(gates.has(a2.id) || gates.has(c1.id)).toBe(false);

    // a message to a queued app joins its queued run
    expect(await sendUserMessage(await appRow(a2.id), 'and add tests')).toEqual({ queued: true });
    expect((await all('SELECT 1 FROM runs WHERE app_id = ? AND status = ?', a2.id, 'queued')).length).toBe(1);

    // Bob finishes → Carol starts (global slot); Alice still capped
    release(b1.id);
    await until(() => gates.has(c1.id));
    expect(gates.has(a2.id)).toBe(false);

    // ---- a message whose feedback signal was missed is not lost: it runs next
    const lost = newId();
    const running = (await one<{ id: string }>("SELECT id FROM runs WHERE app_id = ? AND status = 'running'", a1.id))!;
    await run(
      "INSERT INTO messages (id, app_id, run_id, role, content, created_at) VALUES (?, ?, ?, 'user', 'late message', ?)",
      lost,
      a1.id,
      running.id,
      new Date().toISOString(),
    );

    // Alice's first app finishes → its late message is queued again; a2 and a1 compete for Alice's single slot
    release(a1.id);
    await until(() => gates.has(a2.id) || gates.has(a1.id));
    const first = gates.has(a2.id) ? a2.id : a1.id;
    release(first);
    const second = first === a2.id ? a1.id : a2.id;
    await until(() => gates.has(second));
    release(second);
    release(c1.id);
    await until(async () => (await all("SELECT 1 FROM runs WHERE status IN ('queued', 'running')")).length === 0);

    expect(promptsOf(a2.id)).toEqual([expect.stringMatching(/second\n\nand add tests$/)]);
    expect(promptsOf(a1.id).at(-1)).toBe('late message');
    for (const id of [a1.id, a2.id, b1.id, c1.id]) expect(await status(id)).toBe('idle');
  });
});
