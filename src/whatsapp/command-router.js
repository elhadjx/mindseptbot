const { DOORS } = require('../doors/door-service');

const DOOR_ALIASES = {
  front: 'front',
  entree: 'front',
  entrée: 'front',
  immeuble: 'front',
  batiment: 'front',
  bâtiment: 'front',
  inner: 'inner',
  mind7: 'inner',
  coworking: 'inner',
};

function normalize(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    // Strip accents so "entrée" and "entree" both match.
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Match a message body against the configured keywords.
 *
 * Matching is anchored at the start of the message: "/open" and "ouvre la porte"
 * are commands, "je peux pas ouvre" is not. Keeps chatter in the group from
 * firing the relay.
 *
 * @returns {{keyword: string, door: string, raw: string}|null}
 */
function parseCommand(body, settings) {
  const text = normalize(body);
  if (!text) return null;

  const keywords = (settings.commandKeywords || []).map(normalize).filter(Boolean);
  // Longest first, so "/open" wins over "open" and we don't leave a stray "/".
  keywords.sort((a, b) => b.length - a.length);

  const keyword = keywords.find(
    (kw) => text === kw || text.startsWith(`${kw} `)
  );
  if (!keyword) return null;

  const rest = text.slice(keyword.length).trim();
  const requested = rest.split(/\s+/)[0];
  const door = DOOR_ALIASES[requested] || settings.defaultDoor || 'front';

  return { keyword, door, raw: String(body || '').trim() };
}

/** Is this door key something we know about at all? */
function isKnownDoor(door) {
  return Object.prototype.hasOwnProperty.call(DOORS, door);
}

module.exports = { parseCommand, isKnownDoor, DOOR_ALIASES };
