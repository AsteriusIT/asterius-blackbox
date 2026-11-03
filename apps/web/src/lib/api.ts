export type AppStatus = 'provisioning' | 'ready' | 'running' | 'idle' | 'error';

export interface Application {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: AppStatus;
  phase: string | null;
  repo_web_url: string | null;
  repo_name: string | null;
  last_error: string | null;
  running: boolean;
  /** Dashboard summary (GET /api/apps) */
  live_env_url?: string | null;
  env_count?: number;
  open_prs?: number;
  last_progress?: string | null;
  last_activity_at?: string | null;
  created_at: string;
  updated_at: string;
}
export interface Message {
  id: string;
  app_id: string;
  run_id: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}
export interface Environment {
  id: string;
  app_id: string;
  name: string;
  namespace: string;
  branch: string;
  commit_sha: string | null;
  url: string | null;
  status: 'building' | 'deploying' | 'ready' | 'failed' | 'deleted';
  message: string | null;
  expires_at: string | null;
  updated_at: string;
}
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
export interface BlackboxEvent {
  seq: number;
  appId: string;
  runId: string | null;
  type: 'app.updated' | 'message.created' | 'run.started' | 'run.finished' | 'progress' | 'activity' | 'env.updated' | 'pr.updated' | 'notification';
  payload: any;
  createdAt: string;
}
export interface Platform {
  gitProvider: 'azure-devops' | 'local';
  adoProject: string | null;
  policies: string[];
  k8sEnabled: boolean;
  baseDomain: string;
  plannerModel: string;
  coderModel: string;
  buildMode: string;
  allowRegistration: boolean;
  authProviders: ('local' | 'entra')[];
}
export interface User {
  id: string;
  email: string;
  name: string;
  provider?: 'local' | 'entra';
}

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
  constructor(public status: number, message: string) {
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
  register: (email: string, name: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/api/auth/register', { email, name, password }),
  logout: () => request<unknown>('POST', '/api/auth/logout'),
  apps: () => request<Application[]>('GET', '/api/apps'),
  createApp: (b: { name: string; description: string; prompt: string }) => request<Application>('POST', '/api/apps', b),
  app: (id: string) =>
    request<{ app: Application; environments: Environment[]; pullRequests: PullRequest[]; runs: Run[] }>('GET', `/api/apps/${id}`),
  messages: (id: string) => request<Message[]>('GET', `/api/apps/${id}/messages`),
  events: (id: string, after = 0) => request<BlackboxEvent[]>('GET', `/api/apps/${id}/events?after=${after}&limit=800`),
  send: (id: string, content: string) => request<unknown>('POST', `/api/apps/${id}/messages`, { content }),
  stop: (id: string) => request<unknown>('POST', `/api/apps/${id}/stop`),
  retryProvisioning: (id: string) => request<unknown>('POST', `/api/apps/${id}/retry-provisioning`),
  deleteEnv: (id: string, envId: string) => request<unknown>('DELETE', `/api/apps/${id}/environments/${envId}`),
};
