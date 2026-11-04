import type { BlackboxEvent as SharedEvent, EnvRow, MessageRow, PublicUser } from '@blackbox/shared';
export type {
  AppStatus,
  Application,
  BranchDiff,
  ConfigEntry,
  CostReport,
  Members,
  Platform,
  Role,
  RunHistory,
  StoredAttachment,
  Template,
  Upload,
} from '@blackbox/shared';
import type {
  Application,
  BranchDiff,
  ConfigEntry,
  CostReport,
  Members,
  Platform,
  Role,
  RunHistory,
  StoredAttachment,
  Template,
  Upload,
} from '@blackbox/shared';

export type Message = MessageRow;
export type Environment = EnvRow;
export type User = PublicUser;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- payload shape depends on `type`
export type BlackboxEvent = SharedEvent<any>;
/** Rows (GET /api/apps/:id) and live provider info (pr.updated) are merged in the UI. */
export interface PullRequest {
  id: number;
  title: string;
  source_branch?: string;
  sourceBranch?: string;
  status: string;
  web_url?: string | null;
  webUrl?: string;
}
export interface Run {
  id: string;
  status: string;
  cost_usd: number | null;
  num_turns: number | null;
  started_at: string;
  ended_at: string | null;
}

export const attachmentsOf = (m: { meta?: string | null }): StoredAttachment[] => {
  try {
    return m.meta ? ((JSON.parse(m.meta) as { attachments?: StoredAttachment[] }).attachments ?? []) : [];
  } catch {
    return [];
  }
};

/** Read browser files for upload (images, PDF, text; 5 MB each). */
export const toUploads = (files: File[]) =>
  Promise.all(
    files.map(
      (f) =>
        new Promise<Upload>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve({ name: f.name, mediaType: f.type || 'text/plain', data: String(r.result).split(',')[1] ?? '' });
          r.onerror = () => reject(new Error(`Could not read ${f.name}`));
          r.readAsDataURL(f);
        }),
    ),
  );

const TOKEN_KEY = 'blackbox.token';
export const auth = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  set(token: string | null) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth.token) {
    auth.set(null);
    location.reload();
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

export const api = {
  platform: () => request<Platform>('GET', '/api/platform'),
  me: () => request<User>('GET', '/api/me'),
  login: (email: string, password: string) => request<{ token: string; user: User }>('POST', '/api/auth/login', { email, password }),
  register: (email: string, name: string, password: string) => request<{ token: string; user: User }>('POST', '/api/auth/register', { email, name, password }),
  logout: () => request<unknown>('POST', '/api/auth/logout'),
  logoutAll: () => request<unknown>('POST', '/api/auth/logout-all'),
  streamTicket: () => request<{ ticket: string }>('POST', '/api/stream-ticket'),
  apps: () => request<Application[]>('GET', '/api/apps'),
  createApp: (b: { name: string; description: string; prompt: string; template?: string; importFrom?: string }) => request<Application>('POST', '/api/apps', b),
  templates: () => request<Template[]>('GET', '/api/templates'),
  app: (id: string) =>
    request<{ app: Application; role: Role; environments: Environment[]; pullRequests: PullRequest[]; runs: Run[] }>('GET', `/api/apps/${id}`),
  updateApp: (id: string, b: { requirePlanApproval?: boolean | null }) => request<Application>('PATCH', `/api/apps/${id}`, b),
  archive: (id: string) => request<unknown>('POST', `/api/apps/${id}/archive`),
  unarchive: (id: string) => request<unknown>('POST', `/api/apps/${id}/unarchive`),
  deleteApp: (id: string, confirm: string) => request<unknown>('DELETE', `/api/apps/${id}`, { confirm }),
  costs: () => request<CostReport>('GET', '/api/costs'),
  setBudget: (scope: string, monthlyUsd: number | null) => request<unknown>('PUT', '/api/budgets', { scope, monthlyUsd }),
  members: (id: string) => request<Members>('GET', `/api/apps/${id}/members`),
  addMember: (id: string, b: { email?: string; groupId?: string; role: 'viewer' | 'editor' }) => request<unknown>('POST', `/api/apps/${id}/members`, b),
  removeMember: (id: string, subject: string) => request<unknown>('DELETE', `/api/apps/${id}/members/${encodeURIComponent(subject)}`),
  messages: (id: string) => request<Message[]>('GET', `/api/apps/${id}/messages`),
  events: (id: string, after = 0, runId?: string) =>
    request<BlackboxEvent[]>('GET', `/api/apps/${id}/events?after=${after}&limit=${runId ? 2000 : 800}${runId ? `&runId=${encodeURIComponent(runId)}` : ''}`),
  config: (id: string) => request<ConfigEntry[]>('GET', `/api/apps/${id}/config`),
  setConfig: (id: string, b: { key: string; value: string; secret: boolean; env: string }) => request<unknown>('PUT', `/api/apps/${id}/config`, b),
  deleteConfig: (id: string, key: string, env: string) =>
    request<unknown>('DELETE', `/api/apps/${id}/config/${encodeURIComponent(key)}?env=${encodeURIComponent(env)}`),
  diff: (id: string, branch: string) => request<BranchDiff>('GET', `/api/apps/${id}/diff?branch=${encodeURIComponent(branch)}`),
  runs: (id: string) => request<RunHistory[]>('GET', `/api/apps/${id}/runs`),
  send: (id: string, content: string, attachments: Upload[] = []) => request<unknown>('POST', `/api/apps/${id}/messages`, { content, attachments }),
  /** Opens an attachment in a new tab (authenticated download). */
  async openAttachment(appId: string, file: string) {
    const res = await fetch(`/api/apps/${appId}/attachments/${encodeURIComponent(file)}`, { headers: { authorization: `Bearer ${auth.token}` } });
    if (!res.ok) throw new ApiError(res.status, 'Attachment not found');
    window.open(URL.createObjectURL(await res.blob()), '_blank', 'noopener');
  },
  stop: (id: string) => request<unknown>('POST', `/api/apps/${id}/stop`),
  retryProvisioning: (id: string) => request<unknown>('POST', `/api/apps/${id}/retry-provisioning`),
  extendEnv: (id: string, envId: string, hours = 24) => request<Environment>('POST', `/api/apps/${id}/environments/${envId}/extend`, { hours }),
  pinEnv: (id: string, envId: string, pinned: boolean) => request<Environment>('POST', `/api/apps/${id}/environments/${envId}/pin`, { pinned }),
  promoteEnv: (id: string, envId: string) => request<unknown>('POST', `/api/apps/${id}/environments/${envId}/promote`),
  deleteEnv: (id: string, envId: string) => request<unknown>('DELETE', `/api/apps/${id}/environments/${envId}`),
};
