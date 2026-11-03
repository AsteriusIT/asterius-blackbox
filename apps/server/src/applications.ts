import { randomBytes } from 'node:crypto';
import { newId, one, run, type AppRow } from './db.js';
import { provisionApp, sendUserMessage } from './agent/runner.js';

const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'app';

function uniqueSlug(name: string) {
  const base = slugify(name);
  if (!one('SELECT 1 FROM applications WHERE slug = ?', base)) return base;
  return `${base.slice(0, 19)}-${randomBytes(2).toString('hex')}`;
}

/** Create an application, queue the user's first request and provision its repository (shared by the UI and Port). */
export function createApplication(
  ownerId: string,
  input: { name: string; description: string; prompt: string },
  /** Runs before provisioning starts, e.g. to subscribe an integration to the app's very first events. */
  beforeProvision?: (app: AppRow) => void,
): AppRow {
  const id = newId();
  run('INSERT INTO applications (id, owner_id, name, slug, description) VALUES (?, ?, ?, ?, ?)', id, ownerId, input.name, uniqueSlug(input.name), input.description);
  const created = one<AppRow>('SELECT * FROM applications WHERE id = ?', id)!;
  sendUserMessage(created, input.prompt); // queued until the repository exists
  beforeProvision?.(created);
  void provisionApp(id);
  return created;
}
