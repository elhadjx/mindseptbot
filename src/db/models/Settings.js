const { mongoose } = require('../mongo');
const { config } = require('../../config');

// Singleton runtime settings, editable from the admin panel so the group,
// keywords and limits can change without a redeploy. Env vars only seed it.
const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'global' },

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

    // Guards against a reconnect replaying a backlog of old "open" messages
    // and firing the relay for each one.
    maxMessageAgeSec: { type: Number, default: 90 },

    rateLimitPerUserPerMin: { type: Number, default: 3 },
    rateLimitGlobalPerMin: { type: Number, default: 10 },

    relayPulseMs: { type: Number, default: config.doors.relayPulseMs },
  },
  { timestamps: true, versionKey: false, _id: false }
);

settingsSchema.statics.load = async function load() {
  let doc = await this.findById('global');
  if (!doc) {
    doc = await this.create({
      _id: 'global',
      groupId: config.whatsapp.seedGroupId,
    });
    console.log('[settings] bootstrapped defaults');
  }
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
