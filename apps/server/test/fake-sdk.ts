import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Scripted fake of the Claude Agent SDK: query() reads the prompt stream like the real SDK and emits
 * the messages produced by `sdk.script` for each user turn. Use with
 * `vi.mock('@anthropic-ai/claude-agent-sdk', () => import('./fake-sdk.js'))`.
 */
export type Tool = { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> };
export type Turn = (text: string, ctx: { tools: Tool[]; signal: AbortSignal; cwd: string; appCwd: string }) => AsyncGenerator<SDKMessage>;
export const sdk = { script: null as unknown as Turn, calls: [] as { cwd: string; resume?: string; prompts: string[]; contents: unknown[] }[] };

export const tool = (name: string, _d: string, _s: unknown, handler: Tool['handler']) => ({ name, handler });
export const createSdkMcpServer = (o: { tools: Tool[] }) => o;
export function query({
  prompt,
  options,
}: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: { cwd: string; resume?: string; abortController: AbortController; mcpServers: { blackbox: { tools: Tool[] } } };
}) {
  const call = { cwd: options.cwd, resume: options.resume, prompts: [] as string[], contents: [] as unknown[] };
  sdk.calls.push(call);
  const signal = options.abortController.signal;
  async function* gen() {
    for await (const m of prompt) {
      const content = m.message.content;
      const text = typeof content === 'string' ? content : ((content as { type: string; text?: string }[]).find((b) => b.type === 'text')?.text ?? '');
      call.prompts.push(text);
      call.contents.push(content);
      yield* sdk.script(text, { tools: options.mcpServers.blackbox.tools, signal, cwd: options.cwd, appCwd: options.cwd });
    }
  }
  return Object.assign(gen(), {
    interrupt: async () => {
      throw new Error('not supported by the fake'); // the runner then aborts the controller
    },
  });
}

export const init = (session: string) => ({ type: 'system', subtype: 'init', session_id: session }) as unknown as SDKMessage;
export const say = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } }) as unknown as SDKMessage;
export const result = (cost = 0.5) =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: cost,
    num_turns: 2,
    result: '',
    usage: { input_tokens: 1, output_tokens: 1 },
  }) as unknown as SDKMessage;

export const until = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
