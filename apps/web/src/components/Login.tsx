import { useState } from 'react';
import { api, auth, type Platform, type User } from '../lib/api';

function MicrosoftLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export function Login({ platform, onLogin }: { platform: Platform | null; onLogin: (u: User) => void }) {
  const providers = platform?.authProviders ?? [];
  const entra = providers.includes('entra');
  const local = providers.includes('local');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(() => new URLSearchParams(location.search).get('error'));
  const [busy, setBusy] = useState(false);

  const returnTo = ['/', '/login', '/auth/callback'].includes(location.pathname) ? '/' : location.pathname;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = mode === 'login' ? await api.login(email, password) : await api.register(email, name, password);
      auth.set(res.token);
      history.replaceState(null, '', returnTo);
      onLogin(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-form">
        <span className="brand-mark big" />
        <h1>{mode === 'login' ? 'Welcome to Blackbox' : 'Create your account'}</h1>
        <p className="lead">Describe the application you need. Blackbox builds it, lets you try it, and improves it with your feedback.</p>

        {entra && mode === 'login' && (
          <button
            className="btn btn-microsoft btn-lg"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              location.href = `/api/auth/entra/login?returnTo=${encodeURIComponent(returnTo)}`;
            }}
          >
            <MicrosoftLogo /> Continue with Microsoft
          </button>
        )}

        {entra && local && mode === 'login' && <div className="divider">or</div>}

        {local && (
          <form className="login-fields" onSubmit={submit}>
            {mode === 'register' && <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required />}
            <input type="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!entra} />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={mode === 'register' ? 8 : 1}
              required
            />
            <button className={`btn ${entra ? 'btn-soft' : 'btn-accent'} btn-lg`} disabled={busy}>
              {mode === 'login' ? 'Continue with email' : 'Create account'}
            </button>
          </form>
        )}

        {error && <div className="error-text">{error}</div>}

        {local && platform?.allowRegistration && (
          <p className="login-switch">
            {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}{' '}
            <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Sign up' : 'Sign in'}
            </button>
          </p>
        )}
        {entra && !local && <p className="login-switch">Use your work account. Access is managed by your organization.</p>}
      </div>
    </div>
  );
}
