import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Application, type BlackboxEvent, type Environment, type Message, type Platform, type PullRequest } from '../lib/api';
import { useBlackboxEvents } from '../lib/stream';
import { PHASES } from '../lib/labels';
import { StatusBadge } from './StatusDot';
import { Chat } from './Chat';
import { Timeline } from './Timeline';
import { Environments } from './Environments';
import { PullRequests } from './PullRequests';
import { Icon } from './Icon';

type Tab = 'progress' | 'previews' | 'changes';

export function AppView({ appId, platform, summary }: { appId: string; platform: Platform | null; summary: Application | null }) {
  const [app, setApp] = useState<Application | null>(summary);
  const [messages, setMessages] = useState<Message[]>([]);
  const [events, setEvents] = useState<BlackboxEvent[]>([]);
  const [envs, setEnvs] = useState<Record<string, Environment>>({});
  const [prs, setPrs] = useState<Record<number, PullRequest>>({});
  const [tab, setTab] = useState<Tab>('progress');
  const [panelOpen, setPanelOpen] = useState(true);
  const lastSeq = useRef(0);

  const load = useCallback(async () => {
    const [detail, msgs, evts] = await Promise.all([api.app(appId), api.messages(appId), api.events(appId)]);
    setApp(detail.app);
    setEnvs(Object.fromEntries(detail.environments.map((e) => [e.id, e])));
    setPrs(Object.fromEntries(detail.pullRequests.map((p) => [p.id, p])));
    setMessages(msgs);
    setEvents(evts);
    lastSeq.current = evts.at(-1)?.seq ?? 0;
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  useBlackboxEvents(
    (e) => {
      if (e.appId !== appId) return;
      if (e.seq) {
        if (e.seq <= lastSeq.current) return;
        lastSeq.current = e.seq;
      }
      switch (e.type) {
        case 'message.created':
          setMessages((m) => (m.some((x) => x.id === e.payload.message.id) ? m : [...m, e.payload.message]));
          break;
        case 'app.updated':
          setApp((a) => (a ? { ...a, ...e.payload } : a));
          break;
        case 'run.started':
          setApp((a) => (a ? { ...a, running: true, status: 'running' } : a));
          break;
        case 'run.finished':
          setApp((a) => (a ? { ...a, running: false } : a));
          break;
        case 'env.updated': {
          const env = e.payload.env as Environment;
          setEnvs((m) => ({ ...m, [env.id]: env }));
          if (env.status === 'building' || env.status === 'ready') {
            setTab('previews');
            setPanelOpen(true);
          }
          break;
        }
        case 'pr.updated':
          setPrs((m) => ({ ...m, [e.payload.id]: { ...m[e.payload.id], ...e.payload } }));
          break;
      }
      if (['progress', 'activity', 'run.started', 'run.finished', 'notification'].includes(e.type) && e.seq) setEvents((l) => [...l, e]);
    },
    () => void load(),
  );

  const liveEnvs = useMemo(() => Object.values(envs).filter((e) => e.status !== 'deleted').sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [envs]);
  const prList = useMemo(() => Object.values(prs).sort((a, b) => b.id - a.id), [prs]);
  const lastProgress = useMemo(() => [...events].reverse().find((e) => e.type === 'progress'), [events]);
  const readyEnv = liveEnvs.find((e) => e.status === 'ready' && e.url);

  if (!app) return <div className="empty">Loading…</div>;
  const running = app.running || app.status === 'running';
  const status = running ? 'running' : app.status;
  const phaseIdx = PHASES.findIndex((p) => p.id === app.phase);

  return (
    <div className={`app-view ${panelOpen ? 'with-panel' : ''}`}>
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-title">
            <h2>{app.name}</h2>
            <StatusBadge status={status} />
          </div>
          <div className="topbar-actions">
            {readyEnv && (
              <a className="btn btn-accent btn-sm" href={readyEnv.url!} target="_blank" rel="noreferrer">
                <Icon name="rocket" size={15} /> Try it
              </a>
            )}
            {app.repo_web_url && (
              <a className="btn btn-ghost btn-sm" href={app.repo_web_url} target="_blank" rel="noreferrer" title="Open the code repository">
                <Icon name="branch" size={15} /> Code
              </a>
            )}
            <button className="icon-btn" onClick={() => setPanelOpen((o) => !o)} title="Toggle details panel">
              <Icon name="panel" />
            </button>
          </div>
        </header>

        {app.phase && (
          <ol className="stepper" aria-label="Progress">
            {PHASES.map((p, i) => {
              const state = app.phase === 'done' || i < phaseIdx ? 'done' : i === phaseIdx ? (running ? 'current' : 'done') : 'todo';
              return (
                <li key={p.id} className={state}>
                  <span className="step-dot">{state === 'done' ? <Icon name="check" size={11} /> : null}</span>
                  {p.label}
                </li>
              );
            })}
          </ol>
        )}

        {app.status === 'error' && app.last_error && (
          <div className="notice notice-error">
            <Icon name="alert" size={16} />
            <span>{app.last_error}</span>
            {!app.repo_web_url && (
              <button className="btn btn-soft btn-sm" onClick={() => api.retryProvisioning(app.id).then(load)}>
                Try again
              </button>
            )}
          </div>
        )}

        <Chat
          app={app}
          running={running}
          messages={messages}
          liveStatus={running ? (lastProgress?.payload.title as string | undefined) : undefined}
          onSend={(text) => api.send(app.id, text)}
          onStop={() => api.stop(app.id)}
        />
      </div>

      {panelOpen && (
        <aside className="panel">
          <div className="segmented" role="tablist">
            <button role="tab" className={tab === 'progress' ? 'active' : ''} onClick={() => setTab('progress')}>
              Progress
            </button>
            <button role="tab" className={tab === 'previews' ? 'active' : ''} onClick={() => setTab('previews')}>
              Previews{liveEnvs.length > 0 && <span className="count">{liveEnvs.length}</span>}
            </button>
            <button role="tab" className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>
              Changes{prList.length > 0 && <span className="count">{prList.length}</span>}
            </button>
          </div>
          <div className="panel-body">
            {tab === 'progress' && <Timeline events={events} running={running} />}
            {tab === 'previews' && <Environments envs={liveEnvs} k8sEnabled={platform?.k8sEnabled ?? false} onDelete={(id) => api.deleteEnv(app.id, id)} />}
            {tab === 'changes' && <PullRequests prs={prList} />}
          </div>
        </aside>
      )}
    </div>
  );
}
