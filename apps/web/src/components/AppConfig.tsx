import { useCallback, useEffect, useState } from 'react';
import { api, type ConfigEntry } from '../lib/api';
import { Icon } from './Icon';

/** Environment variables and secrets injected into the application's previews (values encrypted, never shown to the agent). */
export function AppConfig({ appId }: { appId: string }) {
  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [form, setForm] = useState({ key: '', value: '', secret: true, env: '*' });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.config(appId).then(setEntries), [appId]);
  useEffect(() => void load().catch(() => undefined), [load]);

  const save = async () => {
    setError(null);
    try {
      await api.setConfig(appId, { ...form, key: form.key.trim().toUpperCase() });
      setForm({ key: '', value: '', secret: true, env: '*' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="tile">
      <div className="tile-title">Configuration & secrets</div>
      <div className="tile-sub">
        Injected as environment variables into the previews. Secret values are encrypted and never shown again — not even to the agent.
      </div>
      {entries.map((e) => (
        <div key={`${e.env}/${e.key}`} className="config-row">
          <code>{e.key}</code>
          <span className="tile-sub">
            {e.secret ? '••••••' : e.value}
            {e.env !== '*' && ` · only in ${e.env}`}
          </span>
          <button className="icon-btn" title="Remove" onClick={() => void api.deleteConfig(appId, e.key, e.env).then(load)}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      <div className="config-form">
        <input className="search" placeholder="NAME" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
        <input
          className="search"
          placeholder="value"
          type={form.secret ? 'password' : 'text'}
          autoComplete="off"
          value={form.value}
          onChange={(e) => setForm({ ...form, value: e.target.value })}
        />
        <input
          className="search"
          placeholder="all environments"
          value={form.env === '*' ? '' : form.env}
          onChange={(e) => setForm({ ...form, env: e.target.value.trim() || '*' })}
        />
        <label className="switch">
          <input type="checkbox" checked={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.checked })} />
          <span className="switch-track" />
          Secret
        </label>
        <button className="btn btn-soft btn-sm" disabled={!form.key.trim()} onClick={() => void save()}>
          Save
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
