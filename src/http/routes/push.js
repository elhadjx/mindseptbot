const express = require('express');
const PushSubscription = require('../../db/models/PushSubscription');
const { isPushConfigured, publicKey, sendPush } = require('../../notify/push');

const router = express.Router();

// The panel asks first: no keys on the server means don't even offer the
// button, rather than prompting for permission that can't be used.
router.get('/key', (req, res) => {
  res.json({ ok: true, configured: isPushConfigured(), publicKey: publicKey() });
});

router.post('/subscribe', async (req, res) => {
  const { endpoint, keys, label } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ ok: false, error: 'invalid_subscription' });
  }

  // Upsert on the endpoint: a browser that re-subscribes (after a permission
  // reset, say) must replace its row, not add a second one that double-buzzes.
  await PushSubscription.updateOne(
    { endpoint },
    {
      $set: { keys: { p256dh: keys.p256dh, auth: keys.auth }, label: String(label || '').slice(0, 120) },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  const count = await PushSubscription.estimatedDocumentCount();
  res.json({ ok: true, subscribers: count });
});

router.delete('/subscribe', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ ok: false, error: 'missing_endpoint' });
  await PushSubscription.deleteOne({ endpoint });
  res.json({ ok: true });
});

// Worth having: push has enough moving parts (keys, service worker, OS
// permissions) that "did it actually work?" needs an answer other than
// breaking a door.
router.post('/test', async (req, res) => {
  const delivered = await sendPush({
    title: 'Mindsept alerts are on',
    body: "C'est à ça que ressemblera une alerte porte hors ligne.",
    tag: 'push-test',
  });
  // "Nothing was delivered" has two very different meanings - nobody is
  // subscribed, or everybody's delivery was rejected - and only the second is
  // a fault. Reporting them as one told an admin to go re-enable alerts that
  // were already on.
  const subscribers = await PushSubscription.estimatedDocumentCount();
  res.json({ ok: true, delivered, subscribers });
});

module.exports = router;
