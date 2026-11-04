import { useEffect, useRef, useState } from 'react';
import { LANGS, lang, setLang, t } from '../lib/i18n';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme';
import type { Application, User } from '../lib/api';
import { api, auth } from '../lib/api';
import { phaseLabel } from '../lib/labels';
import type { Route } from '../App';
import { Icon } from './Icon';
import { StatusDot } from './StatusDot';

const THEMES: { id: ThemePref; icon: string; label: string }[] = [
  { id: 'light', icon: 'sun', label: 'Light' },
  { id: 'dark', icon: 'moon', label: 'Dark' },
  { id: 'system', icon: 'monitor', label: 'System' },
];

/** Account menu (⋯) in the sidebar footer: theme, language, sign out. */
function UserMenu({ user, onSignOut }: { user: User; onSignOut: (everywhere: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pickTheme = (id: ThemePref) => {
    setThemePref(id);
    setTheme(id);
  };
  const other = LANGS.find((l) => l.id !== lang)!;

  return (
    <div className="user-menu" ref={ref}>
      <button
        className={`icon-btn ${open ? 'active' : ''}`}
        title={t('More')}
        aria-label={t('More')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <div className="menu-name">{user.name}</div>
            <div className="menu-email">{user.email}</div>
          </div>
          <div className="menu-sep" />
          <div className="menu-label">{t('Theme')}</div>
          <div className="menu-seg" role="radiogroup" aria-label={t('Theme')}>
            {THEMES.map((th) => (
              <button key={th.id} role="radio" aria-checked={theme === th.id} className={theme === th.id ? 'active' : ''} onClick={() => pickTheme(th.id)}>
                <Icon name={th.icon} size={14} /> {t(th.label)}
              </button>
            ))}
          </div>
          <button className="menu-item" role="menuitem" onClick={() => setLang(other.id)}>
            <Icon name="globe" size={16} /> {other.label}
          </button>
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" onClick={() => onSignOut(false)}>
            <Icon name="logout" size={16} /> {t('Sign out')}
          </button>
          <button className="menu-item danger" role="menuitem" onClick={() => onSignOut(true)}>
            <Icon name="logout" size={16} /> {t('Sign out everywhere')}
          </button>
        </div>
      )}
    </div>
  );
}

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
    if (everywhere && !confirm(t('Sign out on every device?'))) return;
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
        <span className="sidebar-user" title={`${user.name}\n${user.email}`}>
          {user.name}
          <span className="sidebar-email">{user.email}</span>
        </span>
        <UserMenu user={user} onSignOut={(everywhere) => void signOut(everywhere)} />
      </div>
    </aside>
  );
}
