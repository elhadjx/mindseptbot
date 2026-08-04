// Resolving "who sent this" is the fiddly part of the whole bot.
//
// WhatsApp is migrating group addressing to LIDs (Local Identifiers), so
// `msg.author` may be "<lid>@lid" instead of "<phone>@c.us", and Contact.number
// can come back empty for LID-addressed participants. We therefore always try
// to produce BOTH identifiers and let authorization match on either.
//
// The resolution itself reuses whatsapp-web.js's own injected helper
// (`window.WWebJS.enforceLidAndPnRetrieval`, src/util/Injected/Utils.js) rather
// than reimplementing the WAWebApiContact calls - it already handles the
// "identifier not cached yet, go ask the server" path.

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '') || null;
}

/**
 * Split a JID into its parts without touching the browser.
 * @param {string} jid e.g. "212661234567@c.us" or "18712345678901@lid"
 */
function parseJid(jid) {
  const raw = String(jid || '');
  const [user, server] = raw.split('@');
  return {
    raw,
    user: user || null,
    server: server || null,
    isLid: server === 'lid',
    isPhone: server === 'c.us',
  };
}

/**
 * Best-effort LID <-> phone resolution via the page context.
 * Returns {} when the client isn't ready or WhatsApp can't resolve it.
 */
async function resolveLidAndPhone(client, jid) {
  if (!client?.pupPage || client.pupPage.isClosed()) return {};
  try {
    return await client.pupPage.evaluate(
      (userId) => window.WWebJS.enforceLidAndPnRetrieval(userId),
      jid
    );
  } catch (err) {
    console.warn(`[identity] could not resolve ${jid}: ${err.message}`);
    return {};
  }
}

/**
 * Build the identity record used for authorization and audit logging.
 *
 * `waId` is always the raw JID exactly as it appeared on the message - that is
 * the exact-match fast path and needs no resolution at all. `lid` and `phone`
 * are enrichment: nice to have, never required.
 *
 * @returns {Promise<{waId: string, lid: string|null, phone: string|null, name: string}>}
 */
async function identifySender(client, jid, { name = '' } = {}) {
  const parsed = parseJid(jid);
  const identity = {
    waId: parsed.raw,
    lid: parsed.isLid ? parsed.raw : null,
    phone: parsed.isPhone ? digitsOnly(parsed.user) : null,
    name,
  };

  // Already have both? Nothing to ask the browser.
  if (identity.lid && identity.phone) return identity;

  const { lid, phone } = await resolveLidAndPhone(client, parsed.raw);
  if (lid?._serialized) identity.lid = lid._serialized;
  if (phone?.user) identity.phone = digitsOnly(phone.user);

  return identity;
}

/** Identity for a message, including the sender's WhatsApp display name. */
async function identifyMessageSender(client, msg) {
  const jid = msg.author || msg.from;
  let name = '';
  try {
    const contact = await msg.getContact();
    name = contact?.pushname || contact?.name || contact?.shortName || '';
  } catch {
    // Contact lookup is cosmetic - never let it block a door open.
  }
  return identifySender(client, jid, { name });
}

module.exports = {
  digitsOnly,
  parseJid,
  resolveLidAndPhone,
  identifySender,
  identifyMessageSender,
};
