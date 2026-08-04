/**
 * Listing the groups the bot belongs to.
 *
 * The obvious call, `client.getChats()`, is unusable for this: its injected
 * helper builds a full model for EVERY chat in the account, and for each group
 * that includes `await groupMetadata.update(chatWid)` - a network round-trip -
 * plus LID migration of every participant. It runs the lot in one Promise.all,
 * so a single unhappy chat rejects the entire listing, and the rejection comes
 * from WhatsApp's own minified bundle (we saw it surface as `Error: r`).
 *
 * We only need id, name and a rough size, so read them straight off the chat
 * collection without touching the network, and tolerate individual failures.
 * `client.getChats()` stays as a fallback in case the internal module layout
 * moves under us.
 */

async function listGroupsFast(client) {
  return client.pupPage.evaluate(() => {
    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    const out = [];
    for (const chat of chats) {
      try {
        if (chat?.id?.server !== 'g.us') continue;
        out.push({
          id: chat.id._serialized,
          name: chat.formattedTitle || chat.name || '',
          // Only present when metadata happens to be cached. Null is fine -
          // the panel renders it as unknown rather than pretending it's zero.
          participantCount: chat.groupMetadata?.participants?.length ?? null,
        });
      } catch {
        // One malformed chat must not cost us the whole list.
      }
    }
    return out;
  });
}

async function listGroupsViaGetChats(client) {
  const chats = await client.getChats();
  return chats
    .filter((chat) => chat.isGroup)
    .map((chat) => ({
      id: chat.id._serialized,
      name: chat.name || '',
      participantCount: chat.participants?.length ?? null,
    }));
}

async function listGroups(client) {
  let groups;
  try {
    groups = await listGroupsFast(client);
  } catch (err) {
    console.warn(`[wa] fast group listing failed (${err.message}), falling back to getChats()`);
    groups = await listGroupsViaGetChats(client);
  }

  return groups
    .map((group) => ({ ...group, name: group.name || '(unnamed group)' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Raw participant ids for one group.
 *
 * `client.getChatById()` goes through the same `getChatModel` path as
 * getChats() - metadata refresh plus LID migration of every participant - so it
 * fails the same way. We read the cached metadata instead, only reaching for a
 * refresh when there is nothing cached, and never letting that refresh throw
 * away what we already have.
 *
 * Returns { found, isGroup, name, participants: [{waId, isAdmin}] }. Identity
 * enrichment (LID <-> phone, display names) happens in Node, where we already
 * handle per-participant failures.
 */
async function listParticipantsFast(client, groupId) {
  return client.pupPage.evaluate(async (chatId) => {
    const collections = window.require('WAWebCollections');
    const chat = collections.Chat.get(chatId);
    if (!chat) return { found: false };
    if (chat.id?.server !== 'g.us') return { found: true, isGroup: false };

    const readParticipants = () => {
      const raw = chat.groupMetadata?.participants;
      if (!raw) return [];
      // Depending on the build this is a Collection or a plain array.
      return typeof raw.getModelsArray === 'function' ? raw.getModelsArray() : Array.from(raw);
    };

    if (readParticipants().length === 0) {
      // Best effort: if the refresh fails we still return whatever is cached.
      try {
        const wid = window.require('WAWebWidFactory').createWid(chatId);
        const metadata =
          collections.GroupMetadata || collections.WAWebGroupMetadataCollection;
        await metadata.update(wid);
      } catch {
        /* keep going with what we have */
      }
    }

    const participants = [];
    for (const p of readParticipants()) {
      try {
        const waId = p.id?._serialized || String(p.id);
        if (waId) participants.push({ waId, isAdmin: Boolean(p.isAdmin || p.isSuperAdmin) });
      } catch {
        // Skip the individual participant, keep the group.
      }
    }

    return {
      found: true,
      isGroup: true,
      name: chat.formattedTitle || chat.name || '',
      participants,
    };
  }, groupId);
}

async function listParticipants(client, groupId) {
  try {
    const result = await listParticipantsFast(client, groupId);
    if (result?.found) return result;
    // Not in the local collection - fall through and let WhatsApp look it up.
  } catch (err) {
    console.warn(`[wa] fast participant listing failed (${err.message}), falling back`);
  }

  const chat = await client.getChatById(groupId);
  if (!chat) return { found: false };
  return {
    found: true,
    isGroup: Boolean(chat.isGroup),
    name: chat.name || '',
    participants: (chat.participants || []).map((p) => ({
      waId: p.id._serialized,
      isAdmin: Boolean(p.isAdmin || p.isSuperAdmin),
    })),
  };
}

module.exports = {
  listGroups,
  listGroupsFast,
  listGroupsViaGetChats,
  listParticipants,
  listParticipantsFast,
};
