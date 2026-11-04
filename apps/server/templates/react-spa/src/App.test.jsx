import { test, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { App } from './App.jsx';

test('renders the title', () => {
  expect(renderToString(<App />)).toContain('{{NAME}}');
});
