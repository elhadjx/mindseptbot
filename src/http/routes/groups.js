const express = require('express');
const { getClient, isReady } = require('../../whatsapp/client');
const { identifySender } = require('../../whatsapp/identity');

const router = express.Router();

function requireReady(req, res, next) {
  if (!isReady()) {
    return res.status(409).json({ ok: false, error: 'whatsapp_not_ready' });
  }
  return next();
}

// Groups the bot number belongs to - the source list for the Settings picker.
router.get('/', requireReady, async (req, res) => {
  try {
    const chats = await getClient().getChats();
    const groups = chats
      .filter((chat) => chat.isGroup)
      .map((chat) => ({
        id: chat.id._serialized,
        name: chat.name || '(no name)',
        participantCount: chat.participants?.length ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ ok: true, groups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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

    const participants = await Promise.all(
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

    res.json({ ok: true, groupId: chat.id._serialized, name: chat.name, participants });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
