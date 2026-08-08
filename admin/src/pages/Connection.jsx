import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, DoorStatus, Flash, useFlash, formatDateTime } from '../components/ui';

const STATUS_COPY = {
  starting: { label: 'Starting up', seed: 'pending', hint: 'Booting the WhatsApp client…' },
  qr: { label: 'Waiting for scan', seed: 'pending', hint: 'Scan the code with the bot phone.' },
  authenticated: { label: 'Authenticated', seed: 'pending', hint: 'Loading chats…' },
  ready: { label: 'Connected', seed: 'granted', hint: 'Listening for door commands.' },
  disconnected: { label: 'Disconnected', seed: 'denied', hint: 'Reconnecting automatically…' },
  auth_failure: { label: 'Auth failed', seed: 'denied', hint: 'Re-link the number below.' },
};

export default function Connection({ state, doors, offlineDoors }) {
  const [flash, setFlash] = useFlash();
  const [busyDoor, setBusyDoor] = useState(null);
  const [unlinking, setUnlinking] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  useEffect(() => {
    if (!confirmUnlink) return undefined;
    const t = setTimeout(() => setConfirmUnlink(false), 6000);
    return () => clearTimeout(t);
  }, [confirmUnlink]);

  const copy = STATUS_COPY[state.status] || STATUS_COPY.starting;

  async function openDoor(key) {
    setBusyDoor(key);
    try {
      await api.openDoor(key);
      setFlash({ ok: true, message: 'Door opened.' });
    } catch (err) {
      setFlash({ ok: false, message: `Could not open: ${err.message}` });
    } finally {
      setBusyDoor(null);
    }
  }

  async function unlink() {
    if (!confirmUnlink) {
      setConfirmUnlink(true);
      return;
    }
    setConfirmUnlink(false);
    setUnlinking(true);
    try {
      await api.unlinkWhatsApp();
      setFlash({ ok: true, message: 'Unlinked. A new QR code will appear shortly.' });
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    } finally {
      setUnlinking(false);
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Connection</h1>
        <p>The WhatsApp account the bot listens with.</p>
      </div>

      <Flash flash={flash} />

      <Card>
        <div className="qr-panel">
          <div className="qr-frame">
            {state.qrDataUrl ? (
              <img src={state.qrDataUrl} alt="WhatsApp linking QR code" />
            ) : (
              <p className="qr-frame__placeholder">
                {state.status === 'ready'
                  ? 'Linked — no code needed.'
                  : 'Waiting for a code…'}
              </p>
            )}
          </div>

          <div className="stack">
            <div className="row">
              <span className={`seed seed--${copy.seed} ${state.status === 'ready' ? '' : 'seed--pulsing'}`} />
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-lg)' }}>
                  {copy.label}
                </div>
                <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                  {copy.hint}
                </div>
              </div>
            </div>

            <dl className="status-list">
              <div>
                <dt>Linked number</dt>
                <dd>{state.me?.phone ? `+${state.me.phone}` : '—'}</dd>
              </div>
              <div>
                <dt>Account name</dt>
                <dd>{state.me?.pushname || '—'}</dd>
              </div>
              <div>
                <dt>Ready since</dt>
                <dd>{formatDateTime(state.lastReadyAt)}</dd>
              </div>
              <div>
                <dt>Session backed up</dt>
                <dd>{formatDateTime(state.lastSessionSavedAt)}</dd>
              </div>
            </dl>

            {/*
              RemoteAuth waits 60s after the first authentication before writing
              the session to Mongo. Restarting inside that window loses the link
              silently, so it needs to be visible rather than inferred.
            */}
            {state.status === 'ready' && !state.sessionBackedUp && (
              <div className="banner">
                Linked, but the session is not saved to the database yet — this takes about a
                minute. If the service restarts before then, you will have to scan again.
              </div>
            )}

            {state.lastError && <div className="banner">{state.lastError}</div>}

            <div className="row">
              <button
                className={`btn ${confirmUnlink ? 'btn--danger' : 'btn--ghost'}`}
                onClick={unlink}
                disabled={unlinking}
              >
                {unlinking
                  ? 'Unlinking…'
                  : confirmUnlink
                    ? 'Really unlink?'
                    : 'Unlink this number'}
              </button>
              {confirmUnlink && (
                <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                  This wipes the saved session — you will need to scan again.
                </span>
              )}
            </div>
          </div>
        </div>
      </Card>

      <Card title="Open a door" hint="Manual override. Logged the same as a WhatsApp command.">
        {/* The status sits under its own button rather than in a banner: the
            useful moment for it is right before deciding to press. */}
        <div className="row" style={{ alignItems: 'flex-start' }}>
          {doors.map((door) => (
            <div className="stack" key={door.key} style={{ gap: 'var(--sp-2)' }}>
              <button
                className="btn"
                disabled={!door.configured || !door.enabled || busyDoor === door.key}
                onClick={() => openDoor(door.key)}
              >
                {busyDoor === door.key ? 'Opening…' : door.label}
              </button>
              <DoorStatus door={door} offline={offlineDoors?.has(door.key)} />
            </div>
          ))}
          {doors.length === 0 && <span className="muted">No doors configured.</span>}
        </div>
      </Card>
    </div>
  );
}
