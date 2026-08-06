const express = require('express');
const { getClient } = require('../../whatsapp/client');
const { listContacts } = require('../../whatsapp/contacts');
const { describePageError, requireReady } = require('../wa');

const router = express.Router();

// Reading the contact collection means a page evaluate and, on a large account,
// a few thousand projected rows. Contacts change rarely, so serve a cached copy
// and let the panel force a re-read with ?refresh=1.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, contacts: null };

router.get('/', requireReady, async (req, res) => {
  const fresh = req.query.refresh === '1';
  if (!fresh && cache.contacts && Date.now() - cache.at < CACHE_TTL_MS) {
    return res.json({ ok: true, contacts: cache.contacts, cachedAt: new Date(cache.at) });
  }

  try {
    const contacts = await listContacts(getClient());
    cache = { at: Date.now(), contacts };
    res.json({ ok: true, contacts, cachedAt: new Date(cache.at) });
  } catch (err) {
    console.error('[api] listing contacts failed:', err);
    res.status(500).json({ ok: false, error: describePageError(err, 'Could not list contacts') });
  }
});

module.exports = router;
