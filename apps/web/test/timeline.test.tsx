import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Timeline } from '../src/components/Timeline';
import type { BlackboxEvent } from '../src/lib/api';

afterEach(cleanup);
const at = '2026-01-01T10:00:00.000Z';
const ev = (seq: number, type: BlackboxEvent['type'], payload: object): BlackboxEvent => ({ seq, appId: 'a', runId: 'r', type, payload, createdAt: at });

const events = [
  ev(1, 'run.started', {}),
  ev(2, 'progress', { phase: 'planning', title: 'Planning the app' }),
  ev(3, 'activity', {
    kind: 'plan',
    title: 'Plan updated',
    todos: [
      { content: 'Build API', status: 'completed' },
      { content: 'Build UI', status: 'pending' },
    ],
  }),
  ev(4, 'activity', { kind: 'git', title: 'git push', actor: 'coder' }),
  ev(5, 'activity', { kind: 'deploy', title: 'Deploying preview' }),
  ev(6, 'run.finished', { status: 'succeeded', costUsd: 1.234 }),
];

describe('Timeline', () => {
  it('shows milestones and friendly activity, newest first', () => {
    render(<Timeline events={events} running={false} />);
    const titles = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(titles[0]).toMatch(/Finished.*\$1\.23/);
    expect(screen.getByText('Planning the app')).toBeTruthy();
    expect(screen.getByText('Deploying preview')).toBeTruthy();
    expect(screen.queryByText('git push')).toBeNull();
  });

  it('reveals technical activity behind the toggle', () => {
    render(<Timeline events={events} running={false} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText('git push')).toBeTruthy();
    expect(screen.getByText(/Git · Developer/)).toBeTruthy();
  });

  it('shows the live checklist only while running', () => {
    const { rerender } = render(<Timeline events={events} running={true} />);
    expect(screen.getByText('Checklist')).toBeTruthy();
    expect(screen.getByText('Build UI')).toBeTruthy();
    rerender(<Timeline events={events} running={false} />);
    expect(screen.queryByText('Checklist')).toBeNull();
  });

  it('has an empty state', () => {
    render(<Timeline events={[]} running={false} />);
    expect(screen.getByText(/Updates will appear here/)).toBeTruthy();
  });
});
