import { useCallback, useEffect, useState } from 'react';
import { api, type Members as MembersData } from '../lib/api';
import { Icon } from './Icon';

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', editor: 'Can chat', viewer: 'Can view' };

/** Who can see / steer this application. The owner adds people by email (or an Entra group id). */
export function Members({ appId, canManage }: { appId: string; canManage: boolean }) {
  const [data, setData] = useState<MembersData | null>(null);
  const [who, setWho] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('editor');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.members(appId).then(setData), [appId]);
  useEffect(() => void load(), [load]);

  const add = async () => {
    const v = who.trim();
    if (!v) return;
    setError(null);
    try {
      await api.addMember(appId, v.includes('@') ? { email: v, role } : { groupId: v, role });
      setWho('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!data) return null;
  return (
    <div className="stack">
      {data.owner && (
        <div className="tile">
          <div className="tile-title">{data.owner.name}</div>
          <div className="tile-sub">
            {data.owner.email} · {ROLE_LABEL.owner}
          </div>
        </div>
      )}
      {data.members.map((m) => (
        <div key={m.subject} className="tile">
          <div className="tile-head">
            <div className="tile-title">{m.name ?? m.email ?? m.subject}</div>
            {canManage && (
              <button className="icon-btn" title="Remove access" onClick={() => api.removeMember(appId, m.subject).then(load)}>
                <Icon name="stop" size={14} />
              </button>
            )}
          </div>
          <div className="tile-sub">
            {m.email ? `${m.email} · ` : ''}
            {ROLE_LABEL[m.role] ?? m.role}
          </div>
        </div>
      ))}
      {canManage && (
        <div className="tile">
          <input
            className="search"
            placeholder="Email, or Entra group id"
            value={who}
            onChange={(e) => setWho(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <div className="tile-head">
            <select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')} aria-label="Access">
              <option value="editor">Can chat with the agent</option>
              <option value="viewer">Can view only</option>
            </select>
            <button className="btn btn-soft btn-sm" onClick={() => void add()} disabled={!who.trim()}>
              Share
            </button>
          </div>
          {error && <div className="error-text">{error}</div>}
        </div>
      )}
      {!data.members.length && !canManage && <p className="tile-sub">Only the owner has access.</p>}
    </div>
  );
}
