import { newId, one, run, type MessageRow } from '../db.js';
import { publish } from '../events.js';
import { config } from '../config.js';

export async function addMessage(appId: string, role: MessageRow['role'], content: string, runId: string | null = null, meta?: Record<string, unknown>) {
  const id = newId();
  // ISO timestamp with milliseconds: orders messages written within the same second on every database.
  await run(
    'INSERT INTO messages (id, app_id, run_id, role, content, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    appId,
    runId,
    role,
    content,
    new Date().toISOString(),
    meta ? JSON.stringify(meta) : null,
  );
  const msg = (await one<MessageRow>('SELECT * FROM messages WHERE id = ?', id))!;
  void publish(appId, runId, 'message.created', { message: msg });
  return msg;
}

/** Plan approval: the application's own setting, else the platform default. */
export const needsPlanApproval = (app: { require_plan_approval?: number | null }) =>
  app.require_plan_approval === null || app.require_plan_approval === undefined ? config.AGENT_REQUIRE_PLAN_APPROVAL : app.require_plan_approval === 1;
