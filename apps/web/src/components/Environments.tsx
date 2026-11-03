import type { Environment } from '../lib/api';
import { ENV_STATUS_LABEL } from '../lib/labels';
import { Icon } from './Icon';

export function Environments({ envs, k8sEnabled, onDelete }: { envs: Environment[]; k8sEnabled: boolean; onDelete: (id: string) => Promise<unknown> }) {
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
          <div className="tile-foot">
            {e.expires_at && <span>Available until {new Date(e.expires_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>}
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
