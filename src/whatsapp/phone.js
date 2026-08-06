// Normalising phone numbers an admin *typed*.
//
// This is deliberately NOT `identity.digitsOnly`. That one cleans the user part
// out of a JID, where the number is always already full international - giving
// it country-code logic would mangle a LID like "18712345678901@lid" on its way
// through parseJid. Typed input is the opposite problem: people write their own
// number the way they say it out loud ("0549 21 20 25"), and WhatsApp only ever
// addresses them as "213549212025@c.us".

const MIN_DIGITS = 10; // shortest plausible international number, CC included
const MAX_DIGITS = 15; // E.164 ceiling

const DEFAULT_COUNTRY_CODE = '213';

/**
 * Turn anything an admin might type into the digits WhatsApp uses.
 *
 *   0549212025      -> 213549212025   (national, leading zero dropped)
 *   +213549212025   -> 213549212025   (already international)
 *   00213549212025  -> 213549212025   (same, dialled form)
 *   213549212025    -> 213549212025   (unchanged)
 *   549212025       -> 213549212025   (bare national number)
 *
 * @returns {string|null} digits only, or null when it can't be a real number.
 */
function normalizePhone(input, countryCode = DEFAULT_COUNTRY_CODE) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  const cc = String(countryCode || '').replace(/\D/g, '') || DEFAULT_COUNTRY_CODE;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  let full;
  // Order matters: the international forms are checked first, so "+213..." is
  // never mistaken for a national number that happens to start with a digit.
  if (raw.startsWith('+')) {
    full = digits;
  } else if (digits.startsWith('00')) {
    full = digits.slice(2);
  } else if (digits.startsWith('0')) {
    // No country calling code begins with 0, so a leading zero is unambiguously
    // the national trunk prefix.
    full = cc + digits.replace(/^0+/, '');
  } else if (digits.length >= MIN_DIGITS) {
    // Long enough to already carry a country code, so leave it alone. This is
    // what keeps a foreign member typed as "33612345678" from being read as an
    // Algerian number and turned into "21333612345678". The assumption is that
    // local numbers are shorter than MIN_DIGITS once the trunk 0 is dropped -
    // true for 213 (9 digits) and for every code where CC + national >= 10.
    full = digits;
  } else {
    // Too short to stand alone: a national number written without its 0.
    full = cc + digits;
  }

  if (full.startsWith('0')) return null;
  if (full.length < MIN_DIGITS || full.length > MAX_DIGITS) return null;
  return full;
}

/** Is this stored value written in national format (and so safe to rewrite)? */
function isNationalFormat(phone) {
  return /^0\d+$/.test(String(phone || ''));
}

/**
 * Repair members stored before normalisation existed.
 *
 * Runs at boot, is idempotent, and is intentionally timid: it only rewrites
 * phones that start with 0. No country calling code does, so "0549212025" can
 * only be a national number - whereas a stored "33612345678" is a perfectly
 * valid French member, and a naive "doesn't start with 213, so prepend 213"
 * pass would corrupt it into "21333612345678". Anything else that looks off is
 * logged for a human rather than rewritten.
 *
 * @param {import('mongoose').Model} User
 * @param {string} countryCode
 */
async function backfillPhones(User, countryCode = DEFAULT_COUNTRY_CODE) {
  const summary = { updated: 0, skipped: 0, flagged: 0 };

  // The whitelist is small by nature, so reading it whole is cheaper than being
  // clever, and it lets us flag the odd-looking rows in the same pass.
  const members = await User.find({ phone: { $ne: null } }, 'phone waId displayName').lean();

  for (const member of members) {
    const phone = String(member.phone || '');
    if (!phone) continue;

    if (!isNationalFormat(phone)) {
      // Not ours to touch - but say so if it still doesn't look canonical.
      const normalized = normalizePhone(phone, countryCode);
      if (normalized !== phone) {
        summary.flagged += 1;
        console.warn(
          `[phones] ${member.displayName || member._id} has an unusual number (${phone}) - ` +
            'left as-is, check it in Members'
        );
      }
      continue;
    }

    const normalized = normalizePhone(phone, countryCode);
    if (!normalized || normalized === phone) continue;

    const patch = { phone: normalized };
    // Only rewrite the waId when it was *derived* from the bad phone. A "@lid"
    // id, or any JID captured from a real message, is what WhatsApp actually
    // puts on that person's messages - it is authoritative and must survive.
    if (member.waId === `${phone}@c.us`) patch.waId = `${normalized}@c.us`;

    try {
      await User.updateOne({ _id: member._id }, { $set: patch });
      summary.updated += 1;
      console.log(`[phones] ${phone} -> ${normalized} (${member.displayName || member._id})`);
    } catch (err) {
      // phone and waId are unique+sparse, so normalising onto an existing row
      // collides. A duplicate member must never stop the door coming up.
      summary.skipped += 1;
      console.warn(
        `[phones] skipped ${phone} (${member.displayName || member._id}): ` +
          (err.code === 11000 ? `already enrolled as ${normalized}` : err.message)
      );
    }
  }

  if (summary.updated || summary.skipped || summary.flagged) {
    console.log(
      `[phones] backfill: ${summary.updated} normalised, ` +
        `${summary.skipped} skipped, ${summary.flagged} flagged`
    );
  }
  return summary;
}

module.exports = {
  DEFAULT_COUNTRY_CODE,
  normalizePhone,
  isNationalFormat,
  backfillPhones,
};
