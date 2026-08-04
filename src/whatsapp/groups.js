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

module.exports = { listGroups, listGroupsFast, listGroupsViaGetChats };
