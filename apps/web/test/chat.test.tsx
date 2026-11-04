import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Chat } from '../src/components/Chat';
import type { Application, Message } from '../src/lib/api';

afterEach(cleanup);
Element.prototype.scrollIntoView = () => undefined;

const app = { id: 'a', name: 'App', status: 'idle' } as Application;
const msgs: Message[] = [
  { id: '1', app_id: 'a', run_id: null, role: 'user', content: 'Build it', created_at: '' },
  { id: '2', app_id: 'a', run_id: null, role: 'assistant', content: 'Here is **the plan**', created_at: '' },
  { id: '3', app_id: 'a', run_id: null, role: 'system', content: 'Env deleted', created_at: '' },
];

describe('Chat', () => {
  it('renders user, agent (markdown) and system messages', () => {
    render(<Chat app={app} running={false} messages={msgs} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByText('Build it')).toBeTruthy();
    expect(screen.getByText('the plan').tagName).toBe('STRONG');
    expect(screen.getByText('Env deleted')).toBeTruthy();
  });

  it('sends on Enter and clears the box', async () => {
    const onSend = vi.fn(async () => undefined);
    render(<Chat app={app} running={false} messages={[]} onSend={onSend} onStop={vi.fn()} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: '  more tests  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(box.value).toBe(''));
    expect(onSend).toHaveBeenCalledWith('more tests', []);
  });

  it('keeps the text and shows the error when sending fails', async () => {
    render(<Chat app={app} running={false} messages={[]} onSend={async () => Promise.reject(new Error('nope'))} onStop={vi.fn()} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText('Send'));
    await screen.findByText('nope');
    expect(box.value).toBe('hi');
  });

  it('offers Stop and a live status while running', () => {
    const onStop = vi.fn(async () => undefined);
    render(<Chat app={app} running={true} messages={[]} liveStatus="Writing tests" onSend={vi.fn()} onStop={onStop} />);
    expect(screen.getByText('Writing tests')).toBeTruthy();
    fireEvent.click(screen.getByText('Stop'));
    expect(onStop).toHaveBeenCalled();
  });

  it('is read-only for viewers', () => {
    render(<Chat app={app} running={false} messages={msgs} readOnly onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/Ask its owner for chat access/)).toBeTruthy();
  });

  it('offers Approve / Request changes under a plan awaiting approval', async () => {
    const plan: Message = {
      id: 'p',
      app_id: 'a',
      run_id: null,
      role: 'assistant',
      content: '### Here is the plan',
      created_at: '',
      meta: '{"type":"plan","needsApproval":true}',
    };
    const onSend = vi.fn(async () => undefined);
    render(<Chat app={app} running={false} messages={[...msgs, plan]} onSend={onSend} onStop={vi.fn()} />);
    fireEvent.click(screen.getByText('Approve the plan'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Approved — go ahead with this plan.', []));
    fireEvent.click(screen.getByText('Request changes'));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Please change the plan: ');
  });

  it('hides the plan buttons once the conversation moved on or while running', () => {
    const plan: Message = {
      id: 'p',
      app_id: 'a',
      run_id: null,
      role: 'assistant',
      content: 'plan',
      created_at: '',
      meta: '{"type":"plan","needsApproval":true}',
    };
    const { rerender } = render(<Chat app={app} running={true} messages={[plan]} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.queryByText('Approve the plan')).toBeNull();
    rerender(<Chat app={app} running={false} messages={[plan, msgs[0]!]} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.queryByText('Approve the plan')).toBeNull();
  });

  it('sends attached files with the message and clears them', async () => {
    const onSend = vi.fn(async () => undefined);
    const { container } = render(<Chat app={app} running={false} messages={[]} onSend={onSend} onStop={vi.fn()} />);
    const file = new File(['a,b'], 'data.csv', { type: 'text/csv' });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } });
    expect(screen.getByText('data.csv ×')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'use this' } });
    fireEvent.click(screen.getByLabelText('Send'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('use this', [file]));
    await waitFor(() => expect(screen.queryByText('data.csv ×')).toBeNull());
  });

  it('shows attachments on sent messages', () => {
    const m: Message = {
      id: 'x',
      app_id: 'a',
      run_id: null,
      role: 'user',
      content: 'see',
      created_at: '',
      meta: '{"attachments":[{"name":"mock.png","mediaType":"image/png","size":3,"file":"ab-mock.png"}]}',
    };
    render(<Chat app={app} running={false} messages={[m]} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByText('mock.png')).toBeTruthy();
  });
});
