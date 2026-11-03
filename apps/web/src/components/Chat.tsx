import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Application, Message } from '../lib/api';
import { Icon } from './Icon';

export function Chat({
  app,
  running,
  messages,
  liveStatus,
  onSend,
  onStop,
}: {
  app: Application;
  running: boolean;
  messages: Message[];
  liveStatus?: string;
  onSend: (text: string) => Promise<unknown>;
  onStop: () => Promise<unknown>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, running, liveStatus]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(t);
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const placeholder =
    app.status === 'provisioning'
      ? 'Setting things up — you can already add details…'
      : running
        ? 'Add a comment — the agent will take it into account as it works'
        : 'Share feedback or ask for the next change…';

  return (
    <div className="chat">
      <div className="chat-scroll">
        <div className="thread">
          {messages.map((m) =>
            m.role === 'system' ? (
              <div key={m.id} className="msg-system">{m.content}</div>
            ) : m.role === 'user' ? (
              <div key={m.id} className="msg-user">
                <div className="bubble">{m.content}</div>
              </div>
            ) : (
              <div key={m.id} className="msg-agent">
                <span className="agent-avatar"><span className="brand-mark small" /></span>
                <div className="msg-agent-body">
                  <div className="msg-author">Blackbox</div>
                  <div className="markdown">
                    <Markdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>
                      {m.content}
                    </Markdown>
                  </div>
                </div>
              </div>
            ),
          )}

          {(running || app.status === 'provisioning') && (
            <div className="msg-agent">
              <span className="agent-avatar"><span className="brand-mark small pulse" /></span>
              <div className="msg-agent-body">
                <div className="msg-author">Blackbox</div>
                <div className="thinking">
                  <span className="typing"><i /><i /><i /></span>
                  {liveStatus ?? (app.status === 'provisioning' ? 'Setting up your project…' : 'Working on it…')}
                </div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <div className="composer-wrap">
        {error && <div className="error-text center">{error}</div>}
        <div className="composer">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            rows={1}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-bar">
            {running ? (
              <button className="btn btn-ghost btn-sm" onClick={() => void onStop()}>
                <Icon name="stop" size={14} /> Stop
              </button>
            ) : (
              <span />
            )}
            <button className="send-btn" onClick={() => void send()} disabled={!text.trim() || sending} aria-label="Send">
              <Icon name="send" size={18} />
            </button>
          </div>
        </div>
        <p className="composer-foot">Blackbox proposes every change for approval before it reaches the main version.</p>
      </div>
    </div>
  );
}
