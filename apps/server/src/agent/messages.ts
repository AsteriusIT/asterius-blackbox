import { newId, one, run, type MessageRow } from '../db.js';
import { publish } from '../events.js';

export function addMessage(appId: string, role: MessageRow['role'], content: string, runId: string | null = null) {
  const id = newId();
  run('INSERT INTO messages (id, app_id, run_id, role, content) VALUES (?, ?, ?, ?, ?)', id, appId, runId, role, content);
  const msg = one<MessageRow>('SELECT * FROM messages WHERE id = ?', id)!;
  publish(appId, runId, 'message.created', { message: msg });
  return msg;
}
