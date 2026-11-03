import { useEffect, useRef } from 'react';
import { auth, type BlackboxEvent } from './api';

type Listener = (e: BlackboxEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
const reconnectListeners = new Set<() => void>();

function ensureSource() {
  if (source || !auth.token) return;
  source = new EventSource(`/api/stream?token=${encodeURIComponent(auth.token)}`);
  let opened = false;
  source.onopen = () => {
    // After a reconnect, consumers re-sync whatever they might have missed.
    if (opened) reconnectListeners.forEach((fn) => fn());
    opened = true;
  };
  source.onmessage = (m) => {
    const evt = JSON.parse(m.data) as BlackboxEvent;
    listeners.forEach((fn) => fn(evt));
  };
}

/** Subscribe to the user's live event stream (one shared EventSource). */
export function useBlackboxEvents(fn: Listener, onReconnect?: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  const reRef = useRef(onReconnect);
  reRef.current = onReconnect;
  useEffect(() => {
    ensureSource();
    const l: Listener = (e) => ref.current(e);
    const r = () => reRef.current?.();
    listeners.add(l);
    reconnectListeners.add(r);
    return () => {
      listeners.delete(l);
      reconnectListeners.delete(r);
    };
  }, []);
}
