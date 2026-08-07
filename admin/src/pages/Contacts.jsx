import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Card, Empty, Field, Flash, useFlash } from '../components/ui';
import { makeSearch } from '../lib/search';

// The contact list of the linked WhatsApp account. This is the enrolment path
// for someone who is in no group at all - a member who only ever DMs the bot.
//
// An account can hold thousands of contacts, so the list is fetched once
// (cached server-side), filtered here, and rendered a page at a time.
const PAGE_SIZE = 200;

export default function Contacts({ waReady }) {
  const [contacts, setContacts] = useState(null);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [savedOnly, setSavedOnly] = useState(true);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [flash, setFlash] = useFlash();

  async function loadContacts({ refresh = false, silent = false } = {}) {
    setLoading(true);
    try {
      const { contacts: list } = await api.contacts({ refresh });
      setContacts(list);
      if (!silent) setFlash({ ok: true, message: `${list.length} contacts loaded.` });
    } catch (err) {
      if (!silent) setFlash({ ok: false, message: err.message });
    } finally {
      setLoading(false);
    }
  }

  async function loadMembers() {
    try {
      const { members: list } = await api.members();
      setMembers(list);
    } catch {
      // The list still works without it; rows just won't show who is enrolled.
    }
  }

  useEffect(() => {
    loadMembers();
  }, []);

  // Fetch as soon as WhatsApp is up, so the page is populated rather than
  // showing a button that has to be found.
  useEffect(() => {
    if (waReady && !contacts && !loading) loadContacts({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waReady]);

  const byIdentity = useMemo(() => {
    const map = new Map();
    for (const m of members) {
      if (m.waId) map.set(m.waId, m);
      if (m.lid) map.set(m.lid, m);
      if (m.phone) map.set(m.phone, m);
    }
    return map;
  }, [members]);

  const filtered = useMemo(() => {
    const search = makeSearch(query);
    return (contacts || []).filter((c) => {
      if (savedOnly && !c.isMyContact) return false;
      if (!search.active) return true;
      return search.matches([c.name, c.pushname, c.shortName, c.waId], [c.phone, c.waId]);
    });
  }, [contacts, query, savedOnly]);

  // Reset paging whenever the result set changes under it.
  useEffect(() => setLimit(PAGE_SIZE), [query, savedOnly, contacts]);

  async function allow(contact) {
    try {
      await api.addMember({
        waId: contact.waId,
        lid: contact.lid,
        phone: contact.phone,
        displayName: contact.name || contact.pushname || contact.shortName || '',
      });
      setFlash({ ok: true, message: `${contact.label} can open the door.` });
      loadMembers();
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    }
  }

  const shown = filtered.slice(0, limit);

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Contacts</h1>
        <p>Everyone the linked WhatsApp account knows. Add any of them to the whitelist.</p>
      </div>

      <Flash flash={flash} />

      <Card
        title={contacts ? `${filtered.length} of ${contacts.length} contacts` : 'From the linked phone'}
        hint="Synced from the linked phone. Someone saved a moment ago may not appear until WhatsApp syncs — Refresh re-reads the list."
        actions={
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => loadContacts({ refresh: true })}
            disabled={loading || !waReady}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        }
      >
        {!waReady && <Empty>Connect WhatsApp first — the contact list comes from the phone.</Empty>}

        {waReady && (
          <>
            <div className="row" style={{ marginBottom: 'var(--sp-4)', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 240px' }}>
                <Field label="Search">
                  <input
                    className="input"
                    placeholder="Name or number — 0549… works too"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </Field>
              </div>
              <label className="row" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-4)' }}>
                <input
                  type="checkbox"
                  checked={savedOnly}
                  onChange={(e) => setSavedOnly(e.target.checked)}
                />
                <span>Saved contacts only</span>
              </label>
            </div>

            {contacts && filtered.length === 0 && (
              <Empty>
                {contacts.length === 0
                  ? 'No contacts synced yet.'
                  : savedOnly
                    ? 'Nothing matches. Untick “saved contacts only” to include people this account has just chatted with.'
                    : 'Nothing matches that search.'}
              </Empty>
            )}

            {shown.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Phone</th>
                      <th>WhatsApp id</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((c) => {
                      const known =
                        byIdentity.get(c.waId) || byIdentity.get(c.lid) || byIdentity.get(c.phone);
                      return (
                        <tr key={c.waId}>
                          <td data-label="Name">
                            {c.label}
                            {c.isBusiness && <span className="muted"> · business</span>}
                            {c.isBlocked && <span className="muted"> · blocked</span>}
                          </td>
                          <td data-label="Phone">
                            {c.phone ? `+${c.phone}` : <span className="muted">hidden (LID)</span>}
                          </td>
                          <td className="mono" data-label="WhatsApp id">{c.waId}</td>
                          <td style={{ textAlign: 'right' }}>
                            {known ? (
                              <span className="chip chip--granted">
                                <span className="seed seed--granted" />
                                {known.enabled ? 'Allowed' : 'Disabled'}
                              </span>
                            ) : (
                              <button className="btn btn--sm" onClick={() => allow(c)}>
                                Allow
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {filtered.length > shown.length && (
              <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setLimit((l) => l + PAGE_SIZE)}
                >
                  Show more
                </button>
                <span className="muted">
                  showing {shown.length} of {filtered.length}
                </span>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
