import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { Field, Spinner, Alert } from '../components/ui.jsx';

export default function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err.message ?? 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-card__brand">
          <span className="sidebar__brand-icon" aria-hidden="true">
            ⌾
          </span>
          <div>
            <h1 className="login-card__title">Student Attendance</h1>
            <p className="login-card__subtitle">Sign in to your staff account</p>
          </div>
        </div>

        <div className="stack">
          {error && <Alert tone="error">{error}</Alert>}

          <Field label="Email address">
            <input
              className="input"
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@school.example"
            />
          </Field>

          <Field label="Password">
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <button type="submit" className="btn btn--primary btn--block" disabled={busy || !email || !password}>
            {busy ? <Spinner /> : 'Sign in'}
          </button>

          <p className="small subtle" style={{ textAlign: 'center' }}>
            Forgotten your password? Ask an administrator to reset it for you.
          </p>
        </div>
      </form>
    </div>
  );
}
