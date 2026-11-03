import { useMemo, useState } from 'react';
import type { BlackboxEvent } from '../lib/api';
import { phaseLabel } from '../lib/labels';
import { Icon } from './Icon';

/** Activity kinds shown to everyone; the rest is behind "Technical details". */
const FRIENDLY = new Set(['repo', 'plan-shared', 'delegate', 'deploy', 'ci', 'feedback']);

const TECH_LABEL: Record<string, string> = {
  git: 'Git',
  edit: 'File',
  read: 'Read',
  shell: 'Command',
  test: 'Tests',
  web: 'Web',
  error: 'Issue',
  narration: 'Note',
  tool: 'Tool',
  delegate: 'Task',
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function Timeline({ events, running }: { events: BlackboxEvent[]; running: boolean }) {
  const [technical, setTechnical] = useState(false);

  const checklist = useMemo(
    () => [...events].reverse().find((e) => e.type === 'activity' && e.payload.kind === 'plan' && e.payload.actor !== 'coder'),
    [events],
  );

  const items = useMemo(
    () =>
      events
        .filter((e) => !(e.type === 'activity' && e.payload.kind === 'plan'))
        .filter((e) => technical || e.type !== 'activity' || FRIENDLY.has(e.payload.kind))
        .slice()
        .reverse(),
    [events, technical],
  );

  return (
    <div className="timeline">
      {checklist && running && (
        <section className="checklist">
          <h4>Checklist</h4>
          <ul>
            {(checklist.payload.todos as { content: string; status: string }[]).map((t, i) => (
              <li key={i} className={`todo todo-${t.status}`}>
                <span className="todo-mark">{t.status === 'completed' ? <Icon name="check" size={12} /> : null}</span>
                {t.content}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="timeline-head">
        <h4>Latest updates</h4>
        <label className="switch">
          <input type="checkbox" checked={technical} onChange={(e) => setTechnical(e.target.checked)} />
          <span className="switch-track" />
          Technical details
        </label>
      </div>

      <ol className="feed">
        {items.map((e) => (
          <FeedItem key={e.seq} e={e} />
        ))}
        {items.length === 0 && <li className="feed-empty">Updates will appear here as the agent works.</li>}
      </ol>
    </div>
  );
}

function FeedItem({ e }: { e: BlackboxEvent }) {
  const p = e.payload;
  if (e.type === 'progress')
    return (
      <li className="feed-item milestone">
        <span className="feed-dot accent" />
        <div>
          <div className="feed-meta">
            {phaseLabel(p.phase)} · {time(e.createdAt)}
          </div>
          <div className="feed-title">{p.title}</div>
          {p.detail && <div className="feed-text">{p.detail}</div>}
        </div>
      </li>
    );

  if (e.type === 'run.started' || e.type === 'run.finished')
    return (
      <li className="feed-item quiet">
        <span className="feed-dot" />
        <div className="feed-meta">
          {e.type === 'run.started' ? 'Started working' : p.status === 'succeeded' ? 'Finished' : p.status === 'stopped' ? 'Stopped' : 'Stopped after a problem'} · {time(e.createdAt)}
          {e.type === 'run.finished' && p.costUsd != null && ` · $${Number(p.costUsd).toFixed(2)}`}
        </div>
      </li>
    );

  if (e.type === 'notification')
    return (
      <li className={`feed-item notif notif-${p.level}`}>
        <span className="feed-dot" />
        <div>
          <div className="feed-meta">{time(e.createdAt)}</div>
          <div className="feed-title">{p.title}</div>
          {p.link && (
            <a className="feed-link" href={p.link} target="_blank" rel="noreferrer">
              Open <Icon name="external" size={13} />
            </a>
          )}
        </div>
      </li>
    );

  // activity
  const friendly = FRIENDLY.has(p.kind);
  const title = String(p.title ?? '').split('\n')[0];
  return (
    <li className={`feed-item ${friendly ? '' : 'tech'} kind-${p.kind}`}>
      <span className="feed-dot" />
      <div className="feed-body">
        <div className="feed-meta">
          {friendly ? (
            time(e.createdAt)
          ) : (
            <>
              {TECH_LABEL[p.kind] ?? p.kind}
              {p.actor && ` · ${p.actor === 'coder' ? 'Developer' : 'Lead'}`} · {time(e.createdAt)}
            </>
          )}
        </div>
        {p.detail ? (
          <details>
            <summary className={friendly ? 'feed-title' : 'feed-text'}>{title}</summary>
            <pre>{p.detail}</pre>
          </details>
        ) : (
          <div className={friendly ? 'feed-title' : p.kind === 'narration' ? 'feed-text italic' : 'feed-text'}>
            {p.kind === 'narration' ? p.title : title}
            {p.link && (
              <a className="feed-link" href={p.link} target="_blank" rel="noreferrer">
                {' '}
                <Icon name="external" size={13} />
              </a>
            )}
          </div>
        )}
        {p.kind === 'plan-shared' && Array.isArray(p.steps) && <div className="feed-text">{p.steps.length} steps — see the chat</div>}
      </div>
    </li>
  );
}
