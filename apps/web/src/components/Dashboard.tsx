import { t } from '../lib/i18n';
import { useEffect, useMemo, useState } from 'react';
import { api, type Application, type CostReport, type User } from '../lib/api';
import { PHASES, phaseLabel } from '../lib/labels';
import { timeAgo } from '../lib/time';
import { Icon } from './Icon';
import { StatusBadge } from './StatusDot';

type Filter = 'all' | 'working' | 'attention' | 'live' | 'archived';

const needsAttention = (a: Application) => a.status === 'error' || (a.open_prs ?? 0) > 0 || (!a.running && a.status === 'idle' && a.phase === 'blocked');

export function Dashboard({
  user,
  apps,
  loaded,
  onOpen,
  onNew,
}: {
  user: User;
  apps: Application[];
  loaded: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [costs, setCosts] = useState<CostReport | null>(null);
  useEffect(
    () =>
      void api
        .costs()
        .then(setCosts)
        .catch(() => undefined),
    [apps.length],
  );
  const costOf = useMemo(() => new Map(costs?.apps.map((c) => [c.id, c.monthUsd]) ?? []), [costs]);

  const counts = useMemo(
    () => ({
      all: apps.filter((a) => a.status !== 'archived').length,
      archived: apps.filter((a) => a.status === 'archived').length,
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
        filter === 'archived'
          ? a.status === 'archived'
          : a.status === 'archived'
            ? false
            : filter === 'all'
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
    { id: 'all', label: t('All') },
    { id: 'working', label: t('In progress') },
    { id: 'attention', label: t('Needs you') },
    { id: 'live', label: t('Live preview') },
    { id: 'archived', label: t('Archived') },
  ];

  return (
    <div className="dashboard">
      <div className="dashboard-inner">
        <header className="dash-head">
          <div>
            <h1>{t('Hello {name}', { name: firstName })}</h1>
            <p className="lead">
              {counts.working > 0 ? `${counts.working} application${counts.working > 1 ? 's are' : ' is'} being built right now. ` : ''}
              {counts.attention > 0
                ? `${counts.attention} need${counts.attention > 1 ? '' : 's'} your attention.`
                : counts.working === 0
                  ? t('Everything is up to date.')
                  : ''}
            </p>
          </div>
          <button className="btn btn-dark" onClick={onNew}>
            <Icon name="plus" size={16} /> {t('New application')}
          </button>
        </header>

        {costs && <CostSummary costs={costs} />}

        <div className="dash-tools">
          <div className="segmented inline">
            {FILTERS.map((f) => (
              <button key={f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
                {f.label}
                {counts[f.id] > 0 && <span className="count">{counts[f.id]}</span>}
              </button>
            ))}
          </div>
          <input className="search" placeholder={t('Search applications')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div className="grid">
          {visible.map((a) => (
            <AppCard key={a.id} app={a} monthUsd={costOf.get(a.id)} onOpen={() => onOpen(a.id)} />
          ))}
          {filter === 'all' && !query && (
            <button className="card-new" onClick={onNew}>
              <span className="card-new-icon">
                <Icon name="plus" size={22} />
              </span>
              <span className="card-new-title">{t('New application')}</span>
              <span className="card-new-text">{t('Describe it in your own words')}</span>
            </button>
          )}
        </div>
        {loaded && visible.length === 0 && (query || filter !== 'all') && <p className="dash-empty">{t('No application matches.')}</p>}
      </div>
    </div>
  );
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** This month's spend against the budgets; admins also see the platform total and the top spenders. */
function CostSummary({ costs }: { costs: CostReport }) {
  const line = (spent: number, budget: number) => (budget ? `${usd(spent)} of ${usd(budget)}` : usd(spent));
  return (
    <section className="cost-summary" aria-label="Costs this month">
      <span>
        <strong>{t('This month')}</strong> · your applications {line(costs.me.spentUsd, costs.me.budgetUsd)}
        {costs.me.budgetUsd > 0 && costs.me.spentUsd >= costs.me.budgetUsd && <span className="error-text"> · budget reached, new requests are paused</span>}
      </span>
      {costs.global && (
        <span>
          Platform {line(costs.global.spentUsd, costs.global.budgetUsd)} · top:{' '}
          {costs.users
            ?.filter((u) => u.monthUsd > 0)
            .slice(0, 3)
            .map((u) => `${u.email} ${usd(u.monthUsd)}`)
            .join(', ') || 'none'}
        </span>
      )}
    </section>
  );
}

function AppCard({ app, monthUsd, onOpen }: { app: Application; monthUsd?: number; onOpen: () => void }) {
  const running = app.running || app.status === 'running';
  const status = running ? 'running' : app.status;
  const phaseIdx = PHASES.findIndex((p) => p.id === app.phase);
  const done = app.phase === 'done';
  const headline = running ? (app.last_progress ?? `${phaseLabel(app.phase) || 'Working'}…`) : app.status === 'error' ? app.last_error : app.last_progress;

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
        <span className="app-card-meta">
          Updated {timeAgo(app.last_activity_at ?? app.updated_at)}
          {monthUsd ? ` · ${usd(monthUsd)} this month` : ''}
        </span>
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
