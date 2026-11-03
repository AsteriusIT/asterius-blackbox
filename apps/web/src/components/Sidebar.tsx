import type { Application, User } from '../lib/api';
import { api, auth } from '../lib/api';
import { phaseLabel } from '../lib/labels';
import type { Route } from '../App';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';

export function Sidebar({
  user,
  apps,
  route,
  onSelect,
  onNew,
  onDashboard,
}: {
  user: User;
  apps: Application[];
  route: Route;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDashboard: () => void;
}) {
  const signOut = async () => {
    await api.logout().catch(() => undefined);
    auth.set(null);
    location.href = '/login';
  };
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" />
        Blackbox
      </div>
      <nav className="nav-main">
        <button className={`nav-item ${route.kind === 'dashboard' ? 'active' : ''}`} onClick={onDashboard}>
          <Icon name="grid" size={16} /> Dashboard
        </button>
        <button className={`nav-item ${route.kind === 'new' ? 'active' : ''}`} onClick={onNew}>
          <Icon name="plus" size={16} /> New application
        </button>
      </nav>
      <div className="nav-section">Applications</div>
      <nav className="app-list">
        {apps.map((a) => (
          <button key={a.id} className={`app-item ${route.kind === 'app' && a.id === route.id ? 'active' : ''}`} onClick={() => onSelect(a.id)}>
            <span className="app-item-name">{a.name}</span>
            {a.running ? <span className="app-item-phase">{phaseLabel(a.phase) || 'Working'}</span> : <StatusDot status={a.status} />}
          </button>
        ))}
        {apps.length === 0 && <p className="nav-empty">Your applications will appear here.</p>}
      </nav>
      <div className="sidebar-foot">
        <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
        <span className="sidebar-user">
          {user.name}
          <span className="sidebar-email">{user.email}</span>
        </span>
        <button className="icon-btn" title="Sign out" onClick={() => void signOut()}>
          <Icon name="logout" size={16} />
        </button>
      </div>
    </aside>
  );
}
