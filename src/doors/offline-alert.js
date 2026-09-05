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

// Doors a person has told us stayed shut. Latched separately from the above so
// the upgrade from "the provider says it is not answering" to "someone
// standing there watched it not open" is worth exactly one more buzz per outage.
const confirmedDoors = new Set();

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

  await notify({
    settings,
    text,
    title: `${label} est hors ligne`,
    body: actor ? `Tentative de ${actor} - la porte n'a pas répondu.` : "La porte n'a pas répondu.",
    tag: `door-offline-${door}`,
    log: `${label} offline`,
  });
}

/** Push first, WhatsApp only if push reached nobody. */
async function notify({ settings, text, title, body, tag, log }) {
  let delivered = 0;
  try {
    delivered = await sendPush({ title, body, tag });
  } catch (err) {
    console.error('[alert] push delivery failed:', err.message);
  }

  if (delivered === 0) {
    await sendWhatsAppAlert(settings, text);
  }

  console.log(`[alert] ${log} - notified ${delivered} browser(s)`);
}

/**
 * Someone was asked whether the door opened and said no.
 *
 * This is the only hard evidence of an outage the system can get - provider
 * state can lag and its command acknowledgement means nothing - so it alerts
 * even when the door was already latched offline by the probe. Once per
 * outage, though: the tenth person confirming the same dead door adds nothing.
 */
async function reportDoorConfirmedOffline({ door, label, settings, actor = '' }) {
  offlineDoors.add(door);
  bus.emit(EVENTS.DOOR_OFFLINE, { door, label, at: new Date().toISOString(), actor });

  if (confirmedDoors.has(door)) {
    console.log(`[alert] ${label} confirmed dead again - admin already notified`);
    return;
  }
  confirmedDoors.add(door);

  await notify({
    settings,
    text:
      `🚪 ${label} est confirmée en panne.\n` +
      (actor ? `${actor} a essayé : la porte ne s'est pas ouverte.\n` : '') +
      `Ce n'est plus une supposition - quelqu'un était devant.`,
    title: `${label} ne s'ouvre pas`,
    body: actor
      ? `${actor} confirme que la porte ne s'est pas ouverte.`
      : "Confirmé sur place : la porte ne s'ouvre pas.",
    tag: `door-offline-${door}`,
    log: `${label} confirmed dead by a member`,
  });
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
  confirmedDoors.delete(door);
  if (!offlineDoors.delete(door)) return;
  bus.emit(EVENTS.DOOR_ONLINE, { door, label, at: new Date().toISOString() });
  console.log(`[alert] ${label} is answering again`);
}

/** Which doors are currently latched offline - seeds a freshly loaded panel. */
function offlineDoorKeys() {
  return [...offlineDoors];
}

module.exports = {
  reportDoorOffline,
  reportDoorConfirmedOffline,
  reportDoorOnline,
  offlineDoorKeys,
};
