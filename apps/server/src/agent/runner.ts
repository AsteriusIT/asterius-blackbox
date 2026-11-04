import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config, paths } from '../config.js';
import { all, newId, one, run, updateApp, withLock, type AppRow, type MessageRow } from '../db.js';
import { notify, onControl, publish, sendControl, type ControlSignal } from '../events.js';
import { exec, gitProvider, type RepoInfo } from '../providers/git.js';
import { coderAgent, kickoffPrompt, PLANNER_TOOLS, systemPromptAppend } from './prompt.js';
import { addMessage } from './messages.js';
export { addMessage };
import { blackboxTools } from './tools.js';
import { guardHook } from './guard.js';
import { RunRecorder } from './mapper.js';
import { PromptStream } from './prompt-stream.js';
import { metrics } from '../metrics.js';
import { audit } from '../audit.js';
import { budgetBlock } from '../costs.js';
import { getTemplate, templateFiles } from '../templates.js';
import { attachmentBlocks, promptContent, type StoredAttachment } from './attachments.js';
import { tracer } from '../tracing.js';
import { SpanStatusCode, type Span } from '@opentelemetry/api';

/**
 * Agent runs are a queue in the database (runs.status = queued → running → succeeded | failed | stopped):
 *  - API side (any process): user messages join the app's queued run, or are delivered as feedback to its
 *    running one; stop requests cancel the queued run or signal the worker.
 *  - Worker side (BLACKBOX_ROLE=all|worker): claims queued runs within the concurrency limits and runs the
 *    Claude Agent SDK session. Signals travel over the control channel (Postgres NOTIFY across pods).
 * Each user message is tagged with the run that consumes it, so none is lost when a run ends while it arrives.
 */

const agentHome = path.join(config.DATA_DIR, 'agent-home');
fs.mkdirSync(agentHome, { recursive: true });
fs.mkdirSync(paths.workspaces, { recursive: true });

export interface RunRow {
  id: string;
  app_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped';
  prompt: string | null;
  worker: string | null;
  heartbeat_at: string | null;
  cost_usd: number | null;
  started_at: string;
}

const iso = () => new Date().toISOString();
const FEEDBACK_PREFIX = '[New message from the user while you are working — take it into account]\n';
const RESUME_PROMPT = 'The platform restarted while you were working. Check the state of the workspace and of the plan, then continue where you left off.';

// ------------------------------------------------------------------ API side

/** The app's queued run, created if needed (one per app, enforced by a unique index). */
async function queuedRun(appId: string, prompt: string | null = null) {
  const now = iso();
  await run(
    "INSERT INTO runs (id, app_id, status, prompt, queued_at, started_at) VALUES (?, ?, 'queued', ?, ?, ?) ON CONFLICT DO NOTHING",
    newId(),
    appId,
    prompt,
    now,
    now,
  );
  const q = (await one<RunRow>("SELECT * FROM runs WHERE app_id = ? AND status = 'queued'", appId))!;
  if (prompt && q.prompt !== prompt) await run("UPDATE runs SET prompt = COALESCE(prompt || '\n\n', '') || ? WHERE id = ?", prompt, q.id);
  return q.id;
}

async function showQueued(appId: string) {
  const app = await one<AppRow>('SELECT status FROM applications WHERE id = ?', appId);
  if (!app || app.status === 'provisioning' || app.status === 'running') return;
  await updateApp(appId, { status: 'queued' });
  void publish(appId, null, 'app.updated', { status: 'queued' });
}

/** Re-attach a message to the app's queued run, unless another process already did. */
async function requeueMessage(appId: string, messageId: string, fromRunId: string) {
  const q = await queuedRun(appId);
  const moved = await run('UPDATE messages SET run_id = ? WHERE id = ? AND run_id = ?', q, messageId, fromRunId);
  if (moved.changes) {
    await showQueued(appId);
    await sendControl({ type: 'wake' });
  }
}

/** Entry point for every user chat message. */
export async function sendUserMessage(
  app: AppRow,
  text: string,
  attachments: StoredAttachment[] = [],
): Promise<{ queued?: true; delivered?: true; blocked?: string }> {
  const current = await one<RunRow>(
    "SELECT * FROM runs WHERE app_id = ? AND status IN ('running', 'queued') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END LIMIT 1",
    app.id,
  );
  if (app.status === 'archived') return { blocked: 'This application is archived (read-only). Its owner can restore it.' };
  if (!current) {
    // A new run would start: respect the monthly budgets (feedback to a running session is always delivered).
    const blocked = await budgetBlock(app.id);
    if (blocked) {
      await addMessage(app.id, 'user', text);
      await addMessage(app.id, 'system', blocked);
      return { blocked };
    }
  }
  const runId = current?.id ?? (await queuedRun(app.id));
  const msg = await addMessage(app.id, 'user', text, runId, attachments.length ? { attachments } : undefined);
  // Re-read after the message is stored: a worker may have claimed or finished the run meanwhile.
  const status = (await one<RunRow>('SELECT status FROM runs WHERE id = ?', runId))?.status;
  if (status === 'running') {
    await sendControl({ type: 'feedback', runId, messageId: msg.id });
    return { delivered: true };
  }
  if (status === 'queued') {
    await showQueued(app.id);
    await sendControl({ type: 'wake' });
  } else await requeueMessage(app.id, msg.id, runId);
  return { queued: true };
}

/**
 * A run the platform starts on its own (e.g. PR feedback): queued with `prompt` unless the app is archived or over
 * budget; `note` is shown in the chat. Returns false when it was not queued.
 */
export async function queueSystemRun(appId: string, prompt: string, note: string) {
  const app = await one<AppRow>('SELECT * FROM applications WHERE id = ?', appId);
  if (!app || app.status === 'archived' || !app.repo_id) return false;
  const blocked = await budgetBlock(appId);
  if (blocked) {
    await addMessage(appId, 'system', `${note.split('.')[0]}. ${blocked}`);
    return false;
  }
  await queuedRun(appId, prompt);
  await addMessage(appId, 'system', note);
  await showQueued(appId);
  await sendControl({ type: 'wake' });
  return true;
}

/** Cancel the queued run and/or interrupt the running one. */
export async function stopRun(appId: string) {
  const cancelled = await run(
    "UPDATE runs SET status = 'stopped', ended_at = ?, summary = 'Cancelled before it started' WHERE app_id = ? AND status = 'queued'",
    iso(),
    appId,
  );
  const running = await one<RunRow>("SELECT id FROM runs WHERE app_id = ? AND status = 'running'", appId);
  if (running) await sendControl({ type: 'stop', runId: running.id });
  else if (cancelled.changes) {
    await updateApp(appId, { status: 'idle' });
    void publish(appId, null, 'app.updated', { status: 'idle' });
  }
  return Boolean(cancelled.changes || running);
}

/** Create the repository + policies; messages sent meanwhile wait in the app's queued run. */
export async function provisionApp(appId: string) {
  const app = (await one<AppRow>('SELECT * FROM applications WHERE id = ?', appId))!;
  try {
    const where = gitProvider().kind === 'azure-devops' ? `Azure DevOps project ${config.ADO_PROJECT}` : 'the local git server';
    void publish(appId, null, 'progress', {
      phase: 'understanding',
      title: `Creating the repository in ${where}`,
      detail: 'Pushing an initial commit and protecting main with branch policies',
    });
    const ci = gitProvider().ciFile;
    const files = getTemplate(app.template)
      ? Object.fromEntries(
          Object.entries(templateFiles(app.template!, { name: app.name, slug: app.slug })).filter(
            ([p]) => !['azure-pipelines.yml', '.github/workflows/ci.yml'].includes(p) || p === ci,
          ),
        )
      : undefined;
    const repo = app.repo_source
      ? await gitProvider().importRepository({ slug: app.slug, source: app.repo_source })
      : await gitProvider().createRepository({ slug: app.slug, name: app.name, description: app.description, files });
    await updateApp(appId, { status: 'ready', repo_id: repo.repoId, repo_name: repo.name, repo_web_url: repo.webUrl, repo_clone_url: repo.cloneUrl });
    await audit({
      action: 'repo.created',
      via: 'system',
      appId,
      target: repo.webUrl,
      detail: { provider: gitProvider().kind, policies: gitProvider().describePolicies() },
    });
    void publish(appId, null, 'app.updated', { status: 'ready', repo_web_url: repo.webUrl });
    void publish(appId, null, 'activity', {
      kind: 'repo',
      title: `Repository ${repo.name} created`,
      detail: gitProvider().describePolicies().join(' · '),
      link: repo.webUrl,
    });
    if (await one("SELECT 1 FROM runs WHERE app_id = ? AND status = 'queued'", appId)) {
      await showQueued(appId);
      await sendControl({ type: 'wake' });
    }
  } catch (err) {
    const message = (err as Error).message;
    await updateApp(appId, { status: 'error', last_error: message });
    void publish(appId, null, 'app.updated', { status: 'error', last_error: message });
    void notify(appId, null, { level: 'error', title: 'Repository provisioning failed', message });
  }
}

/** API boot: provisioning cannot survive a restart (runs are recovered by the workers). */
export async function recoverAfterRestart() {
  await run(
    "UPDATE applications SET status = 'error', last_error = 'Provisioning was interrupted by a server restart — retry it.' WHERE status = 'provisioning'",
  );
}

// ------------------------------------------------------------------ worker side

export async function prepareWorkspace(app: AppRow): Promise<string> {
  const ws = path.join(paths.workspaces, app.id);
  const repo: RepoInfo = { repoId: app.repo_id!, name: app.repo_name!, webUrl: app.repo_web_url!, cloneUrl: app.repo_clone_url! };
  if (!fs.existsSync(path.join(ws, '.git'))) {
    fs.mkdirSync(ws, { recursive: true });
    await exec('git', ['init', '-q', '-b', 'main', ws]);
    await gitProvider().configureWorkingCopy(ws, repo);
    await exec('git', ['-C', ws, 'remote', 'add', 'origin', repo.cloneUrl]);
    await exec('git', ['-C', ws, 'config', 'user.name', 'Blackbox Agent']);
    await exec('git', ['-C', ws, 'config', 'user.email', 'agent@blackbox.local']);
    await exec('git', ['-C', ws, 'fetch', '-q', 'origin']);
    await exec('git', ['-C', ws, 'checkout', '-q', '-B', 'main', 'origin/main']);
    await exec('git', ['-C', ws, 'branch', '-q', '--set-upstream-to=origin/main', 'main']);
  } else {
    await gitProvider().configureWorkingCopy(ws, repo); // rotate credentials if they changed
    await exec('git', ['-C', ws, 'fetch', '-q', '--prune', 'origin']).catch(() => undefined);
  }
  return ws;
}

/**
 * Sandboxed shell commands may read nothing under DATA_DIR (database, kubeconfig-local, other apps'
 * workspaces and their git credentials) except their own workspace and the agent home; never ~/.kube.
 */
export function sandboxFilesystem(app: Pick<AppRow, 'repo_clone_url'>, ws: string) {
  const denyRead = [config.DATA_DIR, path.join(process.env.HOME ?? '/root', '.kube')];
  if (config.KUBECONFIG_PATH) denyRead.push(path.resolve(config.KUBECONFIG_PATH));
  const allowRead = [ws, agentHome];
  // local provider: the agent fetches from its own bare repository (read-only: writing would let it edit the hook)
  if (app.repo_clone_url?.startsWith(paths.localRepos)) allowRead.push(app.repo_clone_url);
  return { allowWrite: [ws, '/tmp'], denyRead, allowRead };
}

interface ActiveRun {
  runId: string;
  appId: string;
  stream: PromptStream;
  q?: Query;
  abort: AbortController;
  delivered: Set<string>;
  stopped: boolean;
  startedAt: number;
  span: Span;
}

export const WORKER_ID = config.WORKER_ID ?? os.hostname();
const capacity = () => config.WORKER_CONCURRENCY ?? config.AGENT_MAX_CONCURRENT_RUNS;
const HEARTBEAT_MS = 15_000;
const STALE_MS = 4 * HEARTBEAT_MS;
const CLAIM_LOCK = 726201;

/** Runs executing in this process, by run id. */
const active = new Map<string, ActiveRun>();
let started = false;

/** Start claiming and executing queued runs in this process. */
export async function startScheduler() {
  if (started) return;
  started = true;
  // Runs this worker owned before it restarted (and legacy runs without an owner).
  await recoverInterrupted(await all<RunRow>("SELECT * FROM runs WHERE status = 'running' AND (worker = ? OR worker IS NULL)", WORKER_ID));
  await run(
    "UPDATE applications SET status = 'idle' WHERE status = 'running' AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.app_id = applications.id AND r.status = 'running')",
  );
  onControl((c) => void onSignal(c).catch((err) => console.warn('[runner] control signal failed', err)));
  setInterval(() => void tick(), 3000).unref();
  setInterval(
    () => void run("UPDATE runs SET heartbeat_at = ? WHERE worker = ? AND status = 'running'", iso(), WORKER_ID).catch(() => undefined),
    HEARTBEAT_MS,
  ).unref();
  setInterval(() => void sweepStale().catch((err) => console.warn('[runner] stale sweep failed', err)), 30_000).unref();
  void tick();
}

async function onSignal(c: ControlSignal) {
  if (c.type === 'wake') return tick();
  const h = active.get(c.runId);
  if (!h) return; // another worker's run
  if (c.type === 'stop') {
    h.stopped = true;
    h.stream.close();
    try {
      await h.q?.interrupt();
    } catch {
      h.abort.abort();
    }
    return;
  }
  if (h.delivered.has(c.messageId)) return;
  const msg = await one<MessageRow>('SELECT * FROM messages WHERE id = ?', c.messageId);
  if (!msg) return;
  // Fold into the running session: the agent sees it at its next step. Too late (stream closed) → the
  // message stays undelivered and the end-of-run sweep queues it for the next run.
  if (!h.stream.push(promptContent(FEEDBACK_PREFIX + msg.content, attachmentBlocks(h.appId, msg)))) return;
  h.delivered.add(msg.id);
  void publish(h.appId, h.runId, 'activity', { kind: 'feedback', title: 'Your message was delivered to the agent' });
}

let ticking = false;
let again = false;
async function tick() {
  if (ticking) {
    again = true;
    return;
  }
  ticking = true;
  try {
    do {
      again = false;
      while (active.size < capacity()) {
        const next = await claim();
        if (!next) break;
        void executeRun(next);
      }
    } while (again);
  } catch (err) {
    console.warn('[runner] scheduling failed', err);
  } finally {
    ticking = false;
  }
}

/** Claim the oldest queued run allowed by the limits: global, per user, one per application. */
function claim() {
  return withLock(CLAIM_LOCK, async (d) => {
    const running = (await d.query<{ n: number }>("SELECT count(*) AS n FROM runs WHERE status = 'running'")).rows[0]!.n;
    if (Number(running) >= config.AGENT_MAX_CONCURRENT_RUNS) return null;
    const next = (
      await d.query<RunRow>(
        `SELECT r.* FROM runs r JOIN applications a ON a.id = r.app_id
         WHERE r.status = 'queued' AND a.repo_id IS NOT NULL AND a.status != 'archived'
           AND NOT EXISTS (SELECT 1 FROM runs x WHERE x.app_id = r.app_id AND x.status = 'running')
           AND (SELECT count(*) FROM runs x JOIN applications b ON b.id = x.app_id WHERE x.status = 'running' AND b.owner_id = a.owner_id) < ?
         ORDER BY r.queued_at, r.started_at LIMIT 1`,
        [config.AGENT_MAX_RUNS_PER_USER],
      )
    ).rows[0];
    if (!next) return null;
    const now = iso();
    await d.query("UPDATE runs SET status = 'running', worker = ?, heartbeat_at = ?, started_at = ? WHERE id = ? AND status = 'queued'", [
      WORKER_ID,
      now,
      now,
      next.id,
    ]);
    return next;
  });
}

/** Runs whose worker stopped heart-beating (pod killed) are recovered by any live worker. */
async function sweepStale() {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const stale = await all<RunRow>("SELECT * FROM runs WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)", cutoff);
  await recoverInterrupted(stale.filter((r) => !active.has(r.id)));
}

/** Interrupted runs: resumed in the same agent session (AGENT_RESUME_INTERRUPTED) or stopped. */
async function recoverInterrupted(runs: RunRow[]) {
  for (const r of runs) {
    const changed = await run(
      "UPDATE runs SET status = 'stopped', ended_at = ?, summary = 'Interrupted by a server restart' WHERE id = ? AND status = 'running'",
      iso(),
      r.id,
    );
    if (!changed.changes) continue;
    void publish(r.app_id, r.id, 'run.finished', { status: 'stopped' });
    if (config.AGENT_RESUME_INTERRUPTED) {
      await queuedRun(r.app_id, RESUME_PROMPT);
      await addMessage(r.app_id, 'system', 'The platform restarted while the agent was working. It resumes automatically where it stopped.');
      await updateApp(r.app_id, { status: 'queued' });
      void publish(r.app_id, null, 'app.updated', { status: 'queued' });
      await sendControl({ type: 'wake' });
    } else {
      await addMessage(r.app_id, 'system', 'The platform restarted while the agent was working. Send a message to let it continue where it stopped.');
      await updateApp(r.app_id, { status: 'idle' });
      void publish(r.app_id, null, 'app.updated', { status: 'idle' });
    }
  }
}

async function executeRun(r: RunRow) {
  const appId = r.app_id;
  const runId = r.id;
  const stream = new PromptStream();
  const abort = new AbortController();
  const span = tracer.startSpan('agent.run', { attributes: { 'blackbox.app_id': appId, 'blackbox.run_id': runId, 'blackbox.worker': WORKER_ID } });
  const handle: ActiveRun = { runId, appId, stream, abort, delivered: new Set(), stopped: false, startedAt: Date.now(), span };
  active.set(runId, handle);

  // Sink writes are not awaited by the mapper; they are awaited before the run is closed.
  const writes: Promise<unknown>[] = [];
  const rec = new RunRecorder(
    {
      activity: (p) => void writes.push(publish(appId, runId, 'activity', p)),
      message: (role, content) => void writes.push(addMessage(appId, role, content, runId)),
      session: (id) => void writes.push(updateApp(appId, { agent_session_id: id })),
    },
    path.join(paths.workspaces, appId),
    config.AGENT_MAX_BUDGET_USD,
  );

  try {
    const app = (await one<AppRow>('SELECT * FROM applications WHERE id = ?', appId))!;
    const msgs = await all<MessageRow>("SELECT * FROM messages WHERE run_id = ? AND role = 'user' ORDER BY created_at, id", runId);
    msgs.forEach((m) => handle.delivered.add(m.id));
    const text = [r.prompt, ...msgs.map((m) => m.content)].filter(Boolean).join('\n\n');
    if (!text) {
      await run('DELETE FROM runs WHERE id = ?', runId); // its messages moved to another run
      return;
    }
    await updateApp(appId, { status: 'running' });
    metrics.runStarted();
    void publish(appId, runId, 'run.started', {});
    void publish(appId, runId, 'app.updated', { status: 'running' });

    const ws = await prepareWorkspace(app);
    const blocks = msgs.flatMap((m) => attachmentBlocks(appId, m));
    stream.push(promptContent(app.agent_session_id ? text : kickoffPrompt(app, text), blocks));

    const q = query({
      prompt: stream,
      options: {
        cwd: ws,
        // Step 1: the planner/lead runs the session; step 2: it delegates implementation to the coder subagent.
        model: config.AGENT_PLANNER_MODEL,
        effort: config.AGENT_PLANNER_EFFORT,
        agents: { coder: coderAgent() },
        maxTurns: config.AGENT_MAX_TURNS,
        maxBudgetUsd: config.AGENT_MAX_BUDGET_USD,
        resume: app.agent_session_id ?? undefined,
        abortController: abort,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend(app) },
        tools: PLANNER_TOOLS,
        disallowedTools: [
          'AskUserQuestion',
          'EnterPlanMode',
          'ExitPlanMode',
          'EnterWorktree',
          'ExitWorktree',
          'CronCreate',
          'CronDelete',
          'RemoteTrigger',
          'PushNotification',
        ],
        mcpServers: { blackbox: blackboxTools({ app, runId, workspace: ws, span }) },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        hooks: { PreToolUse: [{ hooks: [guardHook(ws)] }] },
        sandbox: config.AGENT_SANDBOX
          ? {
              enabled: true,
              failIfUnavailable: false,
              autoAllowBashIfSandboxed: true,
              filesystem: sandboxFilesystem(app, ws),
            }
          : undefined,
        env: {
          PATH: process.env.PATH,
          HOME: agentHome,
          LANG: process.env.LANG ?? 'C.UTF-8',
          ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
          GIT_TERMINAL_PROMPT: '0',
          CI: 'true',
          CLAUDE_AGENT_SDK_CLIENT_APP: 'asterius-ai-blackbox/0.1.0',
        },
        stderr: (d) => process.env.DEBUG_AGENT && process.stderr.write(`[agent ${appId.slice(0, 8)}] ${d}`),
      },
    });
    handle.q = q;

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      // No feedback arrived during the turn → end the session; otherwise the next turn starts automatically.
      if (rec.handle(msg) && stream.pending === 0) stream.close();
    }
  } catch (err) {
    rec.crashed(err as Error, abort.signal.aborted || handle.stopped);
  } finally {
    active.delete(runId);
    stream.close();
    await Promise.allSettled(writes);
    await finishRun(handle, rec).catch((err) => console.error('[runner] could not close run', runId, err));
    span.setAttributes({ 'blackbox.status': rec.status, 'blackbox.cost_usd': rec.cost ?? 0, 'blackbox.turns': rec.turns ?? 0 });
    if (rec.status === 'failed') span.setStatus({ code: SpanStatusCode.ERROR, message: rec.summary.slice(0, 200) });
    span.end();
    void tick();
  }
}

async function finishRun(h: ActiveRun, rec: RunRecorder) {
  const { appId, runId } = h;
  const exists = await one('SELECT 1 FROM runs WHERE id = ?', runId);
  if (!exists) return; // empty run, deleted
  const { status, summary, cost, turns } = rec;
  metrics.runFinished({ status, seconds: (Date.now() - h.startedAt) / 1000, cost, inputTokens: rec.inputTokens, outputTokens: rec.outputTokens });
  await run(
    `UPDATE runs SET status = ?, cost_usd = ?, num_turns = ?, summary = ?, ended_at = ? WHERE id = ?`,
    status,
    cost,
    turns,
    summary.slice(0, 4000),
    iso(),
    runId,
  );
  // Messages that arrived too late for this run go to the next one (unless the user stopped the agent).
  if (!h.stopped)
    for (const m of await all<{ id: string }>("SELECT id FROM messages WHERE run_id = ? AND role = 'user'", runId))
      if (!h.delivered.has(m.id)) await requeueMessage(appId, m.id, runId);
  const next = await one("SELECT 1 FROM runs WHERE app_id = ? AND status = 'queued'", appId);
  const appStatus = next ? 'queued' : status === 'failed' ? 'error' : 'idle';
  await updateApp(appId, {
    status: appStatus,
    phase: status === 'succeeded' ? 'done' : null,
    last_error: status === 'failed' ? summary.slice(0, 1000) : null,
  });
  void publish(appId, runId, 'run.finished', { status, costUsd: cost, turns });
  void publish(appId, runId, 'app.updated', { status: appStatus });
  void notify(appId, runId, {
    level: status === 'succeeded' ? 'success' : status === 'stopped' ? 'info' : 'error',
    title:
      status === 'succeeded' ? 'The agent finished — your feedback is welcome' : status === 'stopped' ? 'Agent stopped' : 'The agent stopped with an error',
    message: summary.split('\n')[0]?.slice(0, 280) || '',
  });
}

/** Test helper: is a run of this app executing in this process? */
export const isRunning = (appId: string) => [...active.values()].some((h) => h.appId === appId);
