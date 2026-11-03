import type { PullRequest } from '../lib/api';
import { PR_STATUS_LABEL } from '../lib/labels';
import { Icon } from './Icon';

export function PullRequests({ prs }: { prs: PullRequest[] }) {
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
        return (
          <a key={p.id} className="tile tile-link" href={url} target="_blank" rel="noreferrer">
            <div className="tile-head">
              <span className={`pill pill-pr-${p.status}`}>{PR_STATUS_LABEL[p.status] ?? p.status}</span>
              <Icon name="external" size={14} className="tile-ext" />
            </div>
            <div className="tile-title">{p.title}</div>
            <div className="tile-sub">
              Pull request #{p.id} · {p.sourceBranch ?? p.source_branch}
            </div>
          </a>
        );
      })}
    </div>
  );
}
