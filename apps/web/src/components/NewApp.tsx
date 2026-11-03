import { useState } from 'react';
import { api, type Application, type Platform } from '../lib/api';
import { Icon } from './Icon';

const EXAMPLES = [
  { title: 'Customer feedback portal', prompt: 'A simple portal where our customers can submit feedback and ideas, vote on them, and where our team can reply and mark them as planned or done.' },
  { title: 'Room booking', prompt: 'An internal tool to book meeting rooms: see availability per day, book a slot, cancel it, and get a weekly overview for each office.' },
  { title: 'Library REST API', prompt: 'A REST API in Node.js + Postgres to manage books, members and loans, with OpenAPI documentation and a minimal admin web page.' },
];

export function NewApp({ platform, onCreated }: { platform: Platform | null; onCreated: (a: Application) => void }) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createApp({ name: name.trim(), description: prompt.trim().slice(0, 4000), prompt: prompt.trim() }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="new-app">
      <div className="new-app-inner">
        <h1 className="hero">What would you like to build?</h1>
        <p className="lead center">
          Describe it like you would to a colleague: who it's for, what they should be able to do, anything that matters to you. Blackbox plans it, builds it
          {platform?.k8sEnabled ? ' and gives you a link to try it' : ''}.
        </p>

        <form className="composer composer-hero" onSubmit={submit}>
          <input className="composer-title" value={name} onChange={(e) => setName(e.target.value)} placeholder="Give it a name — e.g. Feedback portal" maxLength={60} />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder="Our sales team needs a place to…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
            }}
          />
          <div className="composer-bar">
            <span className="hint">The agent will share a plan before it starts building.</span>
            <button className="send-btn" disabled={busy || !name.trim() || !prompt.trim()} aria-label="Start">
              {busy ? <span className="spinner light" /> : <Icon name="send" size={18} />}
            </button>
          </div>
        </form>
        {error && <div className="error-text center">{error}</div>}

        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button
              type="button"
              key={ex.title}
              className="example"
              onClick={() => {
                setName(ex.title);
                setPrompt(ex.prompt);
              }}
            >
              <span className="example-title">{ex.title}</span>
              <span className="example-text">{ex.prompt}</span>
            </button>
          ))}
        </div>

        {platform && (
          <details className="fineprint">
            <summary>How your code is kept safe</summary>
            <p>
              Every application gets its own repository{platform.adoProject ? ` in the Azure DevOps project “${platform.adoProject}”` : ''}. The agent works on separate
              branches and proposes changes through pull requests that a person approves. The main version is protected:
            </p>
            <ul>{platform.policies.map((p) => <li key={p}>{p}</li>)}</ul>
          </details>
        )}
      </div>
    </div>
  );
}
