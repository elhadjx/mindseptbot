const Settings = require('../db/models/Settings');
const User = require('../db/models/User');
const AuditLog = require('../db/models/AuditLog');
const { triggerDoor, DOORS } = require('../doors/door-service');
const { bus, EVENTS } = require('../events');
const { parseCommand } = require('./command-router');
const { identifyMessageSender } = require('./identity');
const rateLimiter = require('./rate-limiter');

const REACTIONS = {
  granted: '✅',
  denied: '⛔',
  error: '⚠️',
};

const MESSAGES = {
  denied_not_whitelisted: "Tu n'es pas sur la liste. Demande à un admin de t'ajouter.",
  denied_rate_limited: 'Trop de demandes, réessaie dans un instant.',
  denied_door_disabled: 'Cette porte est désactivée pour le moment.',
  denied_unknown_door: "Je ne connais pas cette porte.",
  granted: 'Ouvert 🚪',
  error: "Ça n'a pas marché, préviens un admin.",
};

async function record(entry) {
  try {
    await AuditLog.create(entry);
  } catch (err) {
    // A logging failure must never swallow a door open.
    console.error('[audit] write failed:', err.message);
  }
}

async function respond(msg, settings, decision, text) {
  const mode = settings.replyMode || 'react';
  try {
    if (mode === 'react' || mode === 'both') {
      await msg.react(REACTIONS[decision] || '');
    }
    if ((mode === 'text' || mode === 'both') && text) {
      await msg.reply(text);
    }
  } catch (err) {
    console.warn('[wa] could not respond to message:', err.message);
  }
}

/**
 * The full pipeline for one incoming group message.
 *
 * Order matters: scope and freshness are checked before anything expensive or
 * anything that writes, so unrelated chatter costs almost nothing and can't
 * pollute the audit log.
 */
async function handleMessage(client, msg) {
  const settings = await Settings.load();

  // 1. Scope - only the configured group. DMs and other groups are dropped
  //    silently and without a log entry.
  if (!settings.groupId || msg.from !== settings.groupId) return;

  // 2. Freshness - on reconnect whatsapp-web.js can replay a backlog. Without
  //    this guard, an hour-old "/open" would fire the relay on every restart.
  const ageSec = Date.now() / 1000 - Number(msg.timestamp || 0);
  if (Number.isFinite(ageSec) && ageSec > settings.maxMessageAgeSec) {
    console.log(`[wa] ignoring stale command (${Math.round(ageSec)}s old)`);
    return;
  }

  // 3. Parse - is this a command at all?
  const command = parseCommand(msg.body, settings);
  if (!command) return;

  // 4. Identify - raw JID plus best-effort LID/phone.
  const identity = await identifyMessageSender(client, msg);

  const base = {
    source: 'whatsapp',
    actorWaId: identity.waId,
    actorPhone: identity.phone,
    actorName: identity.name,
    door: command.door,
    command: command.raw,
    groupId: msg.from,
    messageId: msg.id?._serialized || null,
  };

  const deny = async (reason, text) => {
    await record({ ...base, decision: 'denied', reason });
    await respond(msg, settings, 'denied', text);
  };

  // 5. Authorize.
  const user = await User.findAuthorized(identity);
  if (!user) {
    console.log(`[wa] denied ${identity.waId} (${identity.phone || 'no phone'}) - not whitelisted`);
    return deny('not_whitelisted', MESSAGES.denied_not_whitelisted);
  }

  if (!DOORS[command.door]) {
    return deny('unknown_door', MESSAGES.denied_unknown_door);
  }
  if (settings.doorsEnabled?.get?.(command.door) === false) {
    return deny('door_disabled', MESSAGES.denied_door_disabled);
  }

  const perUser = rateLimiter.take(`user:${user._id}`, settings.rateLimitPerUserPerMin);
  if (!perUser.allowed) {
    return deny(`rate_limited_user (${perUser.count}/${perUser.limit} per min)`, MESSAGES.denied_rate_limited);
  }
  const global = rateLimiter.take('global', settings.rateLimitGlobalPerMin);
  if (!global.allowed) {
    return deny(`rate_limited_global (${global.count}/${global.limit} per min)`, MESSAGES.denied_rate_limited);
  }

  // 6. Open.
  const startedAt = Date.now();
  try {
    await triggerDoor(command.door, { pulseMs: settings.relayPulseMs });
    const durationMs = Date.now() - startedAt;

    await record({ ...base, decision: 'granted', durationMs });
    await respond(msg, settings, 'granted', MESSAGES.granted);

    await User.updateOne({ _id: user._id }, { $set: { lastOpenedAt: new Date() } });
    bus.emit(EVENTS.DOOR_OPENED, { door: command.door, actor: identity.name || identity.waId });

    console.log(`[wa] opened ${command.door} for ${user.displayName || identity.waId} in ${durationMs}ms`);
  } catch (err) {
    await record({
      ...base,
      decision: 'error',
      reason: err.message,
      durationMs: Date.now() - startedAt,
    });
    await respond(msg, settings, 'error', MESSAGES.error);
    console.error(`[wa] door trigger failed:`, err.message);
  }
}

module.exports = { handleMessage, REACTIONS, MESSAGES };
