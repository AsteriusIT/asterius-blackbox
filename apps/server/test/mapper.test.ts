import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describeTool, RunRecorder } from '../src/agent/mapper.js';

const ws = '/ws/app';

describe('describeTool', () => {
  it('classifies bash commands', () => {
    expect(describeTool('Bash', { command: 'git status' }, ws)?.kind).toBe('git');
    expect(describeTool('Bash', { command: 'npm test' }, ws)?.kind).toBe('test');
    expect(describeTool('Bash', { command: 'ls -la', description: 'List files' }, ws)).toMatchObject({ kind: 'shell', title: 'List files' });
  });
  it('uses workspace-relative paths', () => {
    expect(describeTool('Write', { file_path: '/ws/app/src/a.ts' }, ws)?.title).toBe('Created src/a.ts');
    expect(describeTool('Edit', { file_path: 'b.ts' }, ws)?.title).toBe('Edited b.ts');
  });
  it('hides platform tools and TodoWrite', () => {
    expect(describeTool('mcp__blackbox__report_progress', {}, ws)).toBeNull();
    expect(describeTool('TodoWrite', {}, ws)).toBeNull();
  });
  it('labels delegations', () => expect(describeTool('Agent', { description: 'API' }, ws)).toMatchObject({ kind: 'delegate', title: 'Building: API' }));
});

function recorder() {
  const out = { activity: [] as Record<string, unknown>[], messages: [] as [string, string][], session: '' };
  const rec = new RunRecorder(
    { activity: (p) => out.activity.push(p), message: (r, c) => out.messages.push([r, c]), session: (id) => (out.session = id) },
    ws,
    25,
  );
  return { rec, out };
}

const assistant = (content: unknown[], parent: string | null = null) =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { content } }) as unknown as SDKMessage;
const result = (extra: Record<string, unknown>) =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 1.5,
    num_turns: 3,
    result: 'done',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  }) as unknown as SDKMessage;

describe('RunRecorder', () => {
  it('records the session id', () => {
    const { rec, out } = recorder();
    rec.handle({ type: 'system', subtype: 'init', session_id: 'sess-1' } as unknown as SDKMessage);
    expect(out.session).toBe('sess-1');
  });

  it('turns narration + tool calls into activity, final text into the summary', () => {
    const { rec, out } = recorder();
    rec.handle(
      assistant([
        { type: 'text', text: 'Looking around' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } },
      ]),
    );
    rec.handle(assistant([{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'x' }] } }]));
    rec.handle(assistant([{ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: 'a.ts' } }], 'parent'));
    rec.handle(assistant([{ type: 'text', text: 'All done!' }]));
    expect(rec.handle(result({}))).toBe(true);
    expect(out.activity.map((a) => a.kind)).toEqual(['narration', 'read', 'plan', 'edit']);
    expect(out.activity[3]).toMatchObject({ actor: 'coder' });
    expect(out.messages).toEqual([['assistant', 'All done!']]);
    expect(rec).toMatchObject({ status: 'succeeded', summary: 'All done!', cost: 1.5, turns: 3, inputTokens: 10, outputTokens: 5 });
  });

  it('reports failed tool results', () => {
    const { rec, out } = recorder();
    rec.handle({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', is_error: true, tool_use_id: 't', content: 'boom' }] },
    } as unknown as SDKMessage);
    expect(out.activity[0]).toMatchObject({ kind: 'error', detail: 'boom' });
  });

  it('maps budget errors', () => {
    const { rec, out } = recorder();
    rec.handle(result({ subtype: 'error_max_budget_usd' }));
    expect(rec.status).toBe('failed');
    expect(out.messages[0]![1]).toMatch(/budget limit for one run \(\$25\)/);
  });

  it('maps API errors and does not double-report the crash', () => {
    const { rec, out } = recorder();
    rec.handle(result({ is_error: true, result: 'overloaded' }));
    rec.crashed(new Error('exit 1'), false);
    expect(rec.status).toBe('failed');
    expect(out.messages).toEqual([['system', 'The agent hit an error: overloaded']]);
  });

  it('marks aborted runs as stopped', () => {
    const { rec } = recorder();
    rec.crashed(new Error('aborted'), true);
    expect(rec.status).toBe('stopped');
  });
});
