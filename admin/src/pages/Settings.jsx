import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, DoorStatus, Empty, Field, Flash, Toggle, formatTime, useFlash } from '../components/ui';
import {
  currentSubscription,
  disablePush,
  enablePush,
  iosNeedsInstall,
  pushSupported,
} from '../lib/push';

export default function Settings({
  settings,
  doors,
  doorsCheckedAt,
  offlineDoors,
  onRefreshDoors,
  onSaved,
  waReady,
}) {
  const [draft, setDraft] = useState(settings);
  const [groups, setGroups] = useState(null);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [keywordText, setKeywordText] = useState((settings.commandKeywords || []).join(', '));
  const [flash, setFlash] = useFlash();
  const [aiFlash, setAiFlash] = useFlash();
  const [saving, setSaving] = useState(false);
  const [aiCredentials, setAiCredentials] = useState(null);
  const [aiKeys, setAiKeys] = useState({ openai: '', gemini: '' });
  const [aiCurrentPassword, setAiCurrentPassword] = useState('');
  const [aiBusy, setAiBusy] = useState('');

  useEffect(() => {
    setDraft(settings);
    setKeywordText((settings.commandKeywords || []).join(', '));
  }, [settings]);

  useEffect(() => {
    api
      .aiCredentials()
      .then((result) => setAiCredentials(result.providers))
      .catch((err) => setAiFlash({ ok: false, message: `Could not load AI keys: ${err.message}` }));
  }, [setAiFlash]);

  const [manualGroup, setManualGroup] = useState('');
  const listened = draft.groups || [];

  // The outcome catalogue comes from the server, so adding a reply case in
  // src/whatsapp/replies.js makes it appear here with no panel change.
  const [outcomes, setOutcomes] = useState([]);
  const [placeholders, setPlaceholders] = useState([]);
  useEffect(() => {
    api
      .outcomes()
      .then((r) => {
        setOutcomes(r.outcomes);
        setPlaceholders(r.placeholders);
      })
      .catch(() => setOutcomes([]));
  }, []);

  function setReply(key, patch) {
    setDraft((d) => ({
      ...d,
      replies: { ...(d.replies || {}), [key]: { ...(d.replies?.[key] || {}), ...patch } },
    }));
  }

  async function resetReplies() {
    try {
      const { settings: saved } = await api.saveSettings({ resetReplies: true });
      onSaved(saved);
      setFlash({ ok: true, message: 'Replies restored to the defaults.' });
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    }
  }

  function set(field, value) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  function aiErrorMessage(error) {
    const messages = {
      current_password_wrong: 'The current admin password is not correct.',
      too_many_attempts: 'Too many password attempts. Wait a few minutes.',
      invalid_api_key: 'That API key is not valid. Paste it without spaces.',
      provider_not_configured: 'No key is configured for this provider.',
      provider_connection_failed: 'The provider rejected the test. Check the key and Railway logs.',
    };
    return messages[error.message] || error.message;
  }

  async function saveAiKey(provider) {
    setAiBusy(`save:${provider}`);
    setAiFlash(null);
    try {
      const result = await api.saveAiCredential(
        provider,
        aiKeys[provider],
        aiCurrentPassword
      );
      setAiCredentials(result.providers);
      setAiKeys((keys) => ({ ...keys, [provider]: '' }));
      setAiCurrentPassword('');
      setAiFlash({ ok: true, message: `${provider === 'openai' ? 'OpenAI' : 'Gemini'} key saved securely.` });
    } catch (err) {
      setAiFlash({ ok: false, message: aiErrorMessage(err) });
    } finally {
      setAiBusy('');
    }
  }

  async function removeAiKey(provider) {
    setAiBusy(`remove:${provider}`);
    setAiFlash(null);
    try {
      const result = await api.removeAiCredential(provider, aiCurrentPassword);
      setAiCredentials(result.providers);
      setAiCurrentPassword('');
      const fallback = result.providers?.[provider]?.source === 'environment';
      setAiFlash({
        ok: true,
        message: fallback
          ? 'Dashboard key removed. The Railway environment key is active again.'
          : `${provider === 'openai' ? 'OpenAI' : 'Gemini'} key removed.`,
      });
    } catch (err) {
      setAiFlash({ ok: false, message: aiErrorMessage(err) });
    } finally {
      setAiBusy('');
    }
  }

  async function testAiKey(provider) {
    setAiBusy(`test:${provider}`);
    setAiFlash(null);
    try {
      await api.testAiCredential(provider);
      setAiFlash({ ok: true, message: `${provider === 'openai' ? 'OpenAI' : 'Gemini'} connection works.` });
    } catch (err) {
      setAiFlash({ ok: false, message: aiErrorMessage(err) });
    } finally {
      setAiBusy('');
    }
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

  // Reachability is probed on demand, not streamed, so the reading the panel
  // holds was taken whenever it last asked - at sign-in, for a tab left open
  // all day. Ask again on arriving here, and leave the admin a button for the
  // rest. No interval: every probe is a provider call and may be rate limited.
  const [checkingDoors, setCheckingDoors] = useState(false);
  useEffect(() => {
    onRefreshDoors?.().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkDoors() {
    setCheckingDoors(true);
    try {
      await onRefreshDoors();
    } catch (err) {
      setFlash({ ok: false, message: `Could not check the doors: ${err.message}` });
    } finally {
      setCheckingDoors(false);
    }
  }

  return (
    <form className="stack" onSubmit={save}>
      {/* Sticky: this form is several screens tall, and nothing here takes
          effect until it is saved. */}
      <div className="page-bar">
        <div className="page-head">
          <h1>Settings</h1>
          <p>How the bot listens and what it will do.</p>
        </div>
        <button className="btn" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        <Flash flash={flash} />
      </div>

      <Card
        title="Groups the bot listens in"
        hint="Commands are accepted in these groups — and, if private conversations are on below, in one-to-one chats. Everything else is ignored."
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

      <Card
        title="Private conversations"
        hint="Whether a member can open the door by messaging the bot directly, instead of writing in a group."
      >
        <div className="spread">
          <div>
            <div style={{ fontWeight: 600 }}>
              {draft.allowDirectMessages
                ? 'On — members can DM the bot'
                : 'Off — only the groups above'}
            </div>
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              The whitelist still decides who may open. Someone who isn’t a member gets no reply at
              all — their attempt is only written to Activity, so the bot never announces itself to
              a stranger.
            </div>
          </div>
          <Toggle
            checked={Boolean(draft.allowDirectMessages)}
            label="Accept commands in private conversations"
            onChange={(v) => set('allowDirectMessages', v)}
          />
        </div>
      </Card>

      <Card
        title="Test mode"
        hint="Runs everything — whitelist, limits, replies, audit log — but never sends the command to the door."
      >
        <div className="spread">
          <div>
            <div style={{ fontWeight: 600 }}>
              {draft.testMode ? 'On — the door will not open' : 'Off — commands open the real door'}
            </div>
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              Members get a 🧪 reaction instead of ✅, and the log marks these entries as simulated.
            </div>
          </div>
          <Toggle
            checked={Boolean(draft.testMode)}
            label="Test mode"
            onChange={(v) => set('testMode', v)}
          />
        </div>
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

      <Card
        title="AI in group chats"
        hint="Optional helpers for natural requests and less repetitive replies. Authorization, cooldowns and the door result always stay in code."
      >
        <div className="stack">
          <Flash flash={aiFlash} />

          <Field
            label="Active provider"
            hint="The other provider can stay configured for later. Use Save settings above after switching."
          >
            <select
              className="select"
              value={draft.aiProvider || 'openai'}
              onChange={(e) => set('aiProvider', e.target.value)}
            >
              <option value="openai">OpenAI</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </Field>

          <div className="stack">
            {['openai', 'gemini'].map((provider) => {
              const label = provider === 'openai' ? 'OpenAI' : 'Gemini';
              const status = aiCredentials?.[provider];
              const sourceLabel =
                status?.source === 'dashboard'
                  ? 'Configured securely in this dashboard'
                  : status?.source === 'environment'
                    ? 'Configured in Railway environment variables'
                    : status?.source === 'unreadable'
                      ? 'Stored key cannot be decrypted — replace it'
                      : 'Not configured';
              const isActive = (draft.aiProvider || 'openai') === provider;
              return (
                <div className="ai-key-row" key={provider}>
                  <div className="ai-key-row__meta">
                    <div style={{ fontWeight: 600 }}>
                      {label} API key {isActive ? '· selected' : ''}
                    </div>
                    <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                      {sourceLabel}. The saved value is never sent back to the browser.
                    </div>
                  </div>
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    placeholder={status?.configured ? 'Paste a replacement key' : 'Paste API key'}
                    value={aiKeys[provider]}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.preventDefault();
                    }}
                    onChange={(e) => setAiKeys((keys) => ({ ...keys, [provider]: e.target.value }))}
                  />
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    {status?.configured && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={Boolean(aiBusy)}
                        onClick={() => testAiKey(provider)}
                      >
                        {aiBusy === `test:${provider}` ? 'Testing…' : 'Test'}
                      </button>
                    )}
                    {status?.source === 'dashboard' && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={Boolean(aiBusy) || !aiCurrentPassword}
                        onClick={() => removeAiKey(provider)}
                      >
                        {aiBusy === `remove:${provider}` ? 'Removing…' : 'Remove'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={Boolean(aiBusy) || !aiKeys[provider] || !aiCurrentPassword}
                      onClick={() => saveAiKey(provider)}
                    >
                      {aiBusy === `save:${provider}`
                        ? 'Saving…'
                        : status?.configured
                          ? 'Replace'
                          : 'Save key'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <Field
            label="Current admin password"
            hint="Required only when saving, replacing or removing a key. Testing does not need it."
          >
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={aiCurrentPassword}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
              onChange={(e) => setAiCurrentPassword(e.target.value)}
            />
          </Field>

          {draft.replyMode === 'react' && (
            <Empty>
              The bot is currently set to reaction-only. Natural-language opening can still work,
              but varied text and GIFs need “How the bot answers” set to Text or Both.
            </Empty>
          )}
          <div className="spread">
            <div>
              <div style={{ fontWeight: 600 }}>Understand natural door requests</div>
              <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                Off by default. In enabled groups, whitelisted members can write things like “tu
                peux m’ouvrir ?”. A local filter ignores ordinary chat before AI sees anything;
                uncertain messages do nothing. Exact commands still work if AI is down.
              </div>
            </div>
            <Toggle
              checked={Boolean(draft.aiNaturalLanguageEnabled)}
              label="Open from natural-language requests"
              onChange={(v) => set('aiNaturalLanguageEnabled', v)}
            />
          </div>

          <div className="spread">
            <div>
              <div style={{ fontWeight: 600 }}>Vary successful and error replies</div>
              <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                Group replies can be short and playful, but never target a person or joke about
                sex, bodies, identity, health, politics, money, violence, drugs or profanity. An
                unsafe or unavailable AI reply is replaced by the fixed wording below.
              </div>
            </div>
            <Toggle
              checked={Boolean(draft.aiRepliesEnabled)}
              label="Use workplace-safe AI replies"
              onChange={(v) => set('aiRepliesEnabled', v)}
            />
          </div>

          <div className="spread">
            <div>
              <div style={{ fontWeight: 600 }}>Occasional GIF-only success</div>
              <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                Uses only locally bundled, approved animations, and only after a confirmed real
                open. Errors, denials and test mode always keep a clear text reply.
              </div>
            </div>
            <Toggle
              checked={draft.aiGifRepliesEnabled !== false}
              disabled={!draft.aiRepliesEnabled}
              label="Allow approved GIF replies"
              onChange={(v) => set('aiGifRepliesEnabled', v)}
            />
          </div>

          <Field label="GIF chance on successful opens" hint="0–30%. Default: 15%.">
            <input
              className="input"
              style={{ maxWidth: '160px' }}
              type="number"
              min="0"
              max="30"
              value={draft.aiGifChancePct ?? 15}
              disabled={!draft.aiRepliesEnabled || draft.aiGifRepliesEnabled === false}
              onChange={(e) => set('aiGifChancePct', Number(e.target.value))}
            />
          </Field>

          <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
            Keys entered here are encrypted before being stored in MongoDB. Only the member’s
            first/display name, the current candidate message and the decided reply are sent to the
            active provider; no phone number, chat history or raw door error is sent. Provider API
            storage is disabled.
          </div>
        </div>
      </Card>

      <Card
        title="What the bot replies"
        hint={
          draft.replyMode === 'react'
            ? 'Only the reactions are used right now — switch "How the bot answers" above to send text too.'
            : draft.replyMode === 'text'
              ? 'Only the text is used right now — switch "How the bot answers" above to react too.'
              : 'Both the reaction and the text are sent.'
        }
        actions={
          <button type="button" className="btn btn--ghost btn--sm" onClick={resetReplies}>
            Restore defaults
          </button>
        }
      >
        {outcomes.length === 0 ? (
          <Empty>Loading…</Empty>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: 0 }}>
              Leave a field empty to stay silent on that outcome.
              {placeholders.length > 0 && (
                <>
                  {' '}
                  You can use{' '}
                  {placeholders.map((p, i) => (
                    <span key={p}>
                      {i > 0 && ', '}
                      <code>{`{${p}}`}</code>
                    </span>
                  ))}{' '}
                  in the text.
                </>
              )}
            </p>

            <div className="stack">
              {outcomes.map((outcome) => {
                const value = draft.replies?.[outcome.key] || {};
                return (
                  <div className="reply-row" key={outcome.key}>
                    <div className="reply-row__meta">
                      <div style={{ fontWeight: 600 }}>{outcome.label}</div>
                      <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                        {outcome.hint}
                      </div>
                    </div>
                    <input
                      className="input reply-row__emoji"
                      aria-label={`${outcome.label} reaction`}
                      placeholder="—"
                      value={value.emoji ?? ''}
                      onChange={(e) => setReply(outcome.key, { emoji: e.target.value })}
                    />
                    <input
                      className="input"
                      aria-label={`${outcome.label} message`}
                      placeholder="(no message)"
                      value={value.text ?? ''}
                      onChange={(e) => setReply(outcome.key, { text: e.target.value })}
                    />
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>

      <Card
        title="Phone numbers"
        hint="Applies to numbers typed in Members. Numbers read from WhatsApp itself are already complete and are never rewritten."
      >
        <Field
          label="Default country code"
          hint={`Digits only, no “+”. A number typed as 0549212025 is stored as +${
            String(draft.defaultCountryCode || '213').replace(/\D/g, '') || '213'
          }549212025.`}
        >
          <input
            className="input"
            style={{ maxWidth: '160px' }}
            inputMode="numeric"
            value={draft.defaultCountryCode ?? ''}
            onChange={(e) => set('defaultCountryCode', e.target.value.replace(/\D/g, ''))}
          />
        </Field>
      </Card>

      <Card title="Limits" hint="Guard rails against spam and against replayed messages after a reconnect.">
        <div className="grid-2">
          <Field
            label="Quiet period per member (minutes)"
            hint="After the first recognized request, silently ignore more door requests from that person in that group. 0 disables it."
          >
            <input
              className="input"
              type="number"
              min="0"
              max="60"
              step="0.5"
              value={draft.doorRequestCooldownMinutes ?? 2}
              onChange={(e) => set('doorRequestCooldownMinutes', Number(e.target.value))}
            />
          </Field>
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

      <Card
        title="Doors"
        hint="Whether the relay is answering through the configured provider. The reading can lag behind the real thing, so an open is still attempted on a door showing offline."
        actions={
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={checkDoors}
            disabled={checkingDoors}
          >
            {checkingDoors ? 'Checking…' : 'Check now'}
          </button>
        }
      >
        <div className="stack">
          {doors.map((door) => (
            <div className="spread" key={door.key}>
              <div>
                <div style={{ fontWeight: 600 }}>{door.label}</div>
                <div className="row" style={{ gap: 'var(--sp-3)' }}>
                  <DoorStatus door={door} offline={offlineDoors?.has(door.key)} />
                  <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                    {door.configured ? door.key : 'not configured in .env'}
                  </span>
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

          {doorsCheckedAt && (
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              Last checked at {formatTime(doorsCheckedAt)}.
            </div>
          )}
        </div>
      </Card>

      <Card
        title="Door alerts"
        hint="When a door stops answering, the panel shows a banner. These are the ways it also reaches your phone."
      >
        <Field
          label="Fallback WhatsApp number"
          hint="Used only when no browser has alerts enabled, or when push delivery fails. Leave empty for no WhatsApp fallback."
        >
          <input
            className="input"
            placeholder="0549212025"
            value={draft.adminAlertPhone || ''}
            onChange={(e) => set('adminAlertPhone', e.target.value)}
          />
        </Field>
      </Card>

      <Card
        title="Message notifications"
        hint="Incoming WhatsApp messages, pushed to every device that has alerts enabled below. Door alerts are sent whatever this is set to."
      >
        <div className="spread">
          <div>
            <div style={{ fontWeight: 600 }}>Notify on new messages</div>
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              One notification per conversation — a run of messages arriving together is grouped
              into one. The message text is shown, so it appears on the lock screen.
            </div>
          </div>
          <Toggle
            checked={draft.messageAlerts !== false}
            label="Notify on new WhatsApp messages"
            onChange={(v) => set('messageAlerts', v)}
          />
        </div>
      </Card>

      <PushAlertsCard />

      <AdminPasswordCard />
    </form>
  );
}

/**
 * Browser push opt-in. Outside the settings document on purpose: a subscription
 * belongs to *this* browser, not to the deployment, so it can't be something
 * you save once and expect to apply everywhere.
 */
function PushAlertsCard() {
  const [state, setState] = useState({ supported: false, enabled: false, configured: false });
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useFlash();
  const needsInstall = iosNeedsInstall();

  const refresh = async () => {
    if (!pushSupported()) return setState((s) => ({ ...s, supported: false }));
    const [{ configured }, subscription] = await Promise.all([
      api.pushKey().catch(() => ({ configured: false })),
      currentSubscription(),
    ]);
    setState({ supported: true, configured, enabled: Boolean(subscription) });
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  const REASONS = {
    unsupported: "This browser can't do push notifications.",
    server_not_configured: 'No VAPID keys on the server - see the README to generate a pair.',
    permission_denied: 'Notifications are blocked. Allow them for this site in your browser settings.',
    subscribe_failed: 'The browser refused to create a subscription.',
  };

  async function toggle() {
    setBusy(true);
    try {
      if (state.enabled) {
        await disablePush();
        setFlash({ ok: true, message: 'Alerts disabled on this device.' });
      } else {
        const { ok, reason, detail } = await enablePush();
        setFlash(
          ok
            ? { ok: true, message: 'Alerts enabled on this device.' }
            : {
                ok: false,
                message: detail
                  ? `${REASONS[reason] || 'Could not enable alerts.'} (${detail})`
                  : REASONS[reason] || 'Could not enable alerts.',
              }
        );
      }
      await refresh();
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const { delivered, subscribers } = await api.testPush();
      // A rejected delivery is a server-side problem the admin can't see from
      // here, so point at where the reason is written down rather than
      // implying nobody has enabled anything.
      setFlash({
        ok: delivered > 0,
        message: delivered
          ? `Sent to ${delivered} device${delivered === 1 ? '' : 's'}.`
          : subscribers > 0
            ? `${subscribers} device${subscribers === 1 ? ' is' : 's are'} subscribed, but the ` +
              'push service rejected every delivery — check the server logs.'
            : 'No device is subscribed yet.',
      });
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Phone notifications"
      hint="Enable this on each phone or laptop that should be woken when a door goes offline."
    >
      <div className="stack">
        <Flash flash={flash} />

        {!state.supported && <Empty>This browser doesn't support push notifications.</Empty>}

        {state.supported && !state.configured && (
          <Empty>Push isn't configured on the server. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.</Empty>
        )}

        {/* Worth saying before they tap: on iOS a plain Safari tab never gets
            push, no matter how many times permission is granted. */}
        {state.supported && state.configured && needsInstall && (
          <Empty>
            On iPhone, add this panel to your home screen first (Share → Add to Home Screen) — Safari
            only delivers notifications to an installed panel.
          </Empty>
        )}

        {state.supported && state.configured && (
          <div className="spread">
            <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
              {state.enabled ? 'Alerts are on for this device.' : 'Alerts are off for this device.'}
            </div>
            <div className="row" style={{ gap: 8 }}>
              {state.enabled && (
                <button className="btn" type="button" disabled={busy} onClick={test}>
                  Send a test
                </button>
              )}
              <button className="btn" type="button" disabled={busy} onClick={toggle}>
                {state.enabled ? 'Disable' : 'Enable on this device'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Not part of the settings document, and not wired to the form above's onSubmit
 * - a nested <form> would be invalid HTML, and a password change deserves its
 * own confirmation rather than riding along with an unrelated settings save.
 */
function AdminPasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current && next.length >= 8 && next === confirm && !busy;

  async function changePassword() {
    setBusy(true);
    setMsg(null);
    try {
      await api.changePassword(current, next);
      setMsg({ ok: true, message: 'Password changed.' });
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setMsg({
        ok: false,
        message: err.message === 'too_many_attempts' ? 'Too many attempts. Wait a few minutes.' : err.message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Admin password"
      hint="Who can sign in to this panel. Doesn't affect the WhatsApp link or the whitelist."
    >
      <div className="grid-2">
        <Field label="Current password">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <div className="grid-2__spacer" />
        <Field label="New password" hint="At least 8 characters.">
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="Confirm new password" hint={mismatch ? "Doesn't match yet." : undefined}>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
      </div>

      {msg && (
        <div className={`banner ${msg.ok ? 'banner--ok' : ''}`} style={{ marginBottom: 'var(--sp-4)' }}>
          {msg.message}
        </div>
      )}

      <button type="button" className="btn" disabled={!canSubmit} onClick={changePassword}>
        {busy ? 'Changing…' : 'Change password'}
      </button>
    </Card>
  );
}
