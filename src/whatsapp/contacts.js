/**
 * Listing the contacts the linked account knows about.
 *
 * `client.getContacts()` is safer than getChats() - no groupMetadata refresh,
 * no LID migration - but it still runs one Promise.all over every contact and
 * calls `contact.serialize()` on each, returning the whole model when we want
 * six fields. Worse, `getContactModel` is synchronous code that can throw
 * (createWidFromWidLike, getAlternateUserWid, the Blocklist lookup), and one
 * throw inside that Promise.all rejects the entire listing - the same failure
 * mode that made getChats() unusable here.
 *
 * So we read the collection directly and project as we go, per contact, in a
 * try/catch: one unreadable contact costs one contact. `client.getContacts()`
 * stays as the fallback in case the internal module layout moves under us.
 */

async function listContactsFast(client) {
  return client.pupPage.evaluate(() => {
    const contacts = window.require('WAWebCollections').Contact.getModelsArray();
    const getters = (() => {
      try {
        return window.require('WAWebContactGetters');
      } catch {
        return null;
      }
    })();
    const frontend = (() => {
      try {
        return window.require('WAWebFrontendContactGetters');
      } catch {
        return null;
      }
    })();

    const out = [];
    for (const contact of contacts) {
      try {
        const id = contact.id;
        const server = id?.server;
        // Groups, status@broadcast, channels and the account itself are not
        // people we could ever whitelist.
        if (server !== 'c.us' && server !== 'lid') continue;
        if (getters?.getIsMe ? getters.getIsMe(contact) : contact.isMe) continue;

        const waId = id._serialized;
        // For a LID-addressed contact the number is only present when WhatsApp
        // has resolved it; null renders as "hidden" rather than a fake value.
        const phoneWid = contact.phoneNumber;
        const phone =
          server === 'c.us'
            ? String(id.user || '').replace(/\D/g, '')
            : String(phoneWid?.user || phoneWid || '').replace(/\D/g, '') || null;

        out.push({
          waId,
          lid: server === 'lid' ? waId : null,
          phone: phone || null,
          name: (getters?.getName ? getters.getName(contact) : contact.name) || '',
          pushname: (getters?.getPushname ? getters.getPushname(contact) : contact.pushname) || '',
          shortName:
            (getters?.getShortName ? getters.getShortName(contact) : contact.shortName) || '',
          // Saved in the phone's address book, as opposed to merely someone
          // this account has exchanged messages with.
          isMyContact: Boolean(
            frontend?.getIsMyContact ? frontend.getIsMyContact(contact) : contact.isMyContact
          ),
          isWAContact: Boolean(
            getters?.getIsWAContact ? getters.getIsWAContact(contact) : contact.isWAContact
          ),
          isBusiness: Boolean(contact.isBusiness || contact.isEnterprise),
          isBlocked: Boolean(contact.isContactBlocked),
        });
      } catch {
        // One malformed contact must not cost us the whole list.
      }
    }
    return out;
  });
}

async function listContactsViaGetContacts(client) {
  const contacts = await client.getContacts();
  return contacts
    .filter((c) => !c.isGroup && !c.isMe)
    .map((c) => ({
      waId: c.id?._serialized || String(c.id),
      lid: c.id?.server === 'lid' ? c.id._serialized : null,
      phone: c.number ? String(c.number).replace(/\D/g, '') : null,
      name: c.name || '',
      pushname: c.pushname || '',
      shortName: c.shortName || '',
      isMyContact: Boolean(c.isMyContact),
      isWAContact: Boolean(c.isWAContact),
      isBusiness: Boolean(c.isBusiness || c.isEnterprise),
      isBlocked: Boolean(c.isBlocked),
    }));
}

/** Best display name available, falling back to the number. */
function labelFor(contact) {
  return (
    contact.name ||
    contact.pushname ||
    contact.shortName ||
    (contact.phone ? `+${contact.phone}` : contact.waId)
  );
}

async function listContacts(client) {
  let contacts;
  try {
    contacts = await listContactsFast(client);
  } catch (err) {
    console.warn(`[wa] fast contact listing failed (${err.message}), falling back to getContacts()`);
    contacts = await listContactsViaGetContacts(client);
  }

  return contacts
    .map((contact) => ({ ...contact, label: labelFor(contact) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

module.exports = {
  listContacts,
  listContactsFast,
  listContactsViaGetContacts,
  labelFor,
};
