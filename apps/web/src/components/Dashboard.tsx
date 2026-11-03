import { useMemo, useState } from 'react';
import type { Application, User } from '../lib/api';
import { PHASES, phaseLabel } from '../lib/labels';
import { timeAgo } from '../lib/time';
import { Icon } from './Icon';
import { StatusBadge } from './StatusDot';

type Filter = 'all' | 'working' | 'attention' | 'live';

const needsAttention = (a: Application) => a.status === 'error' || (a.open_prs ?? 0) > 0 || (!a.running && a.status === 'idle' && a.phase === 'blocked');

export function Dashboard({ user, apps, loaded, onOpen, onNew }: { user: User; apps: Application[]; loaded: boolean; onOpen: (id: string) => void; onNew: () => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(
    () => ({
      all: apps.length,
      working: apps.filter((a) => a.running || a.status === 'running' || a.status === 'provisioning').length,
      attention: apps.filter(needsAttention).length,
      live: apps.filter((a) => a.live_env_url).length,
    }),
    [apps],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return apps
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
      .filter((a) =>
        filter === 'all'
          ? true
          : filter === 'working'
            ? a.running || a.status === 'running' || a.status === 'provisioning'
            : filter === 'attention'
              ? needsAttention(a)
              : !!a.live_env_url,
      );
  }, [apps, query, filter]);

  const firstName = user.name.split(/\s+/)[0];
  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'working', label: 'In progress' },
    { id: 'attention', label: 'Needs you' },
    { id: 'live', label: 'Live preview' },
  ];

  return (
    <div className="dashboard">
      <div className="dashboard-inner">
        <header className="dash-head">
          <div>
            <h1>Hello {firstName}</h1>
            <p className="lead">
              {counts.working > 0 ? `${counts.working} application${counts.working > 1 ? 's are' : ' is'} being built right now. ` : ''}
              {counts.attention > 0 ? `${counts.attention} need${counts.attention > 1 ? '' : 's'} your attention.` : counts.working === 0 ? 'Everything is up to date.' : ''}
            </p>
          </div>
          <button className="btn btn-dark" onClick={onNew}>
            <Icon name="plus" size={16} /> New application
          </button>
        </header>

        <div className="dash-tools">
          <div className="segmented inline">
            {FILTERS.map((f) => (
              <button key={f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
                {f.label}
                {counts[f.id] > 0 && <span className="count">{counts[f.id]}</span>}
              </button>
            ))}
          </div>
          <input className="search" placeholder="Search applications" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div className="grid">
          {visible.map((a) => (
            <AppCard key={a.id} app={a} onOpen={() => onOpen(a.id)} />
          ))}
          {filter === 'all' && !query && (
            <button className="card-new" onClick={onNew}>
              <span className="card-new-icon">
                <Icon name="plus" size={22} />
              </span>
              <span className="card-new-title">New application</span>
              <span className="card-new-text">Describe it in your own words</span>
            </button>
          )}
        </div>
        {loaded && visible.length === 0 && (query || filter !== 'all') && <p className="dash-empty">No application matches.</p>}
      </div>
    </div>
  );
}

function AppCard({ app, onOpen }: { app: Application; onOpen: () => void }) {
  const running = app.running || app.status === 'running';
  const status = running ? 'running' : app.status;
  const phaseIdx = PHASES.findIndex((p) => p.id === app.phase);
  const done = app.phase === 'done';
  const headline = running ? app.last_progress ?? `${phaseLabel(app.phase) || 'Working'}…` : app.status === 'error' ? app.last_error : app.last_progress;

  return (
    <article className="app-card" onClick={onOpen} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="app-card-head">
        <span className="app-card-avatar">{app.name.slice(0, 1).toUpperCase()}</span>
        <StatusBadge status={status} />
      </div>
      <h3 className="app-card-title">{app.name}</h3>
      <p className="app-card-desc">{app.description || 'No description'}</p>

      <div className="app-card-progress" aria-label={`Step: ${phaseLabel(app.phase) || 'not started'}`}>
        <div className="segments">
          {PHASES.map((p, i) => (
            <span key={p.id} className={done || i < phaseIdx ? 'seg done' : i === phaseIdx ? (running ? 'seg current' : 'seg done') : 'seg'} />
          ))}
        </div>
        {headline && <p className={`app-card-headline ${app.status === 'error' && !running ? 'error' : ''}`}>{headline}</p>}
      </div>

      <div className="app-card-foot">
        <span className="app-card-meta">Updated {timeAgo(app.last_activity_at ?? app.updated_at)}</span>
        <div className="app-card-badges">
          {(app.open_prs ?? 0) > 0 && (
            <span className="pill pill-pr-active" title="Changes waiting for approval">
              {app.open_prs} to approve
            </span>
          )}
          {app.live_env_url && (
            <a className="btn btn-accent btn-sm" href={app.live_env_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              <Icon name="rocket" size={14} /> Try it
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
