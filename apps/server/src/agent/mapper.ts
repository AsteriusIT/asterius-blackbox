import path from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK message → Blackbox events/messages. No I/O: everything goes through the injected sink,
 * so the mapping is unit-testable with scripted SDK messages.
 */

export interface RunSink {
  activity(payload: Record<string, unknown>): void;
  message(role: 'assistant' | 'system', content: string): void;
  session(sessionId: string): void;
}

export type RunStatus = 'succeeded' | 'failed' | 'stopped';

export function describeTool(name: string, input: Record<string, unknown>, ws: string): { kind: string; title: string; detail?: string } | null {
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
      return {
        kind: 'delegate',
        title: `Building: ${String(input.description ?? 'next step')}`,
        detail: String(input.prompt ?? '').slice(0, 3000) || undefined,
      };
    case 'TodoWrite':
      return null; // rendered as a plan
    default:
      if (name.startsWith('mcp__blackbox__')) return null; // those tools publish their own events
      return { kind: 'tool', title: name };
  }
}

const FAILURES: Record<string, (budget: number) => string> = {
  error_max_turns: () => 'I reached the maximum number of steps for one run.',
  error_max_budget_usd: (b) => `I reached the budget limit for one run ($${b}).`,
  error_during_execution: () => 'The run stopped because of an execution error.',
  error_max_structured_output_retries: () => 'The run failed.',
};

/** Accumulates the state of one run while mapping its SDK messages. */
export class RunRecorder {
  status: RunStatus = 'succeeded';
  summary = '';
  cost: number | null = null;
  turns: number | null = null;
  inputTokens = 0;
  outputTokens = 0;
  private buffered = '';
  private reported = false;

  constructor(
    private readonly sink: RunSink,
    private readonly ws: string,
    private readonly budgetUsd: number,
  ) {}

  flushNarration() {
    if (this.buffered.trim()) this.sink.activity({ kind: 'narration', title: this.buffered.trim().slice(0, 4000) });
    this.buffered = '';
  }

  /** Returns true when the message ended a turn (a `result`). */
  handle(msg: SDKMessage): boolean {
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) this.sink.session(msg.session_id);

    if (msg.type === 'assistant') {
      const coder = msg.parent_tool_use_id !== null;
      for (const block of msg.message.content) {
        if (block.type === 'text' && !coder) {
          this.buffered += (this.buffered ? '\n\n' : '') + block.text;
        } else if (block.type === 'tool_use') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          if (coder) {
            if (block.name === 'TodoWrite') continue;
          } else {
            this.flushNarration();
            if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
              this.sink.activity({ kind: 'plan', title: 'Plan updated', todos: input.todos });
              continue;
            }
          }
          const d = describeTool(block.name, input, this.ws);
          if (d) this.sink.activity({ ...d, actor: coder ? 'coder' : 'planner', toolUseId: block.id });
        }
      }
    }

    if (msg.type === 'user' && msg.parent_tool_use_id === null && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (typeof block === 'object' && block.type === 'tool_result' && block.is_error) {
          const text = Array.isArray(block.content) ? block.content.map((c) => ('text' in c ? c.text : '')).join('\n') : String(block.content ?? '');
          this.sink.activity({ kind: 'error', title: 'A step failed — the agent will handle it', detail: text.slice(0, 2000), toolUseId: block.tool_use_id });
        }
      }
    }

    if (msg.type !== 'result') return false;
    this.cost = msg.total_cost_usd;
    this.turns = msg.num_turns;
    this.inputTokens += msg.usage?.input_tokens ?? 0;
    this.outputTokens += msg.usage?.output_tokens ?? 0;
    if (msg.subtype === 'success' && msg.is_error) {
      // API-level failure (auth, overload…) surfaced as a result; the SDK throws right after.
      this.status = 'failed';
      this.summary = msg.result || 'The agent hit an API error.';
      this.reported = true;
      this.buffered = '';
      this.sink.message('system', `The agent hit an error: ${this.summary}`);
    } else if (msg.subtype === 'success') {
      this.summary = this.buffered.trim() || msg.result;
      this.buffered = '';
      if (this.summary) this.sink.message('assistant', this.summary);
    } else {
      this.flushNarration();
      this.status = 'failed';
      this.summary = (FAILURES[msg.subtype] ?? FAILURES.error_max_structured_output_retries!)(this.budgetUsd);
      this.sink.message('assistant', `${this.summary} Send a message to let me continue where I stopped.`);
    }
    return true;
  }

  /** The SDK threw (or was aborted). */
  crashed(err: Error, aborted: boolean) {
    this.flushNarration();
    if (aborted) this.status = 'stopped';
    else if (!this.reported) {
      this.status = 'failed';
      this.summary = err.message;
      this.sink.message('system', `The agent crashed: ${this.summary}`);
    }
  }
}
