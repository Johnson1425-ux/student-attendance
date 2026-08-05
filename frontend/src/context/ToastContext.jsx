import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const ToastContext = createContext(null);

/**
 * Transient feedback for actions that succeed or fail. Errors linger longer
 * than successes — a member of staff needs time to read why a correction was
 * rejected, but not to be told it worked.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message, tone = 'info', duration) => {
      const id = nextId.current++;
      const ttl = duration ?? (tone === 'error' ? 8000 : 4000);
      setToasts((current) => [...current, { id, message, tone }]);
      setTimeout(() => dismiss(id), ttl);
      return id;
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({
      push,
      dismiss,
      success: (message) => push(message, 'success'),
      error: (messageOrError) =>
        push(
          typeof messageOrError === 'string'
            ? messageOrError
            : (messageOrError?.message ?? 'Something went wrong'),
          'error',
        ),
      info: (message) => push(message, 'info'),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            <span className="flex-1">{toast.message}</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => dismiss(toast.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
