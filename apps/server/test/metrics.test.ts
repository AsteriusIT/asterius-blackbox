import { describe, expect, it } from 'vitest';
import { metrics, registry } from '../src/metrics.js';

describe('metrics', () => {
  it('exposes run, build and queue metrics', async () => {
    metrics.runStarted();
    metrics.runFinished({ status: 'succeeded', seconds: 42, cost: 1.5, inputTokens: 100, outputTokens: 20 });
    metrics.build('failed');
    const text = await registry.metrics();
    expect(text).toMatch(/blackbox_runs_started_total 1/);
    expect(text).toMatch(/blackbox_runs_finished_total\{status="succeeded"\} 1/);
    expect(text).toMatch(/blackbox_run_cost_usd_total 1\.5/);
    expect(text).toMatch(/blackbox_tokens_total\{kind="input"\} 100/);
    expect(text).toMatch(/blackbox_builds_total\{result="failed"\} 1/);
    expect(text).toMatch(/blackbox_runs\{status="queued"\} 0/);
    expect(text).toMatch(/blackbox_run_duration_seconds_bucket\{le="60",status="succeeded"\} 1/);
  });
});
