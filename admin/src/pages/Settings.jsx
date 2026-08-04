import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Field, Flash, Toggle, useFlash } from '../components/ui';

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

  function set(field, value) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  async function loadGroups() {
    setLoadingGroups(true);
    try {
      const { groups: list } = await api.groups();
      setGroups(list);
    } catch (err) {
      setFlash({
        ok: false,
        message: err.message === 'whatsapp_not_ready' ? 'WhatsApp is not connected yet.' : err.message,
      });
    } finally {
      setLoadingGroups(false);
    }
  }

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
        title="The door group"
        hint="Commands are only accepted in this one group. Messages anywhere else are ignored."
        actions={
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={loadGroups}
            disabled={loadingGroups || !waReady}
          >
            {loadingGroups ? 'Loading…' : 'Load groups'}
          </button>
        }
      >
        {groups ? (
          <Field label="Group">
            <select
              className="select"
              value={draft.groupId || ''}
              onChange={(e) => {
                const group = groups.find((g) => g.id === e.target.value);
                setDraft((d) => ({ ...d, groupId: group?.id || '', groupName: group?.name || '' }));
              }}
            >
              <option value="">— none selected —</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.participantCount ?? '?'} people)
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Group id" hint="Load the group list to pick one, or paste an id directly.">
            <input
              className="input mono"
              placeholder="1203630xxxxxxxxxx@g.us"
              value={draft.groupId || ''}
              onChange={(e) => set('groupId', e.target.value)}
            />
          </Field>
        )}
        {draft.groupName && <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Currently: {draft.groupName}</p>}
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
