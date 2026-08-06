// A preview of what the server will store, shown under the number field so an
// admin can see "0549212025" become "+213549212025" before saving.
//
// The server's src/whatsapp/phone.js is the authority - it re-normalises every
// number on save, and rejects what it can't read. This mirrors its rules so the
// panel can show the result immediately; if the two ever disagree, the server
// wins and the form reports its error.

export function previewPhone(input, countryCode = '213') {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  const cc = String(countryCode || '213').replace(/\D/g, '') || '213';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  let full;
  if (raw.startsWith('+')) full = digits;
  else if (digits.startsWith('00')) full = digits.slice(2);
  else if (digits.startsWith('0')) full = cc + digits.replace(/^0+/, '');
  else if (digits.length >= 10) full = digits;
  else full = cc + digits;

  if (full.startsWith('0') || full.length < 10 || full.length > 15) return null;
  return full;
}
