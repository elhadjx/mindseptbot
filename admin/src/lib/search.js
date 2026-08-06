// Searching for people by number, the way people actually type numbers.
//
// A member is stored as "213549212025", but an admin searching for them will
// type "0549212025" - the form they read off a business card. Rather than
// duplicate the server's normalizePhone here, we only need the observation that
// makes it unnecessary: dropping the leading zeros from what was typed leaves a
// string that is a substring of the canonical number. "+213 549..." reduces to
// "213549..." and matches directly.

function phoneNeedles(query) {
  const digits = String(query || '').replace(/\D/g, '');
  if (!digits) return [];
  const needles = new Set([digits]);
  const national = digits.replace(/^0+/, '');
  if (national) needles.add(national);
  return [...needles];
}

/**
 * Build a matcher for one query.
 * @returns {{active: boolean, matches: (texts: any[], phones: any[]) => boolean}}
 */
export function makeSearch(query) {
  const q = String(query || '').trim().toLowerCase();
  const needles = phoneNeedles(q);

  return {
    active: Boolean(q),
    matches(texts = [], phones = []) {
      if (!q) return true;
      if (texts.some((value) => String(value || '').toLowerCase().includes(q))) return true;
      if (needles.length === 0) return false;
      return phones
        .map((value) => String(value || '').replace(/\D/g, ''))
        .filter(Boolean)
        .some((digits) => needles.some((needle) => digits.includes(needle)));
    },
  };
}
