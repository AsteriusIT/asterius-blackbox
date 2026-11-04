import { useEffect, useState } from 'react';
import { api, type BranchDiff, type PullRequest } from '../lib/api';
import { PR_STATUS_LABEL } from '../lib/labels';
import { Icon } from './Icon';

export function PullRequests({ appId, prs }: { appId: string; prs: PullRequest[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (open) return <DiffView appId={appId} branch={open} onBack={() => setOpen(null)} />;
  if (!prs.length)
    return (
      <div className="panel-empty">
        <Icon name="branch" size={22} />
        <p>No change proposed yet.</p>
        <p className="sub">Each change is proposed as a pull request that you or your reviewers approve before it reaches the main version.</p>
      </div>
    );
  return (
    <div className="stack">
      {prs.map((p) => {
        const url = p.webUrl ?? p.web_url ?? undefined;
        const branch = p.sourceBranch ?? p.source_branch;
        return (
          <div key={p.id} className="tile">
            <div className="tile-head">
              <span className={`pill pill-pr-${p.status}`}>{PR_STATUS_LABEL[p.status] ?? p.status}</span>
              {url?.startsWith('http') && (
                <a href={url} target="_blank" rel="noreferrer" title="Open the pull request">
                  <Icon name="external" size={14} className="tile-ext" />
                </a>
              )}
            </div>
            <div className="tile-title">{p.title}</div>
            <div className="tile-sub">
              Pull request #{p.id} · {branch}
            </div>
            {branch && (
              <button className="btn btn-ghost btn-sm" onClick={() => setOpen(branch)}>
                View changes
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function lineClass(l: string) {
  if (l.startsWith('+++') || l.startsWith('---')) return '';
  if (l.startsWith('+')) return 'add';
  if (l.startsWith('-')) return 'del';
  return l.startsWith('@@') ? 'hunk' : '';
}

/** Files changed by a branch compared to main, with their diffs. */
function DiffView({ appId, branch, onBack }: { appId: string; branch: string; onBack: () => void }) {
  const [diff, setDiff] = useState<BranchDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => void api.diff(appId, branch).then(setDiff, (e: Error) => setError(e.message)), [appId, branch]);

  return (
    <div className="stack">
      <button className="btn btn-ghost btn-sm" onClick={onBack}>
        ← Pull requests
      </button>
      <div className="tile-sub">Changes on {branch} compared to the main version</div>
      {error && <div className="error-text">{error}</div>}
      {!diff && !error && <div className="tile-sub">Loading…</div>}
      {diff?.files.length === 0 && <div className="tile-sub">No difference with the main version.</div>}
      {diff?.files.map((f) => (
        <div key={f.path} className="tile diff-file">
          <button className="diff-head" onClick={() => setExpanded((e) => (e === f.path ? null : f.path))}>
            <span className="diff-path">{f.path}</span>
            <span className="diff-stat">
              {f.binary ? (
                'binary'
              ) : (
                <>
                  <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                </>
              )}
            </span>
          </button>
          {expanded === f.path && (
            <pre className="diff-patch">
              {f.patch
                ? f.patch.split('\n').map((l, i) => (
                    <span key={i} className={lineClass(l)}>
                      {l}
                      {'\n'}
                    </span>
                  ))
                : 'Too large to show here.'}
            </pre>
          )}
        </div>
      ))}
      {diff?.truncated && <div className="tile-sub">Some files are too large to show; open the pull request for the full diff.</div>}
    </div>
  );
}
