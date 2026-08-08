/**
 * Tells the admin a door has stopped answering - once per outage, not once per
 * attempt.
 *
 * Ten people queued outside a dead door will each fire a command, and ten
 * identical buzzes teach an admin to swipe the alert away. So an outage is
 * latched per door: the first confirmed failure alerts, the rest are logged
 * only, and the latch clears when that door next opens. The panel still sees
 * every event on the bus - the dedupe is about the phone, not the dashboard.
 */

const { bus, EVENTS } = require('../events');
const { sendPush } = require('../notify/push');
const { getClient, isReady } = require('../whatsapp/client');
const { normalizePhone } = require('../whatsapp/phone');

// Doors currently believed to be down, so a repeat attempt stays quiet.
const offlineDoors = new Set();

/**
 * WhatsApp is the fallback channel, so it fires only when Web Push reached
 * nobody. It is also the one that can't be trusted to work: the bot's own
 * connection is exactly the kind of thing that breaks at the same time as
 * everything else, so every failure here is swallowed after logging.
 */
async function sendWhatsAppAlert(settings, text) {
  const phone = normalizePhone(settings.adminAlertPhone, settings.defaultCountryCode);
  if (!phone) return false;

  if (!isReady()) {
    console.warn('[alert] WhatsApp not connected - could not send the fallback alert');
    return false;
  }

  try {
    await getClient().sendMessage(`${phone}@c.us`, text);
    return true;
  } catch (err) {
    console.error('[alert] WhatsApp fallback failed:', err.message);
    return false;
  }
}

/**
 * Report a confirmed-offline door. Safe to call on every failed attempt.
 *
 * @param {object} params
 * @param {string} params.door       door key
 * @param {string} params.label      human label for the door
 * @param {object} params.settings   loaded Settings singleton
 * @param {string} [params.actor]    who was trying to get in
 */
async function reportDoorOffline({ door, label, settings, actor = '' }) {
  const firstOfOutage = !offlineDoors.has(door);
  offlineDoors.add(door);

  // The dashboard is cheap and stateless - it hears about every attempt.
  bus.emit(EVENTS.DOOR_OFFLINE, { door, label, at: new Date().toISOString(), actor });

  if (!firstOfOutage) {
    console.log(`[alert] ${label} still offline - admin already notified`);
    return;
  }

  const text =
    `⚠️ ${label} ne répond plus.\n` +
    (actor ? `Dernière tentative : ${actor}.\n` : '') +
    `Vérifie l'alimentation et le WiFi du relais.`;

  let delivered = 0;
  try {
    delivered = await sendPush({
      title: `${label} est hors ligne`,
      body: actor ? `Tentative de ${actor} - la porte n'a pas répondu.` : "La porte n'a pas répondu.",
      tag: `door-offline-${door}`,
    });
  } catch (err) {
    console.error('[alert] push delivery failed:', err.message);
  }

  if (delivered === 0) {
    await sendWhatsAppAlert(settings, text);
  }

  console.log(`[alert] ${label} offline - notified ${delivered} browser(s)`);
}

/**
 * Called after any successful open. Clears the latch so the next outage alerts
 * again, and lets the panel drop its banner.
 *
 * `simulated` is refused rather than left to callers: test mode never sends a
 * command, so a simulated success is no evidence the door is back, and one
 * caller forgetting that would silently bury a live outage.
 */
function reportDoorOnline({ door, label, simulated = false }) {
  if (simulated) return;
  if (!offlineDoors.delete(door)) return;
  bus.emit(EVENTS.DOOR_ONLINE, { door, label, at: new Date().toISOString() });
  console.log(`[alert] ${label} is answering again`);
}

/** Which doors are currently latched offline - seeds a freshly loaded panel. */
function offlineDoorKeys() {
  return [...offlineDoors];
}

module.exports = { reportDoorOffline, reportDoorOnline, offlineDoorKeys };
