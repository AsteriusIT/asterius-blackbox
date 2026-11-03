import { config } from '../../config.js';

/** Minimal Port REST client: client-credentials token (cached), retries on 429/5xx, one re-auth on 401. */
export class PortClient {
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly baseUrl = config.PORT_API_URL.replace(/\/$/, ''),
    private readonly clientId = config.PORT_CLIENT_ID,
    private readonly clientSecret = config.PORT_CLIENT_SECRET,
  ) {}

  get enabled() {
    return Boolean(this.clientId && this.clientSecret);
  }

  private async accessToken(force = false) {
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${this.baseUrl}/v1/auth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: this.clientId, clientSecret: this.clientSecret }),
    });
    const data = (await res.json().catch(() => ({}))) as { accessToken?: string; expiresIn?: number; message?: string };
    if (!res.ok || !data.accessToken) throw new PortError(res.status, `Port authentication failed: ${data.message ?? res.statusText}`);
    this.token = { value: data.accessToken, expiresAt: Date.now() + (data.expiresIn ?? 3600) * 1000 };
    return this.token.value;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, attempt = 1): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken(attempt > 1 && this.lastStatus === 401)}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.lastStatus = res.status;
    const text = await res.text();
    const data = text ? safeJson(text) : undefined;
    if (res.ok) return data as T;
    const retryable = res.status === 401 || res.status === 429 || res.status >= 500;
    if (retryable && attempt < 4) {
      await new Promise((r) => setTimeout(r, res.status === 401 ? 0 : attempt * 1500));
      return this.request<T>(method, path, body, attempt + 1);
    }
    const msg = (data as { message?: string; error?: string } | undefined)?.message ?? (data as { error?: string })?.error ?? text.slice(0, 300);
    throw new PortError(res.status, `Port ${method} ${path} → ${res.status}: ${msg}`);
  }
  private lastStatus = 0;

  // ---- entities ----
  upsertEntity(blueprint: string, entity: PortEntity, opts: { merge?: boolean; createMissingRelated?: boolean } = {}) {
    const q = new URLSearchParams({
      upsert: 'true',
      merge: String(opts.merge ?? false),
      create_missing_related_entities: String(opts.createMissingRelated ?? false),
    });
    return this.request('POST', `/v1/blueprints/${encodeURIComponent(blueprint)}/entities?${q}`, entity);
  }

  async deleteEntity(blueprint: string, identifier: string) {
    try {
      await this.request('DELETE', `/v1/blueprints/${encodeURIComponent(blueprint)}/entities/${encodeURIComponent(identifier)}`);
    } catch (err) {
      if (!(err instanceof PortError && err.status === 404)) throw err;
    }
  }

  async getEntity<T = PortEntity>(blueprint: string, identifier: string): Promise<T | undefined> {
    try {
      const res = await this.request<{ entity: T }>('GET', `/v1/blueprints/${encodeURIComponent(blueprint)}/entities/${encodeURIComponent(identifier)}`);
      return res.entity;
    } catch (err) {
      if (err instanceof PortError && err.status === 404) return undefined;
      throw err;
    }
  }

  async searchEntities(blueprint: string, rules: unknown[], include?: string[]) {
    const q = include?.length ? `?${include.map((i) => `include=${encodeURIComponent(i)}`).join('&')}` : '';
    const res = await this.request<{ entities: PortEntity[] }>('POST', `/v1/blueprints/${encodeURIComponent(blueprint)}/entities/search${q}`, {
      combinator: 'and',
      rules,
    });
    return res.entities ?? [];
  }

  async scorecards(blueprint: string) {
    const res = await this.request<{ scorecards: PortScorecard[] }>('GET', `/v1/blueprints/${encodeURIComponent(blueprint)}/scorecards`);
    return res.scorecards ?? [];
  }

  // ---- action runs ----
  updateRun(runId: string, body: { status?: 'SUCCESS' | 'FAILURE'; statusLabel?: string; link?: string | string[]; summary?: string }) {
    return this.request('PATCH', `/v1/actions/runs/${encodeURIComponent(runId)}?version=v2`, body);
  }

  logRun(runId: string, message: string, terminationStatus?: 'SUCCESS' | 'FAILURE', statusLabel?: string) {
    return this.request('POST', `/v1/actions/runs/${encodeURIComponent(runId)}/logs`, {
      message,
      ...(terminationStatus ? { terminationStatus } : {}),
      ...(statusLabel ? { statusLabel } : {}),
    });
  }
}

export class PortError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface PortEntity {
  identifier: string;
  title?: string;
  icon?: string;
  team?: string[];
  properties: Record<string, unknown>;
  relations?: Record<string, string | string[] | null>;
}

export interface PortScorecard {
  identifier: string;
  title: string;
  levels?: { title: string; color?: string }[];
  rules: { identifier: string; title: string; description?: string; level: string; query?: unknown }[];
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

export const port = new PortClient();
