const express = require('express');
const { getClient } = require('../../whatsapp/client');
const { identifySender } = require('../../whatsapp/identity');
const { listGroups, listParticipants } = require('../../whatsapp/groups');
const { describePageError, requireReady } = require('../wa');

const router = express.Router();

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
    const chat = await listParticipants(client, req.params.id);
    if (!chat.found) {
      return res.status(404).json({ ok: false, error: 'That chat is not loaded on this account.' });
    }
    if (!chat.isGroup) {
      return res.status(404).json({ ok: false, error: 'not_a_group' });
    }

    // allSettled, not all: one participant WhatsApp can't resolve must not cost
    // the admin the entire enrolment list.
    const settled = await Promise.allSettled(
      chat.participants.map(async (participant) => {
        const waId = participant.waId;
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
          isAdmin: Boolean(participant.isAdmin),
        };
      })
    );

    const participants = settled
      .filter((r) => r.status === 'fulfilled')
      .map((r) => r.value);
    const skipped = settled.length - participants.length;
    if (skipped) console.warn(`[api] skipped ${skipped} unreadable participant(s)`);

    res.json({ ok: true, groupId: req.params.id, name: chat.name, participants, skipped });
  } catch (err) {
    console.error('[api] listing participants failed:', err);
    res
      .status(500)
      .json({ ok: false, error: describePageError(err, 'Could not read that group') });
  }
});

module.exports = router;
