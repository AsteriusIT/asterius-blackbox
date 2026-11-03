import { Icon } from './Icon';

export interface Toast {
  id: string;
  appId: string;
  appName: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  link?: string;
}

const ICONS = { info: 'bell', success: 'check', warning: 'alert', error: 'alert' } as const;

export function Toasts({ toasts, onDismiss, onOpen }: { toasts: Toast[]; onDismiss: (id: string) => void; onOpen: (appId: string) => void }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`} role="status">
          <span className="toast-icon">
            <Icon name={ICONS[t.level]} size={16} />
          </span>
          <div className="toast-content">
            {t.appName && <div className="toast-app">{t.appName}</div>}
            <div className="toast-title">{t.title}</div>
            {t.message && <div className="toast-msg">{t.message}</div>}
            <div className="toast-actions">
              {t.link && (
                <a href={t.link} target="_blank" rel="noreferrer" className="btn btn-dark btn-sm">
                  Open <Icon name="external" size={14} />
                </a>
              )}
              <button className="btn btn-soft btn-sm" onClick={() => { onOpen(t.appId); onDismiss(t.id); }}>
                View
              </button>
            </div>
          </div>
          <button className="icon-btn toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
