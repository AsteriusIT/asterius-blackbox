import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

type Content = SDKUserMessage['message']['content'];

/** A push-based async iterable used as the agent's prompt stream, so the user can send feedback mid-run. */
export class PromptStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiter?: (r: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  /** Returns false once the stream is closed (the message was not delivered). */
  push(content: string | Content): boolean {
    if (this.closed) return false;
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: msg, done: false });
    } else this.queue.push(msg);
    return true;
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
