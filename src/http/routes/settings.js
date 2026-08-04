const express = require('express');
const Settings = require('../../db/models/Settings');

const router = express.Router();

const EDITABLE = [
  'testMode',
  'commandKeywords',
  'defaultDoor',
  'replyMode',
  'maxMessageAgeSec',
  'rateLimitPerUserPerMin',
  'rateLimitGlobalPerMin',
  'relayPulseMs',
];

router.get('/', async (req, res) => {
  const settings = await Settings.load();
  res.json({ ok: true, settings: settings.toObject() });
});

router.patch('/', async (req, res) => {
  const settings = await Settings.load();
  const body = req.body || {};

  for (const field of EDITABLE) {
    if (!(field in body)) continue;

    if (field === 'commandKeywords') {
      const keywords = (Array.isArray(body[field]) ? body[field] : [])
        .map((k) => String(k).trim())
        .filter(Boolean);
      if (keywords.length === 0) {
        return res.status(400).json({ ok: false, error: 'need at least one keyword' });
      }
      settings.commandKeywords = keywords;
      continue;
    }

    settings[field] = body[field];
  }

  if (Array.isArray(body.groups)) {
    const seen = new Set();
    const groups = [];
    for (const entry of body.groups) {
      const id = String(entry?.id || '').trim();
      // A group id must be a group JID - a c.us here would make the bot obey
      // door commands sent in a one-to-one chat.
      if (!id.endsWith('@g.us')) {
        return res.status(400).json({ ok: false, error: `not a group id: ${id || '(empty)'}` });
      }
      if (seen.has(id)) continue;
      seen.add(id);
      groups.push({
        id,
        name: String(entry.name || '').trim(),
        enabled: entry.enabled !== false,
      });
    }
    settings.groups = groups;
  }

  if (body.doorsEnabled && typeof body.doorsEnabled === 'object') {
    for (const [door, enabled] of Object.entries(body.doorsEnabled)) {
      settings.doorsEnabled.set(door, Boolean(enabled));
    }
  }

  try {
    await settings.save();
    res.json({ ok: true, settings: settings.toObject() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
