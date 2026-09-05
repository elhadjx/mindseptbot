const Settings = require('../db/models/Settings');
const User = require('../db/models/User');
const AuditLog = require('../db/models/AuditLog');
const { triggerDoor, DOORS } = require('../doors/door-service');
const {
  reportDoorOffline,
  reportDoorConfirmedOffline,
  reportDoorOnline,
} = require('../doors/offline-alert');
const { bus, EVENTS } = require('../events');
const { parseCommand } = require('./command-router');
const { chatHasQuestion, parseAnswer, rememberQuestion, takeQuestion } = require('./confirmations');
const { identifyMessageSender } = require('./identity');
const { renderReply } = require('./replies');
const rateLimiter = require('./rate-limiter');

/** @returns the stored document, or null - a logging failure is not fatal. */
async function record(entry) {
  try {
    return await AuditLog.create(entry);
  } catch (err) {
    // A logging failure must never swallow a door open.
    console.error('[audit] write failed:', err.message);
    return null;
  }
}

/**
 * Answer a command using the admin-configured wording for `outcome`.
 *
 * An empty emoji or an empty text means "stay quiet on this one" - that is a
 * supported configuration, not a missing value.
 */
async function respond(msg, settings, outcome, vars = {}) {
  const mode = settings.replyMode || 'react';
  const { emoji, text } = renderReply(settings, outcome, vars);
  try {
    if ((mode === 'react' || mode === 'both') && emoji) {
      await msg.react(emoji);
    }
    if ((mode === 'text' || mode === 'both') && text) {
      await msg.reply(text);
    }
  } catch (err) {
    console.warn('[wa] could not respond to message:', err.message);
  }
}

/**
 * The full pipeline for one incoming message.
 *
 * Order matters: scope and freshness are checked before anything expensive or
 * anything that writes, so unrelated chatter costs almost nothing and can't
 * pollute the audit log.
 */
async function handleMessage(client, msg) {
  const settings = await Settings.load();

  // Our own messages are never commands. MESSAGE_RECEIVED normally doesn't
  // carry them, but a takeover or a sync can.
  if (msg.fromMe) return;

  // 1. Scope - the configured groups, plus one-to-one chats when those are
  //    enabled. Everything else (other groups, status, broadcast lists,
  //    channels) is dropped silently and without a log entry.
  const scope = settings.chatScope(msg.from);
  if (!scope) return;

  // 2. Freshness - on reconnect whatsapp-web.js can replay a backlog. Without
  //    this guard, an hour-old "/open" would fire the relay on every restart.
  const ageSec = Date.now() / 1000 - Number(msg.timestamp || 0);
  if (Number.isFinite(ageSec) && ageSec > settings.maxMessageAgeSec) {
    console.log(`[wa] ignoring stale command (${Math.round(ageSec)}s old)`);
    return;
  }

  // 3. Parse - is this a command at all?
  const command = parseCommand(msg.body, settings);
  // Not a command, but it may be the answer to one: a door that read offline
  // was asked about, and only the person at the door can settle it.
  if (!command) return resolveConfirmation(client, msg, settings);

  // 4. Identify - raw JID plus best-effort LID/phone.
  const identity = await identifyMessageSender(client, msg);

  const base = {
    source: 'whatsapp',
    actorWaId: identity.waId,
    actorPhone: identity.phone,
    actorName: identity.name,
    door: command.door,
    command: command.raw,
    chatType: scope,
    chatId: msg.from,
    groupId: scope === 'group' ? msg.from : null,
    messageId: msg.id?._serialized || null,
  };

  // Placeholders an admin can use in the configured reply text.
  const vars = {
    name: identity.name || identity.phone || 'toi',
    door: DOORS[command.door]?.label || command.door,
  };

  // `outcome` picks the wording; `reason` is the machine-readable audit note,
  // which carries detail (counts, limits) we don't want in a group message.
  const deny = async (outcome, reason, { silent = false } = {}) => {
    await record({ ...base, decision: 'denied', reason });
    if (!silent) await respond(msg, settings, outcome, vars);
  };

  // 5. Authorize.
  const user = await User.findAuthorized(identity);
  if (!user) {
    console.log(`[wa] denied ${identity.waId} (${identity.phone || 'no phone'}) - not whitelisted`);
    // In a group, ⛔ is useful feedback to someone already in a room we trust.
    // In a DM it answers a stranger, confirming this number runs a door bot to
    // anyone who guesses it - and denials aren't rate limited. Log, stay quiet.
    return deny('denied_not_whitelisted', 'not_whitelisted', { silent: scope === 'dm' });
  }

  if (!DOORS[command.door]) {
    return deny('denied_unknown_door', 'unknown_door');
  }
  if (settings.doorsEnabled?.get?.(command.door) === false) {
    return deny('denied_door_disabled', 'door_disabled');
  }

  vars.name = user.displayName || vars.name;

  const perUser = rateLimiter.take(`user:${user._id}`, settings.rateLimitPerUserPerMin);
  if (!perUser.allowed) {
    return deny(
      'denied_rate_limited',
      `rate_limited_user (${perUser.count}/${perUser.limit} per min)`
    );
  }
  const global = rateLimiter.take('global', settings.rateLimitGlobalPerMin);
  if (!global.allowed) {
    return deny(
      'denied_rate_limited',
      `rate_limited_global (${global.count}/${global.limit} per min)`
    );
  }

  // 6. Open.
  const startedAt = Date.now();
  try {
    const { simulated, unconfirmed, reason } = await triggerDoor(command.door, {
      pulseMs: settings.relayPulseMs,
      simulate: settings.testMode,
    });
    const durationMs = Date.now() - startedAt;
    const actor = user.displayName || identity.name || identity.waId;

    // Nothing proved the door opened: the provider returned an explicitly
    // unconfirmed result. This is not reported as an open; the member is
    // asked, the admin is alerted, and the row is marked unconfirmed until
    // somebody says otherwise.
    if (unconfirmed) {
      const entry = await record({
        ...base,
        decision: 'granted',
        reason: `sent_unconfirmed (${reason})`,
        durationMs,
        simulated,
        unconfirmed: true,
      });
      await respond(msg, settings, 'granted_unconfirmed', vars);
      await reportDoorOffline({ door: command.door, label: vars.door, settings, actor });

      rememberQuestion({
        chatId: msg.from,
        actorKey: identity.waId,
        auditId: entry?._id,
        door: command.door,
        label: vars.door,
        userId: user._id,
        actorName: actor,
      });

      console.log(
        `[wa] ${command.door} unconfirmed (${reason}) for ${actor} - awaiting confirmation`
      );
      return;
    }

    // The active provider completed the pulse, so its earlier reachability
    // snapshot is history.
    reportDoorOnline({ door: command.door, label: vars.door, simulated });

    await record({ ...base, decision: 'granted', durationMs, simulated });
    await respond(msg, settings, simulated ? 'simulated' : 'granted', vars);

    await User.updateOne({ _id: user._id }, { $set: { lastOpenedAt: new Date() } });
    bus.emit(EVENTS.DOOR_OPENED, { door: command.door, actor: identity.name || identity.waId });

    console.log(
      `[wa] ${simulated ? 'SIMULATED open of' : 'opened'} ${command.door} for ` +
        `${user.displayName || identity.waId} in ${durationMs}ms`
    );
  } catch (err) {
    const offline = Boolean(err.doorOffline);
    await record({
      ...base,
      decision: 'error',
      reason: offline ? `door_offline (${err.message})` : err.message,
      durationMs: Date.now() - startedAt,
    });
    await respond(msg, settings, offline ? 'door_offline' : 'error', vars);
    console.error(`[wa] door trigger failed:`, err.message);

    if (offline) {
      await reportDoorOffline({
        door: command.door,
        label: vars.door,
        settings,
        actor: user.displayName || identity.name || identity.waId,
      });
    }
  }
}

/**
 * Handle a message that isn't a command but might be an answer to "did it
 * open?".
 *
 * The checks are ordered by cost, because every non-command message in every
 * listened group lands here: a Map lookup, then a regex over the text, and
 * only then the round trip that identifies the sender. A quiet group with no
 * question outstanding pays for one Map lookup.
 *
 * An unrecognised message is left entirely alone - no reply, no log. People
 * talk in these groups, and a bot that argued with anything it couldn't parse
 * would be worse than one that waits.
 */
async function resolveConfirmation(client, msg, settings) {
  if (!chatHasQuestion(msg.from)) return;

  const answer = parseAnswer(msg.body);
  if (!answer) return;

  const identity = await identifyMessageSender(client, msg);
  const question = takeQuestion(msg.from, identity.waId);
  if (!question) return;

  const vars = { name: question.actorName || identity.name || 'toi', door: question.label };

  if (answer === 'yes') {
    // A person watched it open. That outranks anything the provider reports, so the
    // outage is over as far as the panel and the alerts are concerned.
    if (question.auditId) {
      await AuditLog.updateOne(
        { _id: question.auditId },
        { $set: { unconfirmed: false, confirmedOpen: true, reason: 'confirmed_open_by_member' } }
      ).catch((err) => console.error('[audit] confirmation write failed:', err.message));
    }
    reportDoorOnline({ door: question.door, label: question.label });
    if (question.userId) {
      await User.updateOne({ _id: question.userId }, { $set: { lastOpenedAt: new Date() } });
    }
    bus.emit(EVENTS.DOOR_OPENED, { door: question.door, actor: question.actorName });
    await respond(msg, settings, 'confirm_opened', vars);
    console.log(`[wa] ${question.door} confirmed open by ${question.actorName}`);
    return;
  }

  // Confirmed shut. The row said "granted" on the strength of a command we
  // sent blind; it is now known to be wrong, so it is corrected rather than
  // left standing next to the ones that really opened.
  if (question.auditId) {
    await AuditLog.updateOne(
      { _id: question.auditId },
      {
        $set: {
          decision: 'error',
          unconfirmed: false,
          confirmedOpen: false,
          reason: 'door_offline (confirmed by member)',
        },
      }
    ).catch((err) => console.error('[audit] confirmation write failed:', err.message));
  }
  await reportDoorConfirmedOffline({
    door: question.door,
    label: question.label,
    settings,
    actor: question.actorName,
  });
  await respond(msg, settings, 'confirm_failed', vars);
  console.log(`[wa] ${question.door} confirmed dead by ${question.actorName}`);
}

module.exports = { handleMessage };
