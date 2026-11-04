import { useEffect, useRef } from 'react';
import { api, auth, type BlackboxEvent } from './api';

type Listener = (e: BlackboxEvent) => void;
const listeners = new Set<Listener>();
const reconnectListeners = new Set<() => void>();
let source: EventSource | null = null;
let connecting = false;
let connectedOnce = false;
let retry = 0;

/**
 * One shared EventSource per tab. It authenticates with a single-use ticket (never the session token in the URL),
 * so the browser's built-in auto-reconnect cannot be used: on error we close and reconnect with a fresh ticket.
 */
async function connect() {
  if (source || connecting || !auth.token) return;
  connecting = true;
  try {
    const { ticket } = await api.streamTicket();
    const es = new EventSource(`/api/stream?ticket=${encodeURIComponent(ticket)}`);
    source = es;
    es.onopen = () => {
      retry = 0;
      // After a reconnect, consumers re-sync whatever they might have missed.
      if (connectedOnce) reconnectListeners.forEach((fn) => fn());
      connectedOnce = true;
    };
    es.onmessage = (m) => {
      const evt = JSON.parse(m.data) as BlackboxEvent;
      listeners.forEach((fn) => fn(evt));
    };
    es.onerror = () => {
      es.close();
      if (source === es) source = null;
      scheduleReconnect();
    };
  } catch {
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function scheduleReconnect() {
  if (!listeners.size) return;
  const delay = Math.min(30_000, 1000 * 2 ** retry++);
  setTimeout(() => void connect(), delay);
}

/** Test helper: forget the shared connection. */
export function resetStream() {
  source?.close();
  source = null;
  connecting = false;
  connectedOnce = false;
  retry = 0;
  listeners.clear();
  reconnectListeners.clear();
}

/** Subscribe to the user's live event stream (one shared EventSource). */
export function useBlackboxEvents(fn: Listener, onReconnect?: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  const reRef = useRef(onReconnect);
  reRef.current = onReconnect;
  useEffect(() => {
    const l: Listener = (e) => ref.current(e);
    const r = () => reRef.current?.();
    listeners.add(l);
    reconnectListeners.add(r);
    void connect();
    return () => {
      listeners.delete(l);
      reconnectListeners.delete(r);
    };
  }, []);
}
