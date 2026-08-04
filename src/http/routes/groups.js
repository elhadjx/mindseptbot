const express = require('express');
const { getClient, isReady } = require('../../whatsapp/client');
const { identifySender } = require('../../whatsapp/identity');
const { listGroups } = require('../../whatsapp/groups');

const router = express.Router();

/**
 * whatsapp-web.js runs much of its work inside WhatsApp's own minified bundle,
 * so a failure there arrives as a one-character message like "r". Passing that
 * to the panel tells nobody anything - say what we were doing instead, and keep
 * the original only when it looks like real text.
 */
function describePageError(err, context) {
  const message = String(err?.message || '').trim();
  const looksMinified = message.length < 3 || /^[a-z$_]\w?$/i.test(message);
  return looksMinified
    ? `${context}. WhatsApp Web returned an internal error - try again, or reconnect from the Connection tab.`
    : `${context}: ${message}`;
}

function requireReady(req, res, next) {
  if (!isReady()) {
    return res.status(409).json({ ok: false, error: 'whatsapp_not_ready' });
  }
  return next();
}

// Groups the bot number belongs to - the source list for the Settings picker.
router.get('/', requireReady, async (req, res) => {
  try {
    res.json({ ok: true, groups: await listGroups(getClient()) });
  } catch (err) {
    // Errors bubbling out of the page context are often a single minified
    // symbol, so log the whole thing server-side and send something an admin
    // can act on.
    console.error('[api] listing groups failed:', err);
    res.status(500).json({ ok: false, error: describePageError(err, 'Could not list groups') });
  }
});

// Participants of one group, with LID/phone resolved where WhatsApp allows it.
// This is what the Members screen enrolls from: picking people off this list
// captures the exact `waId` the bot will see on their messages, which is far
// more reliable than typing a phone number and hoping it matches.
router.get('/:id/participants', requireReady, async (req, res) => {
  try {
    const client = getClient();
    const chat = await client.getChatById(req.params.id);
    if (!chat?.isGroup) {
      return res.status(404).json({ ok: false, error: 'not_a_group' });
    }

    // allSettled, not all: one participant WhatsApp can't resolve must not cost
    // the admin the entire enrolment list.
    const settled = await Promise.allSettled(
      (chat.participants || []).map(async (participant) => {
        const waId = participant.id._serialized;
        const identity = await identifySender(client, waId);
        let name = '';
        try {
          const contact = await client.getContactById(waId);
          name = contact?.pushname || contact?.name || contact?.shortName || '';
        } catch {
          // Display name only - not worth failing the whole list over.
        }
        return {
          waId,
          lid: identity.lid,
          phone: identity.phone,
          name,
          isAdmin: Boolean(participant.isAdmin || participant.isSuperAdmin),
        };
      })
    );

    const participants = settled
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value);
    const skipped = settled.length - participants.length;
    if (skipped) console.warn(`[api] skipped ${skipped} unreadable participant(s)`);

    res.json({
      ok: true,
      groupId: chat.id._serialized,
      name: chat.name,
      participants,
      skipped,
    });
  } catch (err) {
    console.error('[api] listing participants failed:', err);
    res
      .status(500)
      .json({ ok: false, error: describePageError(err, 'Could not read that group') });
  }
});

module.exports = router;
