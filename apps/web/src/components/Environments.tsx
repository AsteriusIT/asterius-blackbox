import type { Environment } from '../lib/api';
import { ENV_STATUS_LABEL } from '../lib/labels';
import { Icon } from './Icon';

export function Environments({
  envs,
  k8sEnabled,
  canEdit = true,
  onDelete,
  onExtend,
  onPin,
  onPromote,
}: {
  envs: Environment[];
  k8sEnabled: boolean;
  canEdit?: boolean;
  onDelete: (id: string) => Promise<unknown>;
  onExtend?: (id: string) => Promise<unknown>;
  onPin?: (id: string, pinned: boolean) => Promise<unknown>;
  onPromote?: (id: string) => Promise<unknown>;
}) {
  if (!k8sEnabled) return <p className="panel-empty">Live previews are not enabled on this platform.</p>;
  if (!envs.length)
    return (
      <div className="panel-empty">
        <Icon name="rocket" size={22} />
        <p>No preview yet.</p>
        <p className="sub">As soon as there is something to try, the agent publishes a preview and you get a notification.</p>
      </div>
    );
  return (
    <div className="stack">
      {envs.map((e) => (
        <article key={e.id} className={`tile env-${e.status}`}>
          <div className="tile-head">
            <span className={`pill pill-env-${e.status}`}>
              {(e.status === 'building' || e.status === 'deploying') && <span className="spinner tiny" />}
              {ENV_STATUS_LABEL[e.status] ?? e.status}
            </span>
            <span className="tile-title">{e.name}</span>
          </div>
          <div className="tile-sub">
            Version from <b>{e.branch}</b>
            {e.commit_sha && <> · {e.commit_sha.slice(0, 7)}</>}
          </div>
          {e.status === 'ready' && e.url && (
            <a className="btn btn-accent btn-block" href={e.url} target="_blank" rel="noreferrer">
              <Icon name="rocket" size={15} /> Open the preview
            </a>
          )}
          {e.status !== 'ready' && e.message && (
            <details className="tile-details" open={e.status !== 'failed'}>
              <summary>{e.status === 'failed' ? 'What went wrong (the agent is on it)' : 'Details'}</summary>
              <pre>{e.message}</pre>
            </details>
          )}
          {canEdit && e.status === 'ready' && (
            <div className="env-actions">
              {!e.pinned && onExtend && (
                <button className="btn btn-ghost btn-sm" onClick={() => void onExtend(e.id)} title="Keep it one more day">
                  +1 day
                </button>
              )}
              {onPin && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void onPin(e.id, !e.pinned)}
                  title={e.pinned ? 'Let it expire again' : 'Keep it until you remove it'}
                >
                  {e.pinned ? 'Unpin' : 'Keep (pin)'}
                </button>
              )}
              {onPromote && e.spec && !e.name.endsWith('-staging') && (
                <button
                  className="btn btn-soft btn-sm"
                  onClick={() => {
                    if (confirm('Deploy the main version as the long-lived "staging" environment? It is then refreshed after every merge.'))
                      void onPromote(e.id);
                  }}
                >
                  Promote to staging
                </button>
              )}
            </div>
          )}
          <div className="tile-foot">
            {e.pinned ? (
              <span>Kept until you remove it{e.name.endsWith('-staging') ? ' · follows the main version' : ''}</span>
            ) : (
              e.expires_at && <span>Available until {new Date(e.expires_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
            )}
            <button
              className="icon-btn"
              title="Remove this preview"
              onClick={() => {
                if (confirm(`Remove the preview “${e.name}”?`)) void onDelete(e.id);
              }}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
