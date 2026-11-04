import { describe, expect, it, vi } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { register } from '../src/tracing.js';

const exporter = new InMemorySpanExporter();
register(new SimpleSpanProcessor({ exporter }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => import('./fake-sdk.js'));
const { sdk, init, say, result, until } = await import('./fake-sdk.js');
const { createUser } = await import('../src/auth.js');
const { createApplication } = await import('../src/applications.js');
const { startScheduler } = await import('../src/agent/runner.js');

describe('tracing', () => {
  it('nests tool spans under the run span', async () => {
    sdk.script = async function* (_t, { tools }) {
      yield init('s');
      await tools.find((t) => t.name === 'report_progress')!.handler({ phase: 'planning', title: 'Planning' });
      await tools.find((t) => t.name === 'get_pull_request')!.handler({ id: 99 }); // fails: no such PR
      yield say('done');
      yield result();
    };
    await startScheduler();
    const u = await createUser('trace@x.io', 'T', 'password1');
    await createApplication(u.id, { name: 'Traced', description: '', prompt: 'go' });
    await until(() => exporter.getFinishedSpans().some((s) => s.name === 'agent.run'));

    const spans = exporter.getFinishedSpans();
    const runSpan = spans.find((s) => s.name === 'agent.run')!;
    const tools = spans.filter((s) => s.name.startsWith('tool '));
    expect(tools.map((s) => s.name)).toEqual(['tool report_progress', 'tool get_pull_request']);
    for (const t of tools) {
      expect(t.parentSpanContext?.spanId).toBe(runSpan.spanContext().spanId);
      expect(t.spanContext().traceId).toBe(runSpan.spanContext().traceId);
    }
    expect(tools[1]!.status.code).toBe(2); // ERROR
    expect(runSpan.attributes).toMatchObject({ 'blackbox.status': 'succeeded' });
  });
});
