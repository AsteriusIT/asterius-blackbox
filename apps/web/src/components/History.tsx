import { useEffect, useState } from 'react';
import { api, type BlackboxEvent, type RunHistory } from '../lib/api';
import { timeAgo } from '../lib/time';
import { Timeline } from './Timeline';

const RUN_LABEL: Record<string, string> = { succeeded: 'Finished', failed: 'Stopped after a problem', stopped: 'Stopped', running: 'Working' };
const duration = (s: number | null) => (s == null ? '' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** Past runs (summary, cost, duration, what they produced); open one to replay its timeline. */
export function History({ appId }: { appId: string }) {
  const [runs, setRuns] = useState<RunHistory[] | null>(null);
  const [open, setOpen] = useState<BlackboxEvent[] | null>(null);
  useEffect(() => void api.runs(appId).then(setRuns), [appId]);

  if (open)
    return (
      <div className="stack">
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(null)}>
          ← All runs
        </button>
        <Timeline events={open} running={false} />
      </div>
    );
  if (!runs) return null;
  if (!runs.length) return <p className="tile-sub">No run yet.</p>;
  return (
    <div className="stack">
      {runs.map((r) => (
        <button key={r.id} className="tile tile-link history-run" onClick={() => void api.events(appId, 0, r.id).then(setOpen)}>
          <div className="tile-head">
            <span className={`pill pill-run-${r.status}`}>{RUN_LABEL[r.status] ?? r.status}</span>
            <span className="tile-sub">
              {timeAgo(r.started_at)}
              {r.durationSeconds != null && ` · ${duration(r.durationSeconds)}`}
              {r.cost_usd != null && ` · $${r.cost_usd.toFixed(2)}`}
            </span>
          </div>
          {r.summary && <div className="tile-title">{r.summary.split('\n')[0]!.slice(0, 160)}</div>}
          {(r.pullRequests.length > 0 || r.environments.length > 0) && (
            <div className="tile-sub">{[...r.pullRequests.map((p) => `PR #${p.id}`), ...r.environments.map((e) => `preview ${e.name}`)].join(' · ')}</div>
          )}
        </button>
      ))}
    </div>
  );
}
