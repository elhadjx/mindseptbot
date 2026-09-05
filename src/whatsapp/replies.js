/**
 * What the bot says back, per outcome.
 *
 * Every branch that answers a command names an outcome here, so the wording and
 * the reaction emoji live in one editable place rather than scattered through
 * the handler. `OUTCOMES` is also what the admin panel renders its form from -
 * add a case here and it appears in Settings automatically.
 */

const OUTCOMES = [
  {
    key: 'granted',
    label: 'Door opened',
    hint: 'The member is allowed and the relay fired.',
    emoji: '✅',
    text: 'Ouvert 🚪',
  },
  {
    key: 'granted_unconfirmed',
    label: 'Sent, but the door was offline',
    hint: 'The relay was not answering, so the command went out blind. Ask whether it actually opened — the reply is recorded.',
    emoji: '📡',
    text:
      "La porte ne répond pas (sûrement hors ligne), mais j'ai quand même envoyé l'ouverture. " +
      "Est-ce qu'elle s'est ouverte ?",
  },
  {
    key: 'confirm_opened',
    label: 'Member said it opened',
    hint: 'Their answer to the question above was yes. The door works, whatever the provider reports.',
    emoji: '👍',
    text: 'Parfait, merci — je note que la porte marche.',
  },
  {
    key: 'confirm_failed',
    label: 'Member said it stayed shut',
    hint: 'Their answer was no. This is the only hard proof of an outage there is, so an admin is alerted.',
    emoji: '📡',
    text: "Merci de l'avoir dit. La porte est bien en panne — un admin a été prévenu.",
  },
  {
    key: 'simulated',
    label: 'Test mode',
    hint: 'Test mode is on, so nothing actually opened. Keep this one unambiguous.',
    emoji: '🧪',
    text: "Mode test : la porte n'a PAS été ouverte.",
  },
  {
    key: 'denied_not_whitelisted',
    label: 'Not on the list',
    hint: 'Sender is not a member, or has been disabled.',
    emoji: '⛔',
    text: "Tu n'es pas sur la liste. Demande à un admin de t'ajouter.",
  },
  {
    key: 'denied_rate_limited',
    label: 'Too many requests',
    hint: 'The per-member or overall limit was hit.',
    emoji: '⏳',
    text: 'Trop de demandes, réessaie dans un instant.',
  },
  {
    key: 'denied_door_disabled',
    label: 'Door switched off',
    hint: 'That door is disabled in Settings.',
    emoji: '⛔',
    text: 'Cette porte est désactivée pour le moment.',
  },
  {
    key: 'denied_unknown_door',
    label: 'Unknown door',
    hint: 'The command named a door we do not have.',
    emoji: '❓',
    text: 'Je ne connais pas cette porte.',
  },
  {
    key: 'door_offline',
    label: 'Door not responding',
    hint: 'The relay is unreachable. An admin has been notified automatically.',
    emoji: '📡',
    text: "La porte ne répond pas. Un admin a été prévenu.",
  },
  {
    key: 'error',
    label: 'Something broke',
    hint: 'The member was allowed, but the door command failed.',
    emoji: '⚠️',
    text: "Ça n'a pas marché, préviens un admin.",
  },
];

const OUTCOME_KEYS = OUTCOMES.map((o) => o.key);

/** Which audit decision each outcome corresponds to. */
const OUTCOME_DECISION = {
  granted: 'granted',
  // Logged as granted with an `unconfirmed` mark rather than as its own
  // decision: the member was allowed and the command was sent. Whether the
  // door moved is a separate question, and it has its own field.
  granted_unconfirmed: 'granted',
  confirm_opened: 'granted',
  confirm_failed: 'error',
  simulated: 'granted',
  denied_not_whitelisted: 'denied',
  denied_rate_limited: 'denied',
  denied_door_disabled: 'denied',
  denied_unknown_door: 'denied',
  door_offline: 'error',
  error: 'error',
};

function defaultReplies() {
  return Object.fromEntries(OUTCOMES.map((o) => [o.key, { emoji: o.emoji, text: o.text }]));
}

const PLACEHOLDERS = ['name', 'door'];

/**
 * Substitute {name} / {door}. Unknown placeholders are left alone rather than
 * blanked, so a typo shows up in the group instead of silently vanishing.
 */
function fillPlaceholders(text, vars = {}) {
  return String(text || '').replace(/\{(\w+)\}/g, (match, token) =>
    PLACEHOLDERS.includes(token) && vars[token] != null ? String(vars[token]) : match
  );
}

/**
 * Resolve the emoji and text for an outcome, falling back to the built-in
 * defaults for anything the admin hasn't set.
 */
function renderReply(settings, key, vars = {}) {
  const fallback = OUTCOMES.find((o) => o.key === key) || {};
  // settings.replies is a mongoose subdocument; read defensively so this works
  // with plain objects in tests too.
  const configured = settings?.replies?.[key] || {};

  const emoji = configured.emoji !== undefined ? configured.emoji : fallback.emoji;
  const text = configured.text !== undefined ? configured.text : fallback.text;

  return { emoji: emoji || '', text: fillPlaceholders(text, vars) };
}

/** Count user-perceived characters, so a ZWJ emoji counts as one. */
function graphemeLength(value) {
  const str = String(value || '');
  if (typeof Intl?.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str)].length;
  }
  return [...str].length;
}

module.exports = {
  OUTCOMES,
  OUTCOME_KEYS,
  OUTCOME_DECISION,
  PLACEHOLDERS,
  defaultReplies,
  fillPlaceholders,
  renderReply,
  graphemeLength,
};
