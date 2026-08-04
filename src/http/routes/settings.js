const express = require('express');
const Settings = require('../../db/models/Settings');
const {
  OUTCOMES,
  OUTCOME_KEYS,
  PLACEHOLDERS,
  defaultReplies,
  graphemeLength,
} = require('../../whatsapp/replies');

const router = express.Router();

const MAX_REPLY_LENGTH = 500;

/** Expose the outcome catalogue so the panel builds its form from the server. */
router.get('/outcomes', (req, res) => {
  res.json({ ok: true, outcomes: OUTCOMES, placeholders: PLACEHOLDERS });
});

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

  if (body.replies && typeof body.replies === 'object') {
    for (const [key, value] of Object.entries(body.replies)) {
      if (!OUTCOME_KEYS.includes(key)) {
        return res.status(400).json({ ok: false, error: `unknown outcome: ${key}` });
      }
      const emoji = String(value?.emoji ?? '').trim();
      const text = String(value?.text ?? '').trim();

      // WhatsApp reactions are a single emoji. Count graphemes so a ZWJ
      // sequence like a family emoji still counts as one.
      if (emoji && graphemeLength(emoji) > 1) {
        return res
          .status(400)
          .json({ ok: false, error: `"${key}" reaction must be a single emoji` });
      }
      if (text.length > MAX_REPLY_LENGTH) {
        return res
          .status(400)
          .json({ ok: false, error: `"${key}" reply is too long (max ${MAX_REPLY_LENGTH})` });
      }

      settings.replies[key] = { emoji, text };
    }
    settings.markModified('replies');
  }

  // Explicit opt-in to restore the shipped wording.
  if (body.resetReplies === true) {
    settings.replies = defaultReplies();
    settings.markModified('replies');
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
