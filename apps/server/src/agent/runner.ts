import fs from 'node:fs';
import path from 'node:path';
import { query, type HookCallback, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { config, paths } from '../config.js';
import { newId, one, run, updateApp, type AppRow, type MessageRow } from '../db.js';
import { notify, publish } from '../events.js';
import { exec, gitProvider, type RepoInfo } from '../providers/git.js';
import { coderAgent, kickoffPrompt, PLANNER_TOOLS, systemPromptAppend } from './prompt.js';
import { addMessage } from './messages.js';
export { addMessage };
import { blackboxTools } from './tools.js';

const agentHome = path.join(config.DATA_DIR, 'agent-home');
fs.mkdirSync(agentHome, { recursive: true });
fs.mkdirSync(paths.workspaces, { recursive: true });

/** A push-based async iterable used as the agent's prompt stream, so the user can send feedback mid-run. */
class PromptStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiter?: (r: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  push(text: string) {
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: msg, done: false });
    } else this.queue.push(msg);
  }
  get pending() {
    return this.queue.length;
  }
  close() {
    this.closed = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.queue.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
    };
  }
}

interface ActiveRun {
  runId: string;
  stream: PromptStream;
  q?: Query;
  abort: AbortController;
}

const active = new Map<string, ActiveRun>();
/** Messages received while the repository is still being provisioned. */
const pendingBeforeReady = new Map<string, string[]>();

export const isRunning = (appId: string) => active.has(appId);

// ------------------------------------------------------------------ public API


export function queueBeforeReady(appId: string, text: string) {
  pendingBeforeReady.set(appId, [...(pendingBeforeReady.get(appId) ?? []), text]);
}

/** Entry point for every user chat message. */
export function sendUserMessage(app: AppRow, text: string) {
  const current = active.get(app.id);
  addMessage(app.id, 'user', text, current?.runId ?? null);

  if (app.status === 'provisioning') {
    queueBeforeReady(app.id, text);
    return { queued: true };
  }
  if (current) {
    // Fold into the running session: the agent sees it at its next step.
    current.stream.push(`[New message from the user while you are working — take it into account]\n${text}`);
    publish(app.id, current.runId, 'activity', { kind: 'feedback', title: 'Your message was delivered to the agent' });
    return { delivered: true };
  }
  void startRun(app.id, text);
  return { started: true };
}

export async function stopRun(appId: string) {
  const r = active.get(appId);
  if (!r) return false;
  r.stream.close();
  try {
    await r.q?.interrupt();
  } catch {
    r.abort.abort();
  }
  return true;
}

/** Create the ADO repository + policies, then start the first run with whatever the user already said. */
export async function provisionApp(appId: string) {
  const app = one<AppRow>('SELECT * FROM applications WHERE id = ?', appId)!;
  try {
    const where = gitProvider().kind === 'azure-devops' ? `Azure DevOps project ${config.ADO_PROJECT}` : 'the local git server';
    publish(appId, null, 'progress', { phase: 'understanding', title: `Creating the repository in ${where}`, detail: 'Pushing an initial commit and protecting main with branch policies' });
    const repo = await gitProvider().createRepository({ slug: app.slug, name: app.name, description: app.description });
    updateApp(appId, { status: 'ready', repo_id: repo.repoId, repo_name: repo.name, repo_web_url: repo.webUrl, repo_clone_url: repo.cloneUrl });
    publish(appId, null, 'app.updated', { status: 'ready', repo_web_url: repo.webUrl });
    publish(appId, null, 'activity', {
      kind: 'repo',
      title: `Repository ${repo.name} created`,
      detail: gitProvider().describePolicies().join(' · '),
      link: repo.webUrl,
    });
    const pending = pendingBeforeReady.get(appId) ?? [];
    pendingBeforeReady.delete(appId);
    if (pending.length) {
      const fresh = one<AppRow>('SELECT * FROM applications WHERE id = ?', appId)!;
      void startRun(appId, kickoffPrompt(fresh, pending.join('\n\n')));
    }
  } catch (err) {
    const message = (err as Error).message;
    updateApp(appId, { status: 'error', last_error: message });
    publish(appId, null, 'app.updated', { status: 'error', last_error: message });
    notify(appId, null, { level: 'error', title: 'Repository provisioning failed', message });
  }
}

// ------------------------------------------------------------------ internals

async function prepareWorkspace(app: AppRow): Promise<string> {
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

/** Defence in depth: the real protection is the server-side branch policy, this just fails fast and explains. */
function guardHook(workspace: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const deny = (reason: string) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason },
    });
    const ti = input.tool_input as Record<string, unknown>;
    if (input.tool_name === 'Bash') {
      const cmd = String(ti.command ?? '');
      if (/\bgit\b[^|;&]*\bpush\b/.test(cmd)) {
        if (/(\s|:)(refs\/heads\/)?(main|master)\b/.test(cmd))
          return deny('main is protected by branch policy. Push a feature branch and open a pull request instead.');
        if (/\s(-f|--force|--force-with-lease|--mirror|--delete|-d)\b/.test(cmd) || /\s\+\S+/.test(cmd))
          return deny('Force pushes, mirror pushes and remote branch deletion are not allowed.');
      }
      if (/\b(kubectl|helm|az)\b/.test(cmd)) return deny('Use the mcp__blackbox__* tools for cluster and Azure operations.');
      if (/http\.[^\s]*extraheader/i.test(cmd)) return deny('Do not read or modify git credentials.');
    }
    if (['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name)) {
      const p = String(ti.file_path ?? ti.notebook_path ?? '');
      if (p && !path.resolve(workspace, p).startsWith(workspace + path.sep) && path.resolve(workspace, p) !== workspace)
        return deny(`You may only write inside the workspace ${workspace}.`);
    }
    return {};
  };
}

function describeTool(name: string, input: Record<string, unknown>, ws: string): { kind: string; title: string; detail?: string } | null {
  const rel = (p: unknown) => (typeof p === 'string' ? path.relative(ws, path.resolve(ws, p)) || '.' : '');
  switch (name) {
    case 'Bash': {
      const cmd = String(input.command ?? '');
      const kind = /\bgit\b/.test(cmd) ? 'git' : /\b(test|jest|vitest|pytest|go test|npm (run )?test)\b/.test(cmd) ? 'test' : 'shell';
      return { kind, title: String(input.description ?? cmd.split('\n')[0]).slice(0, 140), detail: cmd.slice(0, 2000) };
    }
    case 'Write':
      return { kind: 'edit', title: `Created ${rel(input.file_path)}` };
    case 'Edit':
      return { kind: 'edit', title: `Edited ${rel(input.file_path)}` };
    case 'Read':
      return { kind: 'read', title: `Read ${rel(input.file_path)}` };
    case 'Glob':
    case 'Grep':
      return { kind: 'read', title: `Searched for ${String(input.pattern ?? '')}`.slice(0, 140) };
    case 'WebSearch':
      return { kind: 'web', title: `Searched the web: ${String(input.query ?? '')}` };
    case 'WebFetch':
      return { kind: 'web', title: `Read ${String(input.url ?? '')}` };
    case 'Agent':
    case 'Task':
      return { kind: 'delegate', title: `Building: ${String(input.description ?? 'next step')}`, detail: String(input.prompt ?? '').slice(0, 3000) || undefined };
    case 'TodoWrite':
      return null; // rendered as a plan, see below
    default:
      if (name.startsWith('mcp__blackbox__')) return null; // those tools publish their own events
      return { kind: 'tool', title: name };
  }
}

async function startRun(appId: string, prompt: string) {
  if (active.has(appId)) return;
  const runId = newId();
  const stream = new PromptStream();
  const abort = new AbortController();
  const handle: ActiveRun = { runId, stream, abort };
  active.set(appId, handle);

  run(`INSERT INTO runs (id, app_id, status) VALUES (?, ?, 'running')`, runId, appId);
  updateApp(appId, { status: 'running' });
  publish(appId, runId, 'run.started', {});
  publish(appId, runId, 'app.updated', { status: 'running' });

  let finalStatus: 'succeeded' | 'failed' | 'stopped' = 'succeeded';
  let summary = '';
  let cost: number | null = null;
  let turns: number | null = null;
  let bufferedText = '';
  let reported = false;

  const flushNarration = () => {
    if (bufferedText.trim()) publish(appId, runId, 'activity', { kind: 'narration', title: bufferedText.trim().slice(0, 4000) });
    bufferedText = '';
  };

  try {
    const app = one<AppRow>('SELECT * FROM applications WHERE id = ?', appId)!;
    const ws = await prepareWorkspace(app);
    stream.push(prompt);

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
        disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'RemoteTrigger', 'PushNotification'],
        mcpServers: { blackbox: blackboxTools({ app, runId, workspace: ws }) },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        hooks: { PreToolUse: [{ hooks: [guardHook(ws)] }] },
        sandbox: config.AGENT_SANDBOX
          ? {
              enabled: true,
              failIfUnavailable: false,
              autoAllowBashIfSandboxed: true,
              filesystem: { allowWrite: [ws, '/tmp'], denyRead: [config.DATA_DIR + '/blackbox.db', path.join(process.env.HOME ?? '/root', '.kube')] },
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
      if ('session_id' in msg && msg.session_id && msg.type === 'system' && msg.subtype === 'init') {
        updateApp(appId, { agent_session_id: msg.session_id });
      }

      // Coder (subagent) steps: shown as technical activity attributed to the coder.
      if (msg.type === 'assistant' && msg.parent_tool_use_id !== null) {
        for (const block of msg.message.content) {
          if (block.type !== 'tool_use' || block.name === 'TodoWrite') continue;
          const d = describeTool(block.name, (block.input ?? {}) as Record<string, unknown>, ws);
          if (d) publish(appId, runId, 'activity', { ...d, actor: 'coder', toolUseId: block.id });
        }
      }

      if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            bufferedText += (bufferedText ? '\n\n' : '') + block.text;
          } else if (block.type === 'tool_use') {
            flushNarration();
            const input = (block.input ?? {}) as Record<string, unknown>;
            if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
              publish(appId, runId, 'activity', { kind: 'plan', title: 'Plan updated', todos: input.todos });
              continue;
            }
            const d = describeTool(block.name, input, ws);
            if (d) publish(appId, runId, 'activity', { ...d, actor: 'planner', toolUseId: block.id });
          }
        }
      }

      if (msg.type === 'user' && msg.parent_tool_use_id === null && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (typeof block === 'object' && block.type === 'tool_result' && block.is_error) {
            const text = Array.isArray(block.content) ? block.content.map((c) => ('text' in c ? c.text : '')).join('\n') : String(block.content ?? '');
            publish(appId, runId, 'activity', { kind: 'error', title: 'A step failed — the agent will handle it', detail: text.slice(0, 2000), toolUseId: block.tool_use_id });
          }
        }
      }

      if (msg.type === 'result') {
        cost = msg.total_cost_usd;
        turns = msg.num_turns;
        if (msg.subtype === 'success' && msg.is_error) {
          // API-level failure (auth, overload…) surfaced as a result; the SDK throws right after.
          finalStatus = 'failed';
          summary = msg.result || 'The agent hit an API error.';
          reported = true;
          bufferedText = '';
          addMessage(appId, 'system', `The agent hit an error: ${summary}`, runId);
        } else if (msg.subtype === 'success') {
          summary = bufferedText.trim() || msg.result;
          bufferedText = '';
          if (summary) addMessage(appId, 'assistant', summary, runId);
        } else {
          flushNarration();
          finalStatus = 'failed';
          summary = {
            error_max_turns: 'I reached the maximum number of steps for one run.',
            error_max_budget_usd: `I reached the budget limit for one run ($${config.AGENT_MAX_BUDGET_USD}).`,
            error_during_execution: 'The run stopped because of an execution error.',
            error_max_structured_output_retries: 'The run failed.',
          }[msg.subtype];
          addMessage(appId, 'assistant', `${summary} Send a message to let me continue where I stopped.`, runId);
        }
        // No feedback arrived during the turn → end the session; otherwise the next turn starts automatically.
        if (stream.pending === 0) stream.close();
      }
    }
  } catch (err) {
    flushNarration();
    if (abort.signal.aborted) finalStatus = 'stopped';
    else if (!reported) {
      finalStatus = 'failed';
      summary = (err as Error).message;
      addMessage(appId, 'system', `The agent crashed: ${summary}`, runId);
    }
  } finally {
    active.delete(appId);
    stream.close();
    run(`UPDATE runs SET status = ?, cost_usd = ?, num_turns = ?, summary = ?, ended_at = datetime('now') WHERE id = ?`, finalStatus, cost, turns, summary.slice(0, 4000), runId);
    updateApp(appId, { status: finalStatus === 'failed' ? 'error' : 'idle', phase: finalStatus === 'succeeded' ? 'done' : null, last_error: finalStatus === 'failed' ? summary.slice(0, 1000) : null });
    publish(appId, runId, 'run.finished', { status: finalStatus, costUsd: cost, turns });
    publish(appId, runId, 'app.updated', { status: finalStatus === 'failed' ? 'error' : 'idle' });
    notify(appId, runId, {
      level: finalStatus === 'succeeded' ? 'success' : finalStatus === 'stopped' ? 'info' : 'error',
      title: finalStatus === 'succeeded' ? 'The agent finished — your feedback is welcome' : finalStatus === 'stopped' ? 'Agent stopped' : 'The agent stopped with an error',
      message: summary.split('\n')[0]?.slice(0, 280) || '',
    });
  }
}

/** On boot, in-flight runs are marked interrupted (a new message resumes the agent session). */
export function recoverAfterRestart() {
  run(`UPDATE runs SET status = 'stopped', ended_at = datetime('now'), summary = 'Interrupted by a server restart' WHERE status = 'running'`);
  run(`UPDATE applications SET status = 'idle' WHERE status = 'running'`);
  run(`UPDATE applications SET status = 'error', last_error = 'Provisioning was interrupted by a server restart — retry it.' WHERE status = 'provisioning'`);
}
