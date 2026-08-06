const express = require('express');
const Settings = require('../../db/models/Settings');
const User = require('../../db/models/User');
const { digitsOnly, parseJid, identifySender } = require('../../whatsapp/identity');
const { normalizePhone } = require('../../whatsapp/phone');
const { getClient, isReady } = require('../../whatsapp/client');

const router = express.Router();

/**
 * Accept either a raw JID or a loosely typed phone number and normalise it into
 * the {waId, lid, phone} triple the User model stores.
 *
 * The typed number goes through normalizePhone, so national "0549212025" is
 * stored as "213549212025". A number that arrived alongside a JID - from the
 * participant or contact list - passes through untouched, because it is already
 * of full international length and normalizePhone leaves those alone.
 */
function normaliseIdentifiers({ waId, lid, phone }, countryCode) {
  const out = { waId: null, lid: null, phone: null };

  if (waId) {
    const parsed = parseJid(waId);
    out.waId = parsed.raw;
    if (parsed.isLid) out.lid = parsed.raw;
    if (parsed.isPhone) out.phone = digitsOnly(parsed.user);
  }
  if (lid) out.lid = parseJid(lid).raw;

  if (String(phone || '').trim()) {
    const typedPhone = normalizePhone(phone, countryCode);
    if (!typedPhone) return { ...out, invalidPhone: String(phone).trim() };
    out.phone = typedPhone;
    // A phone number with no JID yet still gives us a usable waId: that is
    // exactly the form a non-LID message arrives in.
    if (!out.waId) out.waId = `${typedPhone}@c.us`;
  }

  return out;
}

/**
 * Fill in the identifiers the caller couldn't know.
 *
 * Enrolling from the contact list gives us only a waId, so resolve its LID and
 * phone here - one page call for the one person being added. Doing it for a
 * whole contact list up front would be thousands of round-trips.
 */
async function enrich(ids) {
  if (!ids.waId || (ids.lid && ids.phone) || !isReady()) return ids;
  try {
    const identity = await identifySender(getClient(), ids.waId);
    return {
      ...ids,
      lid: ids.lid || identity.lid,
      phone: ids.phone || identity.phone,
    };
  } catch (err) {
    // Enrichment is a bonus - the raw waId already authorises that person.
    console.warn(`[api] could not enrich ${ids.waId}: ${err.message}`);
    return ids;
  }
}

router.get('/', async (req, res) => {
  const members = await User.find().sort({ displayName: 1, createdAt: 1 }).lean();
  res.json({ ok: true, members });
});

router.post('/', async (req, res) => {
  const { displayName = '', note = '', enabled = true } = req.body || {};
  const settings = await Settings.load();
  const parsed = normaliseIdentifiers(req.body || {}, settings.defaultCountryCode);

  if (parsed.invalidPhone) {
    return res
      .status(400)
      .json({ ok: false, error: `"${parsed.invalidPhone}" is not a usable phone number` });
  }
  if (!parsed.waId && !parsed.phone) {
    return res.status(400).json({ ok: false, error: 'need a phone number or a WhatsApp id' });
  }

  const ids = await enrich(parsed);

  try {
    // Upsert on identity so re-enrolling someone from the group list updates
    // them rather than colliding with the unique indexes.
    const existing = await User.findOne({
      $or: [
        ids.waId && { waId: ids.waId },
        ids.phone && { phone: ids.phone },
        // Someone enrolled by phone and then re-added from the contact list
        // arrives with a LID we may already hold - that is the same person.
        ids.lid && { lid: ids.lid },
      ].filter(Boolean),
    });

    if (existing) {
      // Only ever *add* identifiers. Enrolling the same person from a source
      // that knows less - a LID contact whose number WhatsApp won't resolve -
      // must not wipe a phone we already had, or authorization gets narrower
      // every time someone is re-added.
      for (const [key, value] of Object.entries(ids)) {
        if (value) existing[key] = value;
      }
      Object.assign(existing, {
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
  if ('phone' in (req.body || {})) {
    const settings = await Settings.load();
    const phone = normalizePhone(req.body.phone, settings.defaultCountryCode);
    if (!phone && String(req.body.phone || '').trim()) {
      return res
        .status(400)
        .json({ ok: false, error: `"${req.body.phone}" is not a usable phone number` });
    }
    patch.phone = phone;
  }

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
