import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../config.js';
import type { MessageRow } from '../db.js';

/**
 * Chat attachments (screenshots, mockups, specs, CSV samples). Stored under DATA_DIR/attachments/<app id>/ and
 * given to the agent as content blocks: images and PDFs natively, text files inlined.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const TEXT = /^(text\/|application\/(json|xml|yaml|x-yaml|csv|sql))/;

export const uploadSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(200),
      mediaType: z.string().max(100),
      data: z.string().max(Math.ceil((MAX_BYTES * 4) / 3) + 4), // base64
    }),
  )
  .max(5)
  .default([]);
export type Upload = z.infer<typeof uploadSchema>[number];

export type { StoredAttachment } from '@blackbox/shared';
import type { StoredAttachment } from '@blackbox/shared';

const dirOf = (appId: string) => path.join(config.DATA_DIR, 'attachments', appId);
const safeName = (n: string) =>
  path
    .basename(n)
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 120) || 'file';

export function isSupported(mediaType: string) {
  return IMAGE.includes(mediaType) || mediaType === 'application/pdf' || TEXT.test(mediaType);
}

export function saveAttachments(appId: string, uploads: Upload[]): StoredAttachment[] {
  if (!uploads.length) return [];
  fs.mkdirSync(dirOf(appId), { recursive: true });
  return uploads.map((u) => {
    if (!isSupported(u.mediaType))
      throw Object.assign(new Error(`Unsupported file type ${u.mediaType} (${u.name}): use images, PDF or text files.`), { statusCode: 400 });
    const bytes = Buffer.from(u.data, 'base64');
    if (bytes.length > MAX_BYTES) throw Object.assign(new Error(`${u.name} is larger than 5 MB.`), { statusCode: 413 });
    const file = `${randomBytes(6).toString('hex')}-${safeName(u.name)}`;
    fs.writeFileSync(path.join(dirOf(appId), file), bytes);
    return { name: u.name, mediaType: u.mediaType, size: bytes.length, file };
  });
}

export const attachmentsOf = (m: Pick<MessageRow, 'meta'>): StoredAttachment[] => {
  try {
    return m.meta ? ((JSON.parse(m.meta) as { attachments?: StoredAttachment[] }).attachments ?? []) : [];
  } catch {
    return [];
  }
};

export function attachmentPath(appId: string, file: string) {
  const p = path.join(dirOf(appId), path.basename(file));
  return fs.existsSync(p) ? p : null;
}

type Block = Exclude<SDKUserMessage['message']['content'], string>[number];

/** Content blocks for a message's attachments (after its text). */
export function attachmentBlocks(appId: string, m: Pick<MessageRow, 'meta'>): Block[] {
  const blocks: Block[] = [];
  for (const a of attachmentsOf(m)) {
    const p = attachmentPath(appId, a.file);
    if (!p) continue;
    const data = fs.readFileSync(p);
    if (IMAGE.includes(a.mediaType))
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType as 'image/png', data: data.toString('base64') } });
    else if (a.mediaType === 'application/pdf')
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: data.toString('base64') }, title: a.name });
    else blocks.push({ type: 'text', text: `Attached file ${a.name}:\n\`\`\`\n${data.toString('utf8').slice(0, 100_000)}\n\`\`\`` });
  }
  return blocks;
}

/** A prompt: plain text, or text + attachment blocks when there are any. */
export function promptContent(text: string, blocks: Block[]): string | Block[] {
  return blocks.length ? [{ type: 'text', text }, ...blocks] : text;
}
