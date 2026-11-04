import client from 'prom-client';
import { all } from './db.js';

/**
 * Prometheus metrics (/metrics). Counters and histograms are per process (sum them across pods);
 * the `blackbox_queue_*` / `blackbox_environments` gauges are read from the database at scrape time,
 * so every pod reports the same cluster-wide value (use max()).
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'blackbox_process_' });

const m = {
  runsStarted: new client.Counter({ name: 'blackbox_runs_started_total', help: 'Agent runs started by this process', registers: [registry] }),
  runsFinished: new client.Counter({
    name: 'blackbox_runs_finished_total',
    help: 'Agent runs finished, by status',
    labelNames: ['status'],
    registers: [registry],
  }),
  runDuration: new client.Histogram({
    name: 'blackbox_run_duration_seconds',
    help: 'Wall-clock duration of agent runs',
    labelNames: ['status'],
    buckets: [30, 60, 120, 300, 600, 1200, 1800, 3600, 7200],
    registers: [registry],
  }),
  cost: new client.Counter({ name: 'blackbox_run_cost_usd_total', help: 'Anthropic cost of agent runs (USD)', registers: [registry] }),
  tokens: new client.Counter({ name: 'blackbox_tokens_total', help: 'Model tokens used by agent runs', labelNames: ['kind'], registers: [registry] }),
  builds: new client.Counter({
    name: 'blackbox_builds_total',
    help: 'Preview deployments (image build + rollout), by result',
    labelNames: ['result'],
    registers: [registry],
  }),
  sse: new client.Gauge({ name: 'blackbox_sse_clients', help: 'Open live-update streams on this process', registers: [registry] }),
};

new client.Gauge({
  name: 'blackbox_runs',
  help: 'Agent runs currently queued or running (cluster-wide)',
  labelNames: ['status'],
  registers: [registry],
  async collect() {
    this.reset();
    for (const s of ['queued', 'running']) this.set({ status: s }, 0);
    for (const r of await all<{ status: string; n: number }>("SELECT status, count(*) AS n FROM runs WHERE status IN ('queued', 'running') GROUP BY status"))
      this.set({ status: r.status }, Number(r.n));
  },
});
new client.Gauge({
  name: 'blackbox_environments',
  help: 'Preview environments by status (cluster-wide, deleted excluded)',
  labelNames: ['status'],
  registers: [registry],
  async collect() {
    this.reset();
    for (const r of await all<{ status: string; n: number }>("SELECT status, count(*) AS n FROM environments WHERE status != 'deleted' GROUP BY status"))
      this.set({ status: r.status }, Number(r.n));
  },
});

export const metrics = {
  runStarted: () => m.runsStarted.inc(),
  runFinished(r: { status: string; seconds: number; cost: number | null; inputTokens: number; outputTokens: number }) {
    m.runsFinished.inc({ status: r.status });
    m.runDuration.observe({ status: r.status }, r.seconds);
    if (r.cost) m.cost.inc(r.cost);
    if (r.inputTokens) m.tokens.inc({ kind: 'input' }, r.inputTokens);
    if (r.outputTokens) m.tokens.inc({ kind: 'output' }, r.outputTokens);
  },
  build: (result: 'ready' | 'failed') => m.builds.inc({ result }),
  sseOpened: () => m.sse.inc(),
  sseClosed: () => m.sse.dec(),
};
