const { mongoose } = require('../mongo');
const { config } = require('../../config');

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

    replyMode: { type: String, enum: ['react', 'text', 'both'], default: 'react' },

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
  },
  { timestamps: true, versionKey: false, _id: false }
);

/** Is this chat one we accept commands from? */
settingsSchema.methods.listensTo = function listensTo(chatId) {
  return this.groups.some((group) => group.enabled && group.id === chatId);
};

settingsSchema.statics.load = async function load() {
  let doc = await this.findById('global');

  if (!doc) {
    const seed = config.whatsapp.seedGroupId;
    doc = await this.create({
      _id: 'global',
      groups: seed ? [{ id: seed, name: '', enabled: true }] : [],
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
