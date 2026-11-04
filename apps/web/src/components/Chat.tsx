import { t } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, attachmentsOf, type Application, type Message } from '../lib/api';
import { Icon } from './Icon';

/** The latest message is a plan waiting for the user's approval. */
function pendingPlan(messages: Message[]) {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant' || !last.meta) return false;
  try {
    const meta = JSON.parse(last.meta) as { type?: string; needsApproval?: boolean };
    return meta.type === 'plan' && meta.needsApproval === true;
  } catch {
    return false;
  }
}

export function Chat({
  app,
  running,
  messages,
  liveStatus,
  onSend,
  onStop,
  readOnly = false,
}: {
  app: Application;
  running: boolean;
  messages: Message[];
  liveStatus?: string;
  onSend: (text: string, files: File[]) => Promise<unknown>;
  onStop: () => Promise<unknown>;
  /** Viewers of a shared application follow along but cannot steer the agent. */
  readOnly?: boolean;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const send = async (override?: string) => {
    const t = (override ?? text).trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(t, override ? [] : files);
      if (!override) {
        setText('');
        setFiles([]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const placeholder =
    app.status === 'provisioning'
      ? t('Setting things up — you can already add details…')
      : running
        ? t('Add a comment — the agent will take it into account as it works')
        : t('Share feedback or ask for the next change…');

  return (
    <div className="chat">
      <div className="chat-scroll">
        <div className="thread">
          {messages.map((m) =>
            m.role === 'system' ? (
              <div key={m.id} className="msg-system">
                {m.content}
              </div>
            ) : m.role === 'user' ? (
              <div key={m.id} className="msg-user">
                <div className="bubble">
                  {m.content}
                  {attachmentsOf(m).length > 0 && (
                    <div className="attachments">
                      {attachmentsOf(m).map((a) => (
                        <button
                          key={a.file}
                          className="attachment-chip"
                          onClick={() => void api.openAttachment(m.app_id, a.file).catch((e) => setError(e.message))}
                        >
                          {a.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div key={m.id} className="msg-agent">
                <span className="agent-avatar">
                  <span className="brand-mark small" />
                </span>
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

          {!readOnly && !running && pendingPlan(messages) && (
            <div className="plan-actions">
              <button className="btn btn-accent btn-sm" disabled={sending} onClick={() => void send(t('Approved — go ahead with this plan.'))}>
                <Icon name="check" size={14} /> {t('Approve the plan')}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setText(t('Please change the plan: '));
                  inputRef.current?.focus();
                }}
              >
                {t('Request changes')}
              </button>
            </div>
          )}

          {(running || app.status === 'provisioning' || app.status === 'queued') && (
            <div className="msg-agent">
              <span className="agent-avatar">
                <span className="brand-mark small pulse" />
              </span>
              <div className="msg-agent-body">
                <div className="msg-author">Blackbox</div>
                <div className="thinking">
                  <span className="typing">
                    <i />
                    <i />
                    <i />
                  </span>
                  {liveStatus ??
                    (app.status === 'provisioning'
                      ? t('Setting up your project…')
                      : app.status === 'queued'
                        ? t('All agents are busy — your request starts as soon as one is free…')
                        : t('Working on it…'))}
                </div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {readOnly ? (
        <p className="composer-foot">{t('You can follow this application. Ask its owner for chat access to steer the agent.')}</p>
      ) : (
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
            {files.length > 0 && (
              <div className="attachments">
                {files.map((f, i) => (
                  <button key={i} className="attachment-chip" title="Remove" onClick={() => setFiles((l) => l.filter((_, j) => j !== i))}>
                    {f.name} ×
                  </button>
                ))}
              </div>
            )}
            <div className="composer-bar">
              <span className="composer-tools">
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.csv,.json,.md,.yaml,.yml"
                  onChange={(e) => {
                    setFiles((l) => [...l, ...Array.from(e.target.files ?? [])].slice(0, 5));
                    e.target.value = '';
                  }}
                />
                <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()} title="Attach screenshots, mockups, specs or data samples">
                  <Icon name="plus" size={14} /> {t('Attach')}
                </button>
                {running && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void onStop()}>
                    <Icon name="stop" size={14} /> {t('Stop')}
                  </button>
                )}
              </span>
              <button className="send-btn" onClick={() => void send()} disabled={!text.trim() || sending} aria-label="Send">
                <Icon name="send" size={18} />
              </button>
            </div>
          </div>
          <p className="composer-foot">{t('Blackbox proposes every change for approval before it reaches the main version.')}</p>
        </div>
      )}
    </div>
  );
}
