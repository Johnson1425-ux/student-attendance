import { useEffect, useRef } from 'react';
import { STATUS_LABELS, formatPercent, rateTone } from '../utils/format.js';

/**
 * Small presentational building blocks shared by every screen. Keeping them in
 * one file makes the visual vocabulary of the dashboard easy to see and hard to
 * accidentally fork.
 */

export function Card({ title, subtitle, actions, children, flush = false, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card__header">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, color }) {
  return (
    <div className="stat" style={color ? { '--stat-color': color } : undefined}>
      <p className="stat__label">{label}</p>
      <p className="stat__value">{value}</p>
      {hint && <p className="stat__hint">{hint}</p>}
    </div>
  );
}

export function StatusBadge({ status }) {
  const key = status ?? 'not_marked';
  return (
    <span className={`badge badge--${key}`}>
      <span className="badge__dot" aria-hidden="true" />
      {STATUS_LABELS[key] ?? key}
    </span>
  );
}

export function RateMeter({ rate, showValue = true }) {
  const value = Number(rate ?? 0);
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className="meter flex-1" style={{ minWidth: 60 }}>
        <div className={`meter__fill meter__fill--${rateTone(value)}`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
      {showValue && (
        <span className="nums small strong" style={{ minWidth: 46, textAlign: 'right' }}>
          {formatPercent(value)}
        </span>
      )}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="loading">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, description, action }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {description && <p className="small">{description}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="empty">
      <p className="empty__title">Could not load this</p>
      <p className="small">{error?.message ?? 'Unexpected error'}</p>
      {onRetry && (
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function Field({ label, hint, error, children, full = false }) {
  return (
    <div className={`field ${full ? 'form-grid--full' : ''}`}>
      {label && <label className="field__label">{label}</label>}
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

/**
 * Modal dialog. Closes on Escape and on a backdrop click, and moves focus
 * inside on open so keyboard users are not left behind the overlay.
 */
export function Modal({ title, onClose, children, footer, size = '', dismissible = true }) {
  const ref = useRef(null);
  // Both are read from inside a mount-only effect, so they live in a ref rather
  // than in the dependency array.
  const latest = useRef({ onClose, dismissible });

  useEffect(() => {
    latest.current = { onClose, dismissible };
  });

  const requestClose = () => {
    if (latest.current.dismissible) latest.current.onClose();
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && latest.current.dismissible) latest.current.onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previouslyFocused = document.activeElement;
    ref.current?.querySelector('input, select, textarea, button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
    // Mount and unmount only. Every caller passes an inline arrow for onClose,
    // so its identity changes on each render — and each keystroke re-renders
    // the page holding the form state. Depending on it here re-ran this effect
    // mid-typing: the cleanup handed focus back to the button that opened the
    // modal, and the effect then bounced it to the first field, so only the
    // first character of anything typed survived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div className={`modal ${size ? `modal--${size}` : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal__header">
          <h2 className="modal__title flex-1">{title}</h2>
          {dismissible && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'Confirm', tone = 'primary', onConfirm, onClose, busy }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`btn btn--${tone}`} onClick={onConfirm} disabled={busy}>
            {busy ? <Spinner /> : confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}

export function Pagination({ pagination, onChange }) {
  if (!pagination || pagination.total === 0) return null;
  const { page, pageSize, total, totalPages } = pagination;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="pagination">
      <span>
        Showing <strong>{first}</strong>–<strong>{last}</strong> of <strong>{total}</strong>
      </span>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn btn--sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Previous
        </button>
        <span className="small nums">
          {page} / {totalPages || 1}
        </span>
        <button type="button" className="btn btn--sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

export function Alert({ tone = 'info', children }) {
  return <div className={`alert alert--${tone}`}>{children}</div>;
}

export function HealthIndicator({ health, label }) {
  const labels = {
    online: 'Online',
    delayed: 'Delayed',
    offline: 'Offline',
    never_connected: 'Never connected',
  };
  return (
    <span className={`health health--${health}`}>
      <span className="health__dot" aria-hidden="true" />
      {label ?? labels[health] ?? health}
    </span>
  );
}
