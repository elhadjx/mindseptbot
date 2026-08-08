const { mongoose } = require('../mongo');
const { config } = require('../../config');
const { OUTCOMES, defaultReplies } = require('../../whatsapp/replies');
const { DEFAULT_COUNTRY_CODE } = require('../../whatsapp/phone');

// One editable reply per outcome. An empty emoji means "don't react", an empty
// text means "don't send a message" - both are useful for keeping the group
// quiet on specific outcomes.
const replySchema = new mongoose.Schema(
  {
    emoji: { type: String, default: '', trim: true },
    text: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const repliesSchema = new mongoose.Schema(
  Object.fromEntries(
    OUTCOMES.map((outcome) => [
      outcome.key,
      { type: replySchema, default: () => ({ emoji: outcome.emoji, text: outcome.text }) },
    ])
  ),
  { _id: false }
);

// Singleton runtime settings, editable from the admin panel so the group,
// keywords and limits can change without a redeploy. Env vars only seed it.
const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },

    // Groups the bot listens in. A group can be toggled off without losing its
    // name, so pausing one door group is one click rather than a re-pick.
    groups: {
      type: [
        {
          _id: false,
          id: { type: String, required: true },
          name: { type: String, default: '' },
          enabled: { type: Boolean, default: true },
        },
      ],
      default: [],
    },

    // Superseded by `groups`. Kept so an existing deployment's configured group
    // survives the upgrade - migrated into `groups` by load() below.
    groupId: { type: String, default: null },
    groupName: { type: String, default: '' },

    // Whether the bot also accepts commands in one-to-one chats. Off by default:
    // turning it on means anyone who knows the number can reach the pipeline,
    // and the whitelist becomes the only thing between them and the door.
    allowDirectMessages: { type: Boolean, default: false },

    // Country code prepended to numbers typed in national format ("0549212025").
    // Digits only, no "+".
    defaultCountryCode: { type: String, default: DEFAULT_COUNTRY_CODE, trim: true },

    commandKeywords: {
      type: [String],
      default: ['/open', '/ouvre', 'open', 'ouvre', 'porte'],
    },
    defaultDoor: { type: String, default: 'front' },
    doorsEnabled: {
      type: Map,
      of: Boolean,
      default: () => new Map([['front', true]]),
    },

    // Whether to react, reply with text, or both. The wording of each is in
    // `replies` below.
    replyMode: { type: String, enum: ['react', 'text', 'both'], default: 'react' },
    replies: { type: repliesSchema, default: () => defaultReplies() },

    // Test mode: run the whole pipeline - scope, whitelist, rate limits, audit
    // log - but never send the Tuya command. For trying the bot out without
    // opening a real door onto the street.
    testMode: { type: Boolean, default: false },

    // Guards against a reconnect replaying a backlog of old "open" messages
    // and firing the relay for each one.
    maxMessageAgeSec: { type: Number, default: 90 },

    rateLimitPerUserPerMin: { type: Number, default: 3 },
    rateLimitGlobalPerMin: { type: Number, default: 10 },

    relayPulseMs: { type: Number, default: config.doors.relayPulseMs },

    // Where to send "the door is offline" when no browser has push enabled.
    // Empty means no fallback - the panel banner is then the only alert.
    adminAlertPhone: { type: String, default: '', trim: true },

    // Whether an incoming WhatsApp message also buzzes the phones that have
    // opted into browser alerts. Separate from the door alerts on purpose:
    // these are chatter, those are an emergency, and someone who wants the
    // second rarely wants both.
    messageAlerts: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false, _id: false }
);

/**
 * What kind of chat is this, as far as the bot is concerned?
 *
 * The allowlist of servers is the point: WhatsApp delivers plenty of things
 * that are neither a group nor a real conversation - status replies
 * ("status@broadcast"), broadcast lists ("@broadcast") and channels
 * ("@newsletter"). Matching on "not a group, so it must be a DM" would put all
 * of those in scope the moment direct messages were switched on.
 *
 * @returns {'group'|'dm'|null} null means "ignore this message entirely".
 */
settingsSchema.methods.chatScope = function chatScope(chatId) {
  const id = String(chatId || '');
  const server = id.split('@')[1];

  if (server === 'g.us') {
    return this.groups.some((group) => group.enabled && group.id === id) ? 'group' : null;
  }
  // A one-to-one chat is "<phone>@c.us", or "<lid>@lid" when the sender's
  // number is hidden.
  if (server === 'c.us' || server === 'lid') {
    return this.allowDirectMessages ? 'dm' : null;
  }
  return null;
};

settingsSchema.statics.load = async function load() {
  let doc = await this.findById('global');

  if (!doc) {
    const seed = config.whatsapp.seedGroupId;
    doc = await this.create({
      _id: 'global',
      groups: seed ? [{ id: seed, name: '', enabled: true }] : [],
      defaultCountryCode: config.defaultCountryCode || DEFAULT_COUNTRY_CODE,
    });
    console.log('[settings] bootstrapped defaults');
    return doc;
  }

  // One-time migration from the single-group setting.
  if (doc.groupId && !doc.groups.some((g) => g.id === doc.groupId)) {
    doc.groups.push({ id: doc.groupId, name: doc.groupName || '', enabled: true });
    await doc.save();
    console.log(`[settings] migrated group ${doc.groupId} into the groups list`);
  }

  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
