import { LANGS, lang, setLang, t } from '../lib/i18n';
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
  const signOut = async (everywhere = false) => {
    if (everywhere && !confirm('Sign out on every device?')) return;
    await (everywhere ? api.logoutAll() : api.logout()).catch(() => undefined);
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
          <Icon name="grid" size={16} /> {t('Dashboard')}
        </button>
        <button className={`nav-item ${route.kind === 'new' ? 'active' : ''}`} onClick={onNew}>
          <Icon name="plus" size={16} /> {t('New application')}
        </button>
      </nav>
      <div className="nav-section">{t('Applications')}</div>
      <nav className="app-list">
        {apps.map((a) => (
          <button key={a.id} className={`app-item ${route.kind === 'app' && a.id === route.id ? 'active' : ''}`} onClick={() => onSelect(a.id)}>
            <span className="app-item-name">{a.name}</span>
            {a.running ? <span className="app-item-phase">{phaseLabel(a.phase) || t('Working')}</span> : <StatusDot status={a.status} />}
          </button>
        ))}
        {apps.length === 0 && <p className="nav-empty">{t('Your applications will appear here.')}</p>}
      </nav>
      <div className="sidebar-foot">
        <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
        <span className="sidebar-user">
          {user.name}
          <span className="sidebar-email">{user.email}</span>
        </span>
        <button className="icon-btn lang-btn" title={LANGS.find((l) => l.id !== lang)!.label} onClick={() => setLang(lang === 'fr' ? 'en' : 'fr')}>
          {lang === 'fr' ? 'EN' : 'FR'}
        </button>
        <button className="icon-btn" title={t('Sign out (Shift+click: sign out everywhere)')} onClick={(e) => void signOut(e.shiftKey)}>
          <Icon name="logout" size={16} />
        </button>
      </div>
    </aside>
  );
}
