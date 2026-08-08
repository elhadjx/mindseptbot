/**
 * Web Push delivery to whichever browsers have opted in from the panel.
 *
 * Push is optional infrastructure: with no VAPID keys configured the whole
 * module goes quiet and callers fall back to another channel. That keeps a
 * fresh deployment - or a local dev run - from needing keys just to boot.
 */

const webpush = require('web-push');
const { config } = require('../config');
const PushSubscription = require('../db/models/PushSubscription');

const configured = Boolean(config.push.publicKey && config.push.privateKey);

if (configured) {
  webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
} else {
  console.log('[push] no VAPID keys set - browser alerts are disabled');
}

function isPushConfigured() {
  return configured;
}

function publicKey() {
  return config.push.publicKey;
}

/**
 * Fan a notification out to every registered browser.
 *
 * A 404 or 410 from the push service is the standard "this subscription is
 * dead" answer - the user cleared site data, or uninstalled the PWA. Those rows
 * are deleted rather than retried, otherwise every future alert pays for them.
 *
 * @param {object} payload            what the service worker renders
 * @param {object} [options]
 * @param {number} [options.ttl]      seconds the push service may hold it for
 * @param {string} [options.urgency]  'high' wakes a dozing phone; 'normal' is
 *   for anything that can wait for the next time it looks at the screen
 * @returns {Promise<number>} how many browsers actually accepted the push. Zero
 *   is the caller's cue to fall back to another channel.
 */
async function sendPush(payload, { ttl = 3600, urgency = 'high' } = {}) {
  if (!configured) return 0;

  const subscriptions = await PushSubscription.find().lean();
  if (subscriptions.length === 0) return 0;

  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subscriptions.map((sub) =>
      webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, {
        // Alerts are only worth delivering while they're still true - the
        // default suits a door outage; a chat message goes stale far sooner.
        TTL: ttl,
        urgency,
      })
    )
  );

  const dead = [];
  let delivered = 0;

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      delivered += 1;
      return;
    }
    const status = result.reason?.statusCode;
    if (status === 404 || status === 410) {
      dead.push(subscriptions[i].endpoint);
    } else {
      console.warn(`[push] delivery failed (${status || '?'}):`, result.reason?.message);
    }
  });

  if (dead.length) {
    await PushSubscription.deleteMany({ endpoint: { $in: dead } });
    console.log(`[push] pruned ${dead.length} expired subscription(s)`);
  }
  if (delivered) {
    await PushSubscription.updateMany({}, { $set: { lastSentAt: new Date() } });
  }

  return delivered;
}

module.exports = { isPushConfigured, publicKey, sendPush };
