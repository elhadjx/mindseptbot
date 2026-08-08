const { mongoose } = require('../mongo');

// One row per browser that has agreed to receive alerts. The endpoint URL is
// the identity of a subscription as far as the push service is concerned, so it
// is the natural unique key - re-subscribing the same browser updates the row
// instead of piling up duplicates that would each deliver the same alert.
const pushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    // Enough to recognise "my phone" from "the office laptop" when revoking.
    label: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    lastSentAt: { type: Date, default: null },
  },
  { versionKey: false }
);

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
