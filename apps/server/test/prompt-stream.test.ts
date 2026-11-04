import { describe, expect, it } from 'vitest';
import { PromptStream } from '../src/agent/prompt-stream.js';

describe('PromptStream', () => {
  it('yields queued messages then waits for new ones', async () => {
    const s = new PromptStream();
    s.push('a');
    expect(s.pending).toBe(1);
    const it = s[Symbol.asyncIterator]();
    expect((await it.next()).value?.message.content).toBe('a');
    const next = it.next();
    s.push('b');
    expect((await next).value?.message.content).toBe('b');
    s.close();
    expect((await it.next()).done).toBe(true);
    expect(s.push('late')).toBe(false);
  });
  it('close() releases a pending reader', async () => {
    const s = new PromptStream();
    const p = s[Symbol.asyncIterator]().next();
    s.close();
    expect((await p).done).toBe(true);
  });
});
