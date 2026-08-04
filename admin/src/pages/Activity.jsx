import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, DecisionChip, Empty, formatDateTime } from '../components/ui';

const FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'granted', label: 'Opened' },
  { value: 'denied', label: 'Denied' },
  { value: 'error', label: 'Failed' },
];

export default function Activity() {
  const [data, setData] = useState(null);
  const [decision, setDecision] = useState('');
  const [actor, setActor] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page };
      if (decision) params.decision = decision;
      if (actor.trim()) params.actor = actor.trim();
      setData(await api.logs(params));
    } finally {
      setLoading(false);
    }
  }, [decision, actor, page]);

  useEffect(() => {
    // Debounced so typing in the actor box doesn't hammer the API.
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  // Any filter change resets to the first page - otherwise you land on an
  // empty page 4 of a 2-page result.
  useEffect(() => {
    setPage(1);
  }, [decision, actor]);

  const counts = data?.counts || {};

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Activity</h1>
        <p>Every door attempt, granted or not.</p>
      </div>

      <div className="grid-2">
        <Card>
          <div className="stat">
            <span className="stat__value" style={{ color: 'var(--clr-granted)' }}>{counts.granted || 0}</span>
            <span className="stat__label">Opened</span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="stat__value" style={{ color: 'var(--clr-denied)' }}>{counts.denied || 0}</span>
            <span className="stat__label">Denied</span>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <span className="stat__value" style={{ color: 'var(--clr-pending)' }}>{counts.error || 0}</span>
            <span className="stat__label">Failed</span>
          </div>
        </Card>
      </div>

      <Card
        actions={
          <input
            className="input"
            style={{ width: 'auto', minWidth: '200px' }}
            placeholder="Filter by person…"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          />
        }
        title="Log"
      >
        <div className="row" style={{ marginBottom: 'var(--sp-4)' }}>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              className={`chip chip--button ${decision === f.value ? 'chip--active' : ''}`}
              onClick={() => setDecision(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {loading && !data ? (
          <Empty>Loading…</Empty>
        ) : !data?.entries.length ? (
          <Empty>Nothing here yet.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Result</th>
                    <th>Who</th>
                    <th>Door</th>
                    <th>Command</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((entry) => (
                    <tr key={entry._id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(entry.at)}</td>
                      <td>
                        <div className="row" style={{ gap: 'var(--sp-2)' }}>
                          <DecisionChip decision={entry.decision} />
                          {entry.simulated && (
                            <span className="chip chip--error" title="Test mode — the door did not open">
                              🧪 test
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <div>{entry.actorName || <span className="muted">Unknown</span>}</div>
                        <div className="mono">
                          {entry.actorPhone ? `+${entry.actorPhone}` : entry.actorWaId || '—'}
                        </div>
                      </td>
                      <td>{entry.door || '—'}</td>
                      <td className="mono">{entry.command || '—'}</td>
                      <td className="muted">
                        {entry.reason || (entry.durationMs != null ? `${entry.durationMs}ms` : '—')}
                        {entry.source === 'panel' && (
                          <span className="chip" style={{ marginLeft: 'var(--sp-2)' }}>panel</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="spread" style={{ marginTop: 'var(--sp-4)' }}>
              <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                {data.total} entries · page {data.page} of {data.pages}
              </span>
              <div className="row">
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={data.page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  disabled={data.page >= data.pages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
