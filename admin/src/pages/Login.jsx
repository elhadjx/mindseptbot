import { useState } from 'react';
import { api } from '../lib/api';

export default function Login({ onAuthenticated }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onAuthenticated();
    } catch (err) {
      setError(
        err.message === 'too_many_attempts'
          ? 'Too many attempts. Wait a few minutes.'
          : 'That password is not right.'
      );
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card login__card" onSubmit={submit}>
        <img className="login__mark" src="/logo.png" alt="Mindsept" />
        <h1 style={{ marginBottom: 'var(--sp-1)' }}>Mindsept</h1>
        <p className="muted" style={{ marginTop: 0, fontSize: 'var(--fs-sm)' }}>
          Door access administration
        </p>

        <div className="field" style={{ marginTop: 'var(--sp-5)', textAlign: 'left' }}>
          <label className="field__label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && <div className="banner" style={{ marginBottom: 'var(--sp-4)' }}>{error}</div>}

        <button className="btn" type="submit" disabled={busy || !password} style={{ width: '100%' }}>
          {busy ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}
