import { useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { Modal, Field, Spinner, Alert } from './ui.jsx';

/**
 * Password change, in two modes.
 *
 *   forced — the account is flagged must_change_password (a new account, or one
 *            an admin has just reset). The dialog cannot be dismissed; the only
 *            way past it is to set a password or to sign out.
 *   normal — the user chose to change it from the sidebar.
 *
 * Changing a password revokes every session for the account server-side, which
 * would otherwise dump the user back at the login screen. Since we are holding
 * the new password at that moment, we immediately re-authenticate with it so
 * the change is seamless. If that re-authentication fails for any reason we
 * sign out cleanly rather than leaving a half-dead session in place.
 */
export default function ChangePasswordModal({ forced = false, onClose }) {
  const { user, signIn, signOut } = useAuth();
  const toast = useToast();

  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  /** "a, b and c" — reads better than a bare comma-joined list. */
  const listify = (items) =>
    items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

  // Mirrors the server's policy so the user is told before a round-trip.
  const problems = [];
  if (form.newPassword && form.newPassword.length < 8) problems.push('at least 8 characters');
  if (form.newPassword && !/[A-Za-z]/.test(form.newPassword)) problems.push('a letter');
  if (form.newPassword && !/[0-9]/.test(form.newPassword)) problems.push('a number');

  const mismatch = form.confirmPassword.length > 0 && form.newPassword !== form.confirmPassword;
  const sameAsOld = form.newPassword.length > 0 && form.newPassword === form.currentPassword;

  const canSubmit =
    form.currentPassword.length > 0 &&
    form.newPassword.length > 0 &&
    form.confirmPassword.length > 0 &&
    problems.length === 0 &&
    !mismatch &&
    !sameAsOld &&
    !busy;

  const submit = async (event) => {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/auth/change-password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });

      try {
        await signIn(user.email, form.newPassword);
        toast.success('Password updated');
        onClose?.();
      } catch {
        toast.info('Password updated — please sign in again with your new password');
        await signOut();
      }
    } catch (err) {
      // A wrong current password lands here; the session stays intact.
      setError(err.message ?? 'Could not change the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={forced ? 'Choose a new password' : 'Change your password'}
      onClose={onClose ?? (() => {})}
      dismissible={!forced}
      size="sm"
      footer={
        <>
          {forced ? (
            <button type="button" className="btn" onClick={signOut} disabled={busy}>
              Sign out instead
            </button>
          ) : (
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          )}
          <button type="submit" form="change-password-form" className="btn btn--primary" disabled={!canSubmit}>
            {busy ? <Spinner /> : 'Update password'}
          </button>
        </>
      }
    >
      <form id="change-password-form" className="stack" onSubmit={submit}>
        {forced && (
          <Alert tone="warning">
            You are signed in with a temporary password. Choose your own before continuing.
          </Alert>
        )}
        {error && <Alert tone="error">{error}</Alert>}

        <Field label={forced ? 'Temporary password' : 'Current password'}>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={form.currentPassword}
            onChange={set('currentPassword')}
          />
        </Field>

        <Field
          label="New password"
          hint="At least 8 characters, including a letter and a number."
          error={
            problems.length
              ? `Must contain ${listify(problems)}`
              : sameAsOld
                ? 'Must differ from your current password'
                : undefined
          }
        >
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={form.newPassword}
            onChange={set('newPassword')}
            aria-invalid={problems.length > 0 || sameAsOld}
          />
        </Field>

        <Field label="Confirm new password" error={mismatch ? 'The two passwords do not match' : undefined}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={set('confirmPassword')}
            aria-invalid={mismatch}
          />
        </Field>
      </form>
    </Modal>
  );
}
