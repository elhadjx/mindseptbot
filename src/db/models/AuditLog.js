const { mongoose } = require('../mongo');

// Every door attempt lands here - granted, denied and errored alike. Denials
// from unknown numbers are the interesting rows, so they are never dropped.
const auditLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    source: { type: String, enum: ['whatsapp', 'panel'], required: true },
    decision: { type: String, enum: ['granted', 'denied', 'error'], required: true, index: true },
    reason: { type: String, default: '' },
    // True when test mode was on, i.e. the door did NOT physically open. The
    // log would otherwise claim opens that never happened.
    simulated: { type: Boolean, default: false },

    actorWaId: { type: String, default: null, index: true },
    actorPhone: { type: String, default: null },
    actorName: { type: String, default: '' },

    door: { type: String, default: null },
    command: { type: String, default: '' },
    // Where the command came from. `groupId` predates one-to-one support and is
    // still only ever a group, so old rows keep meaning exactly what they did.
    chatType: { type: String, enum: ['group', 'dm', null], default: null },
    chatId: { type: String, default: null },
    groupId: { type: String, default: null },
    messageId: { type: String, default: null },
    durationMs: { type: Number, default: null },
  },
  { versionKey: false }
);

auditLogSchema.index({ at: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
