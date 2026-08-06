import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Card, Empty, Field, Flash, Toggle, useFlash, formatDateTime } from '../components/ui';
import { makeSearch } from '../lib/search';
import { previewPhone } from '../lib/phone';

// Enrolment happens from the group's own participant list wherever possible:
// picking someone off that list captures the exact `waId` the bot will see on
// their messages, which typing a phone number cannot guarantee under WhatsApp's
// LID addressing.
export default function Members({ settings }) {
  const [members, setMembers] = useState([]);
  const [participants, setParticipants] = useState(null);
  const [loadingParticipants, setLoadingParticipants] = useState(false);
  const [flash, setFlash] = useFlash();
  const [manual, setManual] = useState({ phone: '', displayName: '' });
  const [query, setQuery] = useState('');

  const groups = settings?.groups || [];
  const countryCode = settings?.defaultCountryCode || '213';
  const [selectedGroup, setSelectedGroup] = useState(groups[0]?.id || '');

  // What the server will actually store - shown before saving, so a mistyped
  // number is obvious while it can still be fixed.
  const normalizedManual = previewPhone(manual.phone, countryCode);

  // Keep the picker valid when Settings adds or removes groups.
  useEffect(() => {
    if (groups.length === 0) {
      setSelectedGroup('');
    } else if (!groups.some((g) => g.id === selectedGroup)) {
      setSelectedGroup(groups[0].id);
    }
  }, [groups, selectedGroup]);

  async function loadMembers() {
    try {
      const { members: list } = await api.members();
      setMembers(list);
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    }
  }

  useEffect(() => {
    loadMembers();
  }, []);

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
    if (!search.active) return members;
    // Numbers match however they were typed: "0549…" finds a stored "213549…".
    return members.filter((m) =>
      search.matches([m.displayName, m.phone, m.waId, m.note], [m.phone, m.waId])
    );
  }, [members, query]);

  async function loadParticipants(groupId = selectedGroup) {
    if (!groupId) {
      setFlash({ ok: false, message: 'Add a group in Settings first.' });
      return;
    }
    setLoadingParticipants(true);
    try {
      const { participants: list } = await api.participants(groupId);
      setParticipants(list);
    } catch (err) {
      setFlash({
        ok: false,
        message:
          err.message === 'whatsapp_not_ready'
            ? 'WhatsApp is not connected yet.'
            : err.message,
      });
    } finally {
      setLoadingParticipants(false);
    }
  }

  async function allow(participant) {
    try {
      await api.addMember({
        waId: participant.waId,
        lid: participant.lid,
        phone: participant.phone,
        displayName: participant.name,
      });
      setFlash({ ok: true, message: `${participant.name || participant.waId} can open the door.` });
      loadMembers();
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    }
  }

  async function addManual(event) {
    event.preventDefault();
    try {
      await api.addMember(manual);
      setManual({ phone: '', displayName: '' });
      setFlash({ ok: true, message: 'Member added.' });
      loadMembers();
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    }
  }

  async function toggleMember(member, enabled) {
    setMembers((prev) => prev.map((m) => (m._id === member._id ? { ...m, enabled } : m)));
    try {
      await api.updateMember(member._id, { enabled });
    } catch (err) {
      setFlash({ ok: false, message: err.message });
      loadMembers();
    }
  }

  async function removeMember(member) {
    try {
      await api.deleteMember(member._id);
      setFlash({ ok: true, message: 'Member removed.' });
      loadMembers();
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Members</h1>
        <p>Who is allowed to open the door.</p>
      </div>

      <Flash flash={flash} />

      <Card
        title="From the group"
        hint="Enrol people straight off the participant list — that captures the exact WhatsApp id the bot will see."
        actions={
          <div className="row">
            {groups.length > 1 && (
              <select
                className="select"
                style={{ width: 'auto', minWidth: '180px' }}
                value={selectedGroup}
                onChange={(e) => {
                  setSelectedGroup(e.target.value);
                  setParticipants(null);
                }}
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name || g.id}
                  </option>
                ))}
              </select>
            )}
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => loadParticipants()}
              disabled={loadingParticipants || !selectedGroup}
            >
              {loadingParticipants ? 'Loading…' : participants ? 'Refresh' : 'Load participants'}
            </button>
          </div>
        }
      >
        {!participants && (
          <Empty>
            {groups.length === 0
              ? 'No groups configured yet — add one in Settings.'
              : 'Load the group to see who is in it.'}
          </Empty>
        )}
        {participants && participants.length === 0 && <Empty>That group has no participants.</Empty>}
        {participants && participants.length > 0 && (
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
                {participants.map((p) => {
                  const known = byIdentity.get(p.waId) || byIdentity.get(p.lid) || byIdentity.get(p.phone);
                  return (
                    <tr key={p.waId}>
                      <td>{p.name || <span className="muted">—</span>}</td>
                      <td>{p.phone ? `+${p.phone}` : <span className="muted">hidden (LID)</span>}</td>
                      <td className="mono">{p.waId}</td>
                      <td style={{ textAlign: 'right' }}>
                        {known ? (
                          <span className="chip chip--granted">
                            <span className="seed seed--granted" />
                            {known.enabled ? 'Allowed' : 'Disabled'}
                          </span>
                        ) : (
                          <button className="btn btn--sm" onClick={() => allow(p)}>
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
      </Card>

      <Card
        title="Add by phone number"
        hint={`For someone not in any group. Local (0…) or international (+${countryCode}…) — both work.`}
      >
        <form className="row" onSubmit={addManual} style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 200px' }}>
            <Field
              label="Phone number"
              hint={
                manual.phone.trim()
                  ? normalizedManual
                    ? `Saved as +${normalizedManual}`
                    : "That doesn't look like a phone number"
                  : undefined
              }
            >
              <input
                className="input"
                placeholder="0549212025"
                value={manual.phone}
                onChange={(e) => setManual({ ...manual, phone: e.target.value })}
              />
            </Field>
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <Field label="Name">
              <input
                className="input"
                placeholder="Amina"
                value={manual.displayName}
                onChange={(e) => setManual({ ...manual, displayName: e.target.value })}
              />
            </Field>
          </div>
          <button
            className="btn"
            type="submit"
            disabled={!normalizedManual}
            style={{ marginBottom: 'var(--sp-4)' }}
          >
            Add
          </button>
        </form>
      </Card>

      <Card
        title={`Allowed members (${members.filter((m) => m.enabled).length}/${members.length})`}
        actions={
          <input
            className="input"
            style={{ width: 'auto', minWidth: '200px' }}
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
      >
        {filtered.length === 0 ? (
          <Empty>{members.length === 0 ? 'Nobody can open the door yet.' : 'No match.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Allowed</th>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>WhatsApp id</th>
                  <th>Last open</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((member) => (
                  <tr key={member._id}>
                    <td>
                      <Toggle
                        checked={member.enabled}
                        onChange={(v) => toggleMember(member, v)}
                        label={`Allow ${member.displayName || member.phone}`}
                      />
                    </td>
                    <td>{member.displayName || <span className="muted">—</span>}</td>
                    <td>{member.phone ? `+${member.phone}` : <span className="muted">—</span>}</td>
                    <td className="mono">{member.waId || member.lid}</td>
                    <td className="muted">{formatDateTime(member.lastOpenedAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn--ghost btn--sm" onClick={() => removeMember(member)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
