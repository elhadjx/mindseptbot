const { getConfiguredAIClient } = require('./provider');
const { GIF_IDS } = require('../whatsapp/gifs');

const SAFE_GIF_OUTCOMES = new Set(['granted', 'confirm_opened']);
const RECENT_LIMIT = 5;

// A message must already look like a direct, present-tense door request before
// any text leaves the server. The model is a conservative second opinion, not
// a way to send all coworking conversation to an API.
const REQUEST_PATTERNS = [
  /\b(?:open|unlock)\s+(?:the\s+)?(?:front\s+)?door\b/u,
  /\blet\s+(?:me|us)\s+in\b/u,
  /\b(?:ouvre|ouvrez|ouvrir|deverrouille|deverrouiller)\s+(?:moi\s+|nous\s+)?(?:la\s+)?porte\b/u,
  /\b(?:tu\s+peux|vous\s+pouvez)\s+(?:m\s+|nous\s+)?ouvrir\b/u,
  /\b(?:ouvre|ouvrez)\s+(?:moi|nous)\b.*\b(?:devant|dehors|entree|immeuble)\b/u,
  /\b(?:je\s+suis|on\s+est|nous\s+sommes)\s+(?:devant|dehors)\b.*\b(?:ouvre|ouvrez|ouvrir)\b/u,
  /\b(?:7ell|hall|hel)\s+(?:li\s+)?(?:el\s+)?bab\b/u,
  /(?:افتح|حل)\s+(?:لي\s+)?(?:ال)?باب/u,
];

const NEGATION_PATTERNS = [
  /\b(?:ne|n)\s+.*\bpas\b/u,
  /\b(?:pas\s+besoin|inutile)\b/u,
  /\b(?:do\s+not|don\s*t|dont|no\s+need)\b/u,
  /(?:لا|ما)\s*(?:تفتح|تحل|افتح|حل)/u,
];

// If any of these appears in generated text, use the fixed reply. This local
// filter complements moderation and intentionally errs toward being boring.
const UNSAFE_TEXT = [
  /\b(?:sex|sexy|porn|nude|naked|penis|vagina|boobs?|romance|romantic|kiss|date|amour)\b/iu,
  /\b(?:idiot|stupid|dumb|loser|ugly|fat|lazy|moron|retard|shame)\b/iu,
  /\b(?:fuck|shit|bitch|asshole|merde|putain|connard|conne?)\b/iu,
  /\b(?:race|religion|muslim|christian|jewish|gay|lesbian|transgender|disabled|nationality)\b/iu,
  /\b(?:algerian|algerien|french|francais|arab|arabe|kabyle|berber|berbere)\b/iu,
  /\b(?:man|woman|boy|girl|homme|femme|age|old|young|vieux|vieille|jeune)\b/iu,
  /\b(?:body|appearance|face|hair|corps|physique|beau|belle|malade|health|mental)\b/iu,
  /\b(?:salary|income|poor|rich|politic|election|president|drug|cocaine|weed)\b/iu,
  /\b(?:gun|weapon|kill|fight|violence|arme|tuer|frapper)\b/iu,
  /\b(?:moche|gros|grosse|debile|stupide|nul|nulle|paresseux|honte)\b/iu,
];

function normalize(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'\-]/g, ' ')
    .replace(/\s+/g, ' ');
}

function isDoorIntentCandidate(message) {
  const original = String(message || '').trim();
  if (!original || original.length > 300 || original.startsWith('>')) return false;
  const text = normalize(original);
  if (NEGATION_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

function isWorkplaceSafeText(text, name = '') {
  const value = String(text || '').trim();
  if (!value || value.length > 180 || /[\r\n]/.test(value)) return false;
  if (/https?:\/\/|www\.|@\w+/iu.test(value)) return false;
  const givenName = firstName(name);
  if (givenName) {
    const escaped = givenName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const occurrences = value.match(new RegExp(`\\b${escaped}\\b`, 'giu')) || [];
    // If the model uses the name, it is allowed once and only as a greeting.
    if (occurrences.length > 1) return false;
    if (occurrences.length === 1 && !new RegExp(`^${escaped}(?:[\\s,:!—-]|$)`, 'iu').test(value)) {
      return false;
    }
  }
  return !UNSAFE_TEXT.some((pattern) => pattern.test(value));
}

class DoorAI {
  constructor({ client, clientFactory = getConfiguredAIClient, random = Math.random } = {}) {
    this.client = client || null;
    this.clientFactory = clientFactory;
    this.random = random;
    this.recentReplies = new Map();
    this.recentGifs = [];
  }

  async resolveClient(provider) {
    return this.client || this.clientFactory(provider);
  }

  async classifyDoorIntent(message, { provider = 'openai' } = {}) {
    if (!isDoorIntentCandidate(message)) return false;
    try {
      const client = await this.resolveClient(provider);
      if (!client?.enabled) return false;
      const result = await client.structured({
        name: 'door_intent',
        instructions:
          'Classify one message from an authorized coworking-space member. Return open_front_door only for an explicit request to open the building entrance now. Reject negation, past events, status reports, quoted speech, hypotheticals, jokes, ambiguity, and questions about whether the door is open. A polite request such as “can you open for me?” is a request. Never infer authorization.',
        input: `Message: ${String(message).slice(0, 300)}`,
        maxOutputTokens: 100,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['open_front_door', 'none'] },
            explicitRequest: { type: 'boolean' },
            currentRequest: { type: 'boolean' },
            negated: { type: 'boolean' },
            ambiguous: { type: 'boolean' },
          },
          required: ['action', 'explicitRequest', 'currentRequest', 'negated', 'ambiguous'],
        },
      });
      return (
        result?.action === 'open_front_door' &&
        result.explicitRequest === true &&
        result.currentRequest === true &&
        result.negated === false &&
        result.ambiguous === false
      );
    } catch (err) {
      console.warn(`[ai] intent unavailable: ${safeErrorKind(err)}`);
      return false;
    }
  }

  async rewriteReply({
    outcome,
    canonicalReply,
    name,
    message,
    allowGifs,
    gifChancePct = 15,
    provider = 'openai',
  }) {
    if (!canonicalReply) return null;

    const gifChance = Math.max(0, Math.min(30, Number(gifChancePct) || 0));
    const mayUseGif =
      Boolean(allowGifs) && SAFE_GIF_OUTCOMES.has(outcome) && this.random() * 100 < gifChance;
    const recent = this.recentReplies.get(outcome) || [];
    const allowedModes = mayUseGif ? ['text', 'gif'] : ['text'];

    try {
      const client = await this.resolveClient(provider);
      if (!client?.enabled) return null;
      const result = await client.structured({
        name: 'workplace_reply',
        instructions: [
          'Rewrite a decided WhatsApp door-bot reply for a friendly coworking-space group.',
          'The canonical outcome is immutable: never change success into failure, failure into success, test mode into a real open, or add operational facts.',
          'Use one short line in the message language, maximum 180 characters. The tone may be lightly playful or include a harmless door/relay/bot/coffee/weather/coworking/mission joke.',
          'Never shame or insult anyone. Never joke about sex, romance, bodies, appearance, gender, age, race, nationality, religion, disability, health, politics, money, violence, drugs, or profanity.',
          'Use the first name only as a positive greeting, never as the target of a joke.',
          mayUseGif
            ? `You may instead choose mode gif with exactly one approved gifId: ${GIF_IDS.join(', ')}. GIF mode must have an empty reply.`
            : 'You must choose mode text, with an empty gifId.',
          'Do not include links, usernames, phone numbers, or quote the sender.',
        ].join(' '),
        input: JSON.stringify({
          outcome,
          canonicalReply: String(canonicalReply).slice(0, 300),
          senderFirstName: firstName(name),
          senderMessage: String(message || '').slice(0, 300),
          avoidRecentReplies: recent,
          avoidRecentGifIds: this.recentGifs,
        }),
        maxOutputTokens: 140,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', enum: allowedModes },
            reply: { type: 'string' },
            gifId: { type: 'string', enum: mayUseGif ? ['', ...GIF_IDS] : [''] },
          },
          required: ['mode', 'reply', 'gifId'],
        },
      });

      if (result?.mode === 'gif') {
        if (
          !mayUseGif ||
          result.reply !== '' ||
          !GIF_IDS.includes(result.gifId) ||
          this.recentGifs.includes(result.gifId)
        ) {
          return null;
        }
        this.rememberGif(result.gifId);
        return { mode: 'gif', gifId: result.gifId };
      }

      const reply = String(result?.reply || '').trim();
      if (
        result?.mode !== 'text' ||
        result.gifId !== '' ||
        recent.includes(reply) ||
        !isWorkplaceSafeText(reply, name)
      ) {
        return null;
      }

      // A moderation outage also falls back. For a workplace bot, a fixed line
      // is a much better failure mode than sending unreviewed generated text.
      const moderation = await client.moderate(reply);
      if (moderation.flagged) return null;

      this.rememberReply(outcome, reply);
      return { mode: 'text', reply };
    } catch (err) {
      console.warn(`[ai] reply unavailable: ${safeErrorKind(err)}`);
      return null;
    }
  }

  rememberReply(outcome, reply) {
    const recent = this.recentReplies.get(outcome) || [];
    this.recentReplies.set(outcome, [...recent.filter((item) => item !== reply), reply].slice(-RECENT_LIMIT));
  }

  rememberGif(gifId) {
    this.recentGifs = [...this.recentGifs.filter((id) => id !== gifId), gifId].slice(-2);
  }
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0].slice(0, 40);
}

function safeErrorKind(err) {
  const message = String(err?.message || 'request failed');
  if (/timed out/i.test(message)) return 'timeout';
  if (/\(\d{3}\)/.test(message)) return message.match(/\(\d{3}\)/)[0];
  if (/not configured/i.test(message)) return 'not configured';
  return 'request failed';
}

const doorAI = new DoorAI();

module.exports = {
  DoorAI,
  doorAI,
  SAFE_GIF_OUTCOMES,
  isDoorIntentCandidate,
  isWorkplaceSafeText,
  normalize,
};
