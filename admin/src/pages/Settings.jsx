import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Empty, Field, Flash, Toggle, useFlash } from '../components/ui';

export default function Settings({ settings, doors, onSaved, waReady }) {
  const [draft, setDraft] = useState(settings);
  const [groups, setGroups] = useState(null);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [keywordText, setKeywordText] = useState((settings.commandKeywords || []).join(', '));
  const [flash, setFlash] = useFlash();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(settings);
    setKeywordText((settings.commandKeywords || []).join(', '));
  }, [settings]);

  const [manualGroup, setManualGroup] = useState('');
  const listened = draft.groups || [];

  function set(field, value) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  function addGroup(group) {
    setDraft((d) => {
      if ((d.groups || []).some((g) => g.id === group.id)) return d;
      return { ...d, groups: [...(d.groups || []), group] };
    });
  }

  function setGroup(id, patch) {
    setDraft((d) => ({
      ...d,
      groups: (d.groups || []).map((g) => (g.id === id ? { ...g, ...patch } : g)),
    }));
  }

  function removeGroup(id) {
    setDraft((d) => ({ ...d, groups: (d.groups || []).filter((g) => g.id !== id) }));
  }

  async function loadGroups({ silent = false } = {}) {
    setLoadingGroups(true);
    try {
      const { groups: list } = await api.groups();
      setGroups(list);
      // Refresh names of groups we already listen to, so a renamed group stops
      // showing its old label (or "Unnamed group" if it was added by id).
      setDraft((d) => ({
        ...d,
        groups: (d.groups || []).map((g) => {
          const live = list.find((l) => l.id === g.id);
          return live ? { ...g, name: live.name } : g;
        }),
      }));
    } catch (err) {
      // The automatic load is best-effort - don't nag with an error banner the
      // admin didn't ask for. The manual button still reports failures.
      if (!silent) {
        setFlash({
          ok: false,
          message:
            err.message === 'whatsapp_not_ready' ? 'WhatsApp is not connected yet.' : err.message,
        });
      }
    } finally {
      setLoadingGroups(false);
    }
  }

  // Populate the picker as soon as WhatsApp is ready, so the group list is
  // simply there rather than behind a button.
  useEffect(() => {
    if (waReady && !groups && !loadingGroups) loadGroups({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waReady]);

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const patch = {
        ...draft,
        commandKeywords: keywordText.split(',').map((k) => k.trim()).filter(Boolean),
      };
      const { settings: saved } = await api.saveSettings(patch);
      onSaved(saved);
      setFlash({ ok: true, message: 'Saved. Takes effect on the next message.' });
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    } finally {
      setSaving(false);
    }
  }

  const doorsEnabled = draft.doorsEnabled || {};

  return (
    <form className="stack" onSubmit={save}>
      <div className="page-head">
        <h1>Settings</h1>
        <p>How the bot listens and what it will do.</p>
      </div>

      <Flash flash={flash} />

      <Card
        title="Groups the bot listens in"
        hint="Commands are only accepted in these groups. Messages anywhere else are ignored."
        actions={
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => loadGroups()}
            disabled={loadingGroups || !waReady}
          >
            {loadingGroups ? 'Loading…' : 'Refresh list'}
          </button>
        }
      >
        {listened.length === 0 ? (
          <Empty>Not listening anywhere yet — no command will do anything.</Empty>
        ) : (
          <div className="stack" style={{ marginBottom: 'var(--sp-4)' }}>
            {listened.map((group) => (
              <div className="spread" key={group.id}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{group.name || 'Unnamed group'}</div>
                  <div className="mono">{group.id}</div>
                </div>
                <div className="row">
                  <Toggle
                    checked={group.enabled}
                    label={`Listen in ${group.name || group.id}`}
                    onChange={(v) => setGroup(group.id, { enabled: v })}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => removeGroup(group.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {groups?.length > 0 && (
          <Field label="Add a group" hint="Only groups the bot's number is a member of appear here.">
            <select
              className="select"
              value=""
              onChange={(e) => {
                const group = groups.find((g) => g.id === e.target.value);
                if (group) addGroup({ id: group.id, name: group.name, enabled: true });
              }}
            >
              <option value="">— pick a group to add —</option>
              {groups
                .filter((g) => !listened.some((l) => l.id === g.id))
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.participantCount ?? '?'} people)
                  </option>
                ))}
            </select>
          </Field>
        )}

        {/* Also shown when the list came back empty, so an empty dropdown is
            never a dead end. */}
        {!groups?.length && (
          <Field
            label={groups ? 'Add a group by id' : 'Or paste a group id'}
            hint={
              groups
                ? 'No groups found for this number. Paste an id ending in @g.us, or send a message in the group and hit Refresh.'
                : waReady
                  ? 'Ends with @g.us. The list above is easier — hit Refresh.'
                  : 'The group list appears automatically once WhatsApp is connected.'
            }
          >
            <div className="row">
              <input
                className="input mono"
                style={{ flex: '1 1 240px' }}
                placeholder="1203630xxxxxxxxxx@g.us"
                value={manualGroup}
                onChange={(e) => setManualGroup(e.target.value)}
              />
              <button
                type="button"
                className="btn btn--sm"
                disabled={!manualGroup.trim().endsWith('@g.us')}
                onClick={() => {
                  addGroup({ id: manualGroup.trim(), name: '', enabled: true });
                  setManualGroup('');
                }}
              >
                Add
              </button>
            </div>
          </Field>
        )}
      </Card>

      <Card title="Commands" hint="A message counts as a command when it starts with one of these words.">
        <Field label="Keywords" hint="Comma separated. Case and accents are ignored.">
          <input
            className="input"
            value={keywordText}
            onChange={(e) => setKeywordText(e.target.value)}
          />
        </Field>

        <div className="grid-2">
          <Field label="Default door">
            <select className="select" value={draft.defaultDoor} onChange={(e) => set('defaultDoor', e.target.value)}>
              {doors.map((d) => (
                <option key={d.key} value={d.key}>{d.label}</option>
              ))}
            </select>
          </Field>

          <Field label="How the bot answers">
            <select className="select" value={draft.replyMode} onChange={(e) => set('replyMode', e.target.value)}>
              <option value="react">Emoji reaction only (quiet)</option>
              <option value="text">Text reply</option>
              <option value="both">Both</option>
            </select>
          </Field>
        </div>
      </Card>

      <Card title="Limits" hint="Guard rails against spam and against replayed messages after a reconnect.">
        <div className="grid-2">
          <Field label="Opens per person per minute">
            <input
              className="input"
              type="number"
              min="1"
              value={draft.rateLimitPerUserPerMin}
              onChange={(e) => set('rateLimitPerUserPerMin', Number(e.target.value))}
            />
          </Field>
          <Field label="Opens overall per minute">
            <input
              className="input"
              type="number"
              min="1"
              value={draft.rateLimitGlobalPerMin}
              onChange={(e) => set('rateLimitGlobalPerMin', Number(e.target.value))}
            />
          </Field>
          <Field
            label="Ignore commands older than (seconds)"
            hint="Stops a backlog of old messages firing the relay after a restart."
          >
            <input
              className="input"
              type="number"
              min="10"
              value={draft.maxMessageAgeSec}
              onChange={(e) => set('maxMessageAgeSec', Number(e.target.value))}
            />
          </Field>
          <Field label="Relay pulse (ms)" hint="How long the relay is held closed. The physical door expects ~1000.">
            <input
              className="input"
              type="number"
              min="100"
              value={draft.relayPulseMs}
              onChange={(e) => set('relayPulseMs', Number(e.target.value))}
            />
          </Field>
        </div>
      </Card>

      <Card title="Doors">
        <div className="stack">
          {doors.map((door) => (
            <div className="spread" key={door.key}>
              <div>
                <div style={{ fontWeight: 600 }}>{door.label}</div>
                <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                  {door.configured ? door.key : 'not configured in .env'}
                </div>
              </div>
              <Toggle
                checked={doorsEnabled[door.key] !== false}
                disabled={!door.configured}
                label={`Enable ${door.label}`}
                onChange={(v) => set('doorsEnabled', { ...doorsEnabled, [door.key]: v })}
              />
            </div>
          ))}
        </div>
      </Card>

      <div className="row">
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}
