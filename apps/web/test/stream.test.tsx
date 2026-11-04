import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { resetStream, useBlackboxEvents } from '../src/lib/stream';
import { auth } from '../src/lib/api';

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onerror?: () => void;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
}

let tickets = 0;
beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.all = [];
  tickets = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ticket: `t${++tickets}` }), { status: 200 })),
  );
  auth.set('session-token');
});
afterEach(() => {
  resetStream();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Probe({ onEvent, onReconnect }: { onEvent: (e: unknown) => void; onReconnect: () => void }) {
  useBlackboxEvents(onEvent, onReconnect);
  return null;
}
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

describe('live stream', () => {
  it('connects with a single-use ticket, never the session token', async () => {
    render(<Probe onEvent={() => undefined} onReconnect={() => undefined} />);
    await flush();
    expect(FakeEventSource.all).toHaveLength(1);
    expect(FakeEventSource.all[0]!.url).toBe('/api/stream?ticket=t1');
    expect(FakeEventSource.all[0]!.url).not.toContain('session-token');
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer session-token' });
  });

  it('shares one connection and fans out events', async () => {
    const a = vi.fn();
    const b = vi.fn();
    render(
      <>
        <Probe onEvent={a} onReconnect={() => undefined} />
        <Probe onEvent={b} onReconnect={() => undefined} />
      </>,
    );
    await flush();
    expect(FakeEventSource.all).toHaveLength(1);
    act(() => FakeEventSource.all[0]!.onmessage!({ data: JSON.stringify({ seq: 1, type: 'progress' }) }));
    expect(a).toHaveBeenCalledWith({ seq: 1, type: 'progress' });
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('reconnects with a fresh ticket after an error and asks consumers to re-sync', async () => {
    const onReconnect = vi.fn();
    render(<Probe onEvent={() => undefined} onReconnect={onReconnect} />);
    await flush();
    const first = FakeEventSource.all[0]!;
    act(() => first.onopen!());
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => first.onerror!());
    expect(first.closed).toBe(true);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    const second = FakeEventSource.all[1]!;
    expect(second.url).toBe('/api/stream?ticket=t2');
    act(() => second.onopen!());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially while the server is down', async () => {
    render(<Probe onEvent={() => undefined} onReconnect={() => undefined} />);
    await flush();
    act(() => FakeEventSource.all[0]!.onerror!());
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    act(() => FakeEventSource.all[1]!.onerror!());
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(FakeEventSource.all).toHaveLength(2); // second retry waits 2s
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(FakeEventSource.all).toHaveLength(3);
  });
});
