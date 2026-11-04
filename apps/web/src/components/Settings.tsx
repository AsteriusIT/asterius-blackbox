import { useState } from 'react';
import { api, type Application, type Platform } from '../lib/api';
import { AppConfig } from './AppConfig';

/** Per-application settings (editors) and end of life (owner). */
export function Settings({
  app,
  platform,
  canEdit,
  isOwner,
  onChange,
}: {
  app: Application;
  platform: Platform | null;
  canEdit: boolean;
  isOwner: boolean;
  onChange: (a: Application) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const approval = app.require_plan_approval == null ? (platform?.requirePlanApproval ?? false) : app.require_plan_approval === 1;

  const act = async (fn: () => Promise<unknown>, question?: string) => {
    if (question && !confirm(question)) return;
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async () => {
    const typed = prompt(`This permanently deletes "${app.name}", its repository and its previews.\nType the application name to confirm:`);
    if (typed === null) return;
    await act(async () => {
      await api.deleteApp(app.id, typed);
      location.href = '/';
    });
  };

  return (
    <div className="stack">
      <div className="tile">
        <label className="switch">
          <input
            type="checkbox"
            checked={approval}
            disabled={!canEdit || app.status === 'archived'}
            onChange={() => void act(async () => onChange(await api.updateApp(app.id, { requirePlanApproval: !approval })))}
          />
          <span className="switch-track" />
          Ask me to approve the plan before building
        </label>
        <div className="tile-sub">The agent shares its plan and waits for your go. Otherwise it starts right away and you can redirect it at any time.</div>
      </div>

      {canEdit && app.status !== 'archived' && <AppConfig appId={app.id} />}

      {isOwner && (
        <div className="tile">
          <div className="tile-title">End of life</div>
          {app.status === 'archived' ? (
            <>
              <div className="tile-sub">This application is archived: read-only, previews removed. Restore it to work on it again.</div>
              <button className="btn btn-soft btn-sm" onClick={() => void act(() => api.unarchive(app.id))}>
                Restore
              </button>
            </>
          ) : (
            <>
              <div className="tile-sub">Archiving stops the agent and removes the previews; the code repository and this history are kept.</div>
              <button
                className="btn btn-soft btn-sm"
                onClick={() => void act(() => api.archive(app.id), 'Archive this application? The agent stops and previews are removed.')}
              >
                Archive
              </button>
            </>
          )}
          <div className="tile-sub">Deleting removes everything for good: previews, the code repository, the developer-portal entry and this history.</div>
          <button className="btn btn-ghost btn-sm danger" onClick={() => void remove()}>
            Delete…
          </button>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
