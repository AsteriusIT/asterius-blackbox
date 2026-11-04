import { useCallback, useEffect, useRef, useState } from 'react';
import { api, auth, type Application, type BlackboxEvent, type Platform, type User } from './lib/api';
import { useBlackboxEvents } from './lib/stream';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { NewApp } from './components/NewApp';
import { AppView } from './components/AppView';
import { Dashboard } from './components/Dashboard';
import { Toasts, type Toast } from './components/Toasts';

export type Route = { kind: 'dashboard' } | { kind: 'new' } | { kind: 'app'; id: string };

function parseRoute(): Route {
  const m = location.pathname.match(/^\/apps\/([\w-]+)/);
  if (m) return { kind: 'app', id: m[1] };
  if (location.pathname === '/new') return { kind: 'new' };
  return { kind: 'dashboard' };
}
const routePath = (r: Route) => (r.kind === 'app' ? `/apps/${r.id}` : r.kind === 'new' ? '/new' : '/');

/** Completes the Microsoft sign-in: the server redirects to /auth/callback#token=…&returnTo=… */
function consumeAuthCallback() {
  if (location.pathname !== '/auth/callback') return;
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  if (token) auth.set(token);
  const returnTo = params.get('returnTo') ?? '/';
  history.replaceState(null, '', returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    consumeAuthCallback();
    api
      .platform()
      .then(setPlatform)
      .catch(() => undefined);
    if (!auth.token) {
      setChecked(true);
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => auth.set(null))
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return null;
  if (!user) return <Login platform={platform} onLogin={(u) => setUser(u)} />;
  return <Shell user={user} platform={platform} />;
}

function Shell({ user, platform }: { user: User; platform: Platform | null }) {
  const [apps, setApps] = useState<Application[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [route, setRoute] = useState<Route>(parseRoute());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const refreshTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(
    () =>
      api.apps().then((a) => {
        setApps(a);
        setLoaded(true);
      }),
    [],
  );
  /** Coalesce bursts of events into one dashboard refresh. */
  const refreshSoon = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refresh(), 800);
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute());
    addEventListener('popstate', onPop);
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    return () => removeEventListener('popstate', onPop);
  }, []);

  const navigate = (r: Route) => {
    history.pushState(null, '', routePath(r));
    setRoute(r);
  };
  const openApp = (id: string) => navigate({ kind: 'app', id });
  const currentAppId = route.kind === 'app' ? route.id : null;

  useBlackboxEvents(
    (e: BlackboxEvent) => {
      if (e.type === 'app.updated' || e.type === 'run.started' || e.type === 'run.finished') {
        setApps((list) =>
          list.map((a) =>
            a.id === e.appId ? { ...a, ...e.payload, running: e.type === 'run.started' ? true : e.type === 'run.finished' ? false : a.running } : a,
          ),
        );
      }
      if (['env.updated', 'pr.updated', 'progress', 'run.finished'].includes(e.type)) refreshSoon();
      if (e.type === 'notification') {
        const appName = apps.find((a) => a.id === e.appId)?.name ?? '';
        const t: Toast = { id: `${e.seq}-${Date.now()}`, appId: e.appId, appName, ...e.payload };
        setToasts((ts) => [...ts.slice(-4), t]);
        // System notification when the tab is hidden or the user is looking at something else.
        if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || currentAppId !== e.appId)) {
          const n = new Notification(`${appName ? appName + ' · ' : ''}${e.payload.title}`, { body: e.payload.message, tag: `${e.appId}-${e.payload.title}` });
          n.onclick = () => {
            focus();
            openApp(e.appId);
          };
        }
      }
    },
    () => void refresh(),
  );

  const selected = apps.find((a) => a.id === currentAppId) ?? null;
  const showNew = route.kind === 'new' || (route.kind === 'dashboard' && loaded && apps.length === 0);

  return (
    <div className="shell">
      <Sidebar
        user={user}
        apps={apps}
        route={route}
        onSelect={openApp}
        onNew={() => navigate({ kind: 'new' })}
        onDashboard={() => navigate({ kind: 'dashboard' })}
      />
      <main className="main">
        {showNew ? (
          <NewApp
            platform={platform}
            onCreated={(a) => {
              setApps((l) => [a, ...l]);
              openApp(a.id);
            }}
          />
        ) : route.kind === 'app' ? (
          <AppView key={route.id} appId={route.id} platform={platform} summary={selected} />
        ) : (
          <Dashboard user={user} apps={apps} loaded={loaded} onOpen={openApp} onNew={() => navigate({ kind: 'new' })} />
        )}
      </main>
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} onOpen={openApp} />
    </div>
  );
}
