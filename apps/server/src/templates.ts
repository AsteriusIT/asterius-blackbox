import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Starters: the repository's first commit comes with a working skeleton (Dockerfile, health endpoint, tests, CI)
 * so the first run is faster and cheaper and the first preview rarely fails. `{{NAME}}` / `{{SLUG}}` are replaced.
 * Files live in apps/server/templates/<id>/ (shipped in the image next to dist/).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates');

export type { Template } from '@blackbox/shared';
import type { Template } from '@blackbox/shared';

export function listTemplates(): Template[] {
  if (!fs.existsSync(ROOT)) return [];
  return fs
    .readdirSync(ROOT)
    .filter((id) => fs.existsSync(path.join(ROOT, id, 'template.json')))
    .map((id) => ({ id, ...(JSON.parse(fs.readFileSync(path.join(ROOT, id, 'template.json'), 'utf8')) as Omit<Template, 'id'>) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const getTemplate = (id: string | null | undefined) => (id ? listTemplates().find((t) => t.id === id) : undefined);

/** Repository-relative path → content, placeholders filled. */
export function templateFiles(id: string, vars: { name: string; slug: string }): Record<string, string> {
  const dir = path.join(ROOT, id);
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(r);
      else if (r !== 'template.json') files[r] = fs.readFileSync(path.join(dir, r), 'utf8').replaceAll('{{NAME}}', vars.name).replaceAll('{{SLUG}}', vars.slug);
    }
  };
  walk('');
  return files;
}
