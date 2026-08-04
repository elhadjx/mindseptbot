const express = require('express');
const User = require('../../db/models/User');
const { digitsOnly, parseJid } = require('../../whatsapp/identity');

const router = express.Router();

/**
 * Accept either a raw JID or a loosely typed phone number and normalise it into
 * the {waId, lid, phone} triple the User model stores.
 */
function normaliseIdentifiers({ waId, lid, phone }) {
  const out = { waId: null, lid: null, phone: null };

  if (waId) {
    const parsed = parseJid(waId);
    out.waId = parsed.raw;
    if (parsed.isLid) out.lid = parsed.raw;
    if (parsed.isPhone) out.phone = digitsOnly(parsed.user);
  }
  if (lid) out.lid = parseJid(lid).raw;

  const typedPhone = digitsOnly(phone);
  if (typedPhone) {
    out.phone = typedPhone;
    // A phone number with no JID yet still gives us a usable waId: that is
    // exactly the form a non-LID group message arrives in.
    if (!out.waId) out.waId = `${typedPhone}@c.us`;
  }

  return out;
}

router.get('/', async (req, res) => {
  const members = await User.find().sort({ displayName: 1, createdAt: 1 }).lean();
  res.json({ ok: true, members });
});

router.post('/', async (req, res) => {
  const { displayName = '', note = '', enabled = true } = req.body || {};
  const ids = normaliseIdentifiers(req.body || {});

  if (!ids.waId && !ids.phone) {
    return res.status(400).json({ ok: false, error: 'need a phone number or a WhatsApp id' });
  }

  try {
    // Upsert on identity so re-enrolling someone from the group list updates
    // them rather than colliding with the unique indexes.
    const existing = await User.findOne({
      $or: [ids.waId && { waId: ids.waId }, ids.phone && { phone: ids.phone }].filter(Boolean),
    });

    if (existing) {
      Object.assign(existing, {
        ...ids,
        displayName: displayName || existing.displayName,
        note: note || existing.note,
        enabled,
      });
      await existing.save();
      return res.json({ ok: true, member: existing.toObject(), created: false });
    }

    const member = await User.create({ ...ids, displayName, note, enabled });
    return res.status(201).json({ ok: true, member: member.toObject(), created: true });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ ok: false, error: 'member already exists' });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  const patch = {};
  for (const field of ['displayName', 'note', 'enabled']) {
    if (field in (req.body || {})) patch[field] = req.body[field];
  }
  if ('phone' in (req.body || {})) patch.phone = digitsOnly(req.body.phone);

  try {
    const member = await User.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!member) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, member: member.toObject() });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const member = await User.findByIdAndDelete(req.params.id);
  if (!member) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true });
});

module.exports = router;
