const { mongoose } = require('../mongo');

// A whitelisted member. We deliberately store *both* identifiers WhatsApp may
// use for the same human:
//   waId  - the raw JID seen on group messages ("<phone>@c.us" OR "<lid>@lid")
//   phone - digits only, no "+" (e.g. "212661234567")
// WhatsApp's LID rollout means group messages increasingly arrive addressed by
// LID rather than phone number, and the phone may not be resolvable at all.
// Matching on either identifier is what keeps authorization working across it.
const userSchema = new mongoose.Schema(
  {
    waId: { type: String, trim: true, index: true, unique: true, sparse: true },
    lid: { type: String, trim: true, index: true, sparse: true },
    phone: { type: String, trim: true, index: true, unique: true, sparse: true },
    displayName: { type: String, trim: true, default: '' },
    enabled: { type: Boolean, default: true, index: true },
    note: { type: String, trim: true, default: '' },
    lastOpenedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Authorization lookup: any known identifier for this sender, if enabled.
userSchema.statics.findAuthorized = function findAuthorized({ waId, lid, phone }) {
  const or = [];
  if (waId) or.push({ waId }, { lid: waId });
  if (lid) or.push({ lid }, { waId: lid });
  if (phone) or.push({ phone });
  if (or.length === 0) return Promise.resolve(null);
  return this.findOne({ enabled: true, $or: or });
};

module.exports = mongoose.model('User', userSchema);
