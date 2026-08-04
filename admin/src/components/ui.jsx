import { useEffect, useState } from 'react';

export function Card({ title, hint, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="spread" style={{ marginBottom: 'var(--sp-4)' }}>
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {hint && <p className="card__hint" style={{ margin: 0 }}>{hint}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Toggle({ checked, onChange, disabled, label }) {
  return (
    <label className="toggle" aria-label={label}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle__track" />
    </label>
  );
}

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      <label className="field__label">{label}</label>
      {children}
      {hint && (
        <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}

const DECISION_CLASS = { granted: 'chip--granted', denied: 'chip--denied', error: 'chip--error' };
const DECISION_LABEL = { granted: 'Opened', denied: 'Denied', error: 'Failed' };

export function DecisionChip({ decision }) {
  return (
    <span className={`chip ${DECISION_CLASS[decision] || ''}`}>
      <span className={`seed seed--${decision === 'error' ? 'pending' : decision}`} />
      {DECISION_LABEL[decision] || decision}
    </span>
  );
}

/** Transient success/error line that clears itself. */
export function useFlash(timeout = 4000) {
  const [flash, setFlash] = useState(null);
  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(null), timeout);
    return () => clearTimeout(t);
  }, [flash, timeout]);
  return [flash, setFlash];
}

export function Flash({ flash }) {
  if (!flash) return null;
  return <div className={`banner ${flash.ok ? 'banner--ok' : ''}`}>{flash.message}</div>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
