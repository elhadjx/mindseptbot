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

const DOOR_STATUS = {
  online: { seed: 'seed--granted', label: 'Online' },
  offline: { seed: 'seed--denied', label: 'Not responding' },
  unknown: { seed: 'seed--pending', label: 'Status unknown' },
  unconfigured: { seed: '', label: 'Not configured' },
};

/**
 * Two things claim to know whether a door is up, and they can disagree.
 *
 * `door.online` is Tuya's heartbeat flag, read when the panel last asked. It
 * lags reality by minutes in both directions (see door-service.js), so it is
 * the weaker witness. `offline` is the live latch from /api/doors/stream - a
 * door that actually refused to open. A confirmed failure wins over a
 * heartbeat that may simply not have arrived yet, so it is checked first.
 */
export function doorState(door, offline = false) {
  if (!door.configured) return 'unconfigured';
  if (offline || door.online === false) return 'offline';
  if (door.online === true) return 'online';
  // null: the probe itself failed. Not the same as offline, and never shown as
  // one - a hiccup talking to Tuya would otherwise read as a dead door.
  return 'unknown';
}

/** Seed dot + word for a door's reachability. */
export function DoorStatus({ door, offline = false }) {
  const { seed, label } = DOOR_STATUS[doorState(door, offline)];
  return (
    <span className="row" style={{ gap: 'var(--sp-2)', fontSize: 'var(--fs-xs)' }}>
      <span className={`seed ${seed}`} />
      <span className="muted">{label}</span>
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

/** Clock time alone - for something that happened within this sitting. */
export function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
