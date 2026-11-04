import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { __setLangForTests, dictionary, t } from '../src/lib/i18n';
import { Chat } from '../src/components/Chat';
import type { Application } from '../src/lib/api';

afterEach(() => {
  cleanup();
  __setLangForTests('en');
});

describe('i18n', () => {
  it('translates with placeholders and falls back to English', () => {
    __setLangForTests('fr');
    expect(t('Hello {name}', { name: 'Ada' })).toBe('Bonjour Ada');
    expect(t('Some string nobody translated')).toBe('Some string nobody translated');
    __setLangForTests('en');
    expect(t('Hello {name}', { name: 'Ada' })).toBe('Hello Ada');
  });

  it('keeps the placeholders of every French string', () => {
    for (const [en, fr] of Object.entries(dictionary('fr'))) expect(fr.match(/\{\w+\}/g) ?? []).toEqual(en.match(/\{\w+\}/g) ?? []);
  });

  it('renders the chat in French', () => {
    Element.prototype.scrollIntoView = () => undefined;
    __setLangForTests('fr');
    render(<Chat app={{ id: 'a', name: 'A', status: 'idle' } as Application} running={false} messages={[]} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByPlaceholderText('Donnez votre avis ou demandez la prochaine modification…')).toBeTruthy();
    expect(screen.getByText('Joindre')).toBeTruthy();
  });
});
