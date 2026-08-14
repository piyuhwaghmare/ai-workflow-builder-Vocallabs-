import { useState } from 'react';
import { nhost } from './Nhost';
import { useAuth } from './AuthProvider';
import './SignIn.css';

export default function SignIn() {
  const { refresh } = useAuth();
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      if (mode === 'signin') {
        const response = await nhost.auth.signInEmailPassword({ email, password });
        if (response.body?.session) {
          refresh(); // no onAuthStateChanged in this SDK — sync manually
        } else {
          setError('Sign in did not return a session. Check your credentials.');
        }
      } else {
        const response = await nhost.auth.signUpEmailPassword({ email, password });
        if (response.body?.session) {
          refresh(); // signed up and logged in immediately (verification off)
        } else {
          setInfo('Account created. Check your email to verify, then sign in.');
        }
      }
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="signin-shell">
      <div className="signin-card">
        <div className="signin-mark">
          <span className="signin-dot signin-dot--amber" />
          <span className="signin-dot signin-dot--teal" />
          <span className="signin-dot signin-dot--green" />
        </div>
        <h1 className="signin-title">Workflow Runner</h1>
        <p className="signin-sub">Sign in to see the orgs and workflows you belong to.</p>

        <form onSubmit={handleSubmit} className="signin-form">
          <label className="signin-label">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@org.com"
              autoComplete="email"
            />
          </label>
          <label className="signin-label">
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
          </label>

          {error && <p className="signin-error">{error}</p>}
          {info && <p className="signin-info">{info}</p>}

          <button type="submit" className="signin-submit" disabled={loading}>
            {loading ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <button
          className="signin-toggle"
          onClick={() => {
            setError(null);
            setInfo(null);
            setMode(mode === 'signin' ? 'signup' : 'signin');
          }}
        >
          {mode === 'signin' ? "Need an account? Sign up" : 'Have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}