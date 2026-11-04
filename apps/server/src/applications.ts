import { randomBytes } from 'node:crypto';
import { newId, one, run, type AppRow } from './db.js';
import { provisionApp, sendUserMessage } from './agent/runner.js';
import { audit, type AuditVia } from './audit.js';
import { getTemplate } from './templates.js';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'app';

async function uniqueSlug(name: string) {
  const base = slugify(name);
  if (!(await one('SELECT 1 FROM applications WHERE slug = ?', base))) return base;
  return `${base.slice(0, 19)}-${randomBytes(2).toString('hex')}`;
}

/** Create an application, queue the user's first request and provision its repository (shared by the UI and Port). */
export async function createApplication(
  ownerId: string,
  input: { name: string; description: string; prompt: string; template?: string; importFrom?: string },
  /** Runs before provisioning starts, e.g. to subscribe an integration to the app's very first events. */
  beforeProvision?: (app: AppRow) => void | Promise<void>,
  via: AuditVia = 'api',
): Promise<AppRow> {
  const id = newId();
  await run(
    'INSERT INTO applications (id, owner_id, name, slug, description, template, repo_source) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    ownerId,
    input.name,
    await uniqueSlug(input.name),
    input.description,
    input.importFrom ? null : (getTemplate(input.template)?.id ?? null),
    input.importFrom?.trim() || null,
  );
  const created = (await one<AppRow>('SELECT * FROM applications WHERE id = ?', id))!;
  await audit({ action: 'app.created', via, actorId: ownerId, appId: id, target: created.slug, detail: { name: input.name } });
  await sendUserMessage(created, input.prompt); // queued until the repository exists
  await beforeProvision?.(created);
  void provisionApp(id);
  return created;
}
