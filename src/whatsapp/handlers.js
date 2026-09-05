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
const { doorAI, isDoorIntentCandidate } = require('../ai/door-ai');
const { sendGifReply } = require('./gif-replies');
const rateLimiter = require('./rate-limiter');
const requestCooldown = require('./request-cooldown');

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
async function respond(msg, settings, outcome, vars = {}, context = {}) {
  const mode = settings.replyMode || 'react';
  const { emoji, text } = renderReply(settings, outcome, vars);

  // The reaction is the immediate, deterministic acknowledgement. AI is only
  // considered afterwards, and a failure here must not suppress the text.
  try {
    if ((mode === 'react' || mode === 'both') && emoji) {
      await msg.react(emoji);
    }
  } catch (err) {
    console.warn('[wa] could not react to message:', err.message);
  }

  if (!((mode === 'text' || mode === 'both') && text)) return;

  let generated = null;
  if (settings.aiRepliesEnabled && context.scope === 'group' && context.authorized) {
    generated = await doorAI.rewriteReply({
      outcome,
      canonicalReply: text,
      name: context.name || vars.name,
      message: context.message || '',
      allowGifs: settings.aiGifRepliesEnabled !== false,
      gifChancePct: settings.aiGifChancePct,
      provider: settings.aiProvider || 'openai',
    });
  }

  try {
    if (generated?.mode === 'gif') {
      await sendGifReply(msg, generated.gifId);
      return;
    }
    await msg.reply(generated?.reply || text);
  } catch (err) {
    console.warn('[wa] could not send generated response:', err.message);
    // A missing/corrupt bundled clip should not leave a member with only a
    // mysterious reaction. Make one best-effort attempt with the fixed text.
    if (generated?.mode === 'gif') {
      try {
        await msg.reply(text);
      } catch (fallbackErr) {
        console.warn('[wa] could not send fallback response:', fallbackErr.message);
      }
    }
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
  let command = parseCommand(msg.body, settings);
  let naturalLanguageCandidate = false;
  // Not a command, but it may be the answer to one: a door that read offline
  // was asked about, and only the person at the door can settle it.
  if (!command) {
    const confirmationHandled = await resolveConfirmation(client, msg, settings, scope);
    if (confirmationHandled) return;

    // Natural language is group-only and opt-in. Quotes and forwards are
    // excluded even if their text contains a perfect request: the author of
    // this message is not necessarily the person asking to enter.
    if (
      scope !== 'group' ||
      !settings.aiNaturalLanguageEnabled ||
      msg.hasQuotedMsg ||
      msg.isForwarded ||
      !isDoorIntentCandidate(msg.body)
    ) {
      return;
    }

    naturalLanguageCandidate = true;
    command = {
      keyword: 'ai-natural-language',
      door: settings.defaultDoor || 'front',
      raw: String(msg.body || '').trim(),
    };
  }

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
    // A natural sentence should never reveal the whitelist or the presence of
    // the bot. Exact configured commands preserve their existing feedback.
    if (naturalLanguageCandidate) return;
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

  const replyContext = {
    scope,
    authorized: true,
    name: vars.name,
    message: msg.body,
  };

  const cooldownKey = `${scope}:${msg.from}:${user._id}:${command.door}`;
  const cooldownRemaining = requestCooldown.remainingMs(
    cooldownKey,
    settings.doorRequestCooldownMinutes
  );
  if (cooldownRemaining > 0) {
    return deny('denied_rate_limited', `cooldown_ignored (${Math.ceil(cooldownRemaining / 1000)}s)`, {
      silent: true,
    });
  }

  // The local candidate gate above kept ordinary chatter private. The model
  // is the second, conservative check; uncertainty or an API outage is a
  // silent no, while explicit `/open` commands never depend on it.
  if (
    naturalLanguageCandidate &&
    !(await doorAI.classifyDoorIntent(msg.body, { provider: settings.aiProvider || 'openai' }))
  ) {
    return;
  }

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

  // Start the quiet period only once the request has passed authorization,
  // recognition and the existing burst limits. take() also closes the small
  // race where two messages were being classified concurrently.
  const cooldown = requestCooldown.take(cooldownKey, settings.doorRequestCooldownMinutes);
  if (!cooldown.allowed) {
    return deny('denied_rate_limited', `cooldown_ignored (${cooldown.retryAfterSec}s)`, {
      silent: true,
    });
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
      await respond(msg, settings, 'granted_unconfirmed', vars, replyContext);
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
    await respond(msg, settings, simulated ? 'simulated' : 'granted', vars, replyContext);

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
    await respond(msg, settings, offline ? 'door_offline' : 'error', vars, replyContext);
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
async function resolveConfirmation(client, msg, settings, scope) {
  if (!chatHasQuestion(msg.from)) return false;

  const answer = parseAnswer(msg.body);
  if (!answer) return false;

  const identity = await identifyMessageSender(client, msg);
  const question = takeQuestion(msg.from, identity.waId);
  if (!question) return false;

  const vars = { name: question.actorName || identity.name || 'toi', door: question.label };
  const replyContext = {
    scope,
    authorized: true,
    name: vars.name,
    message: msg.body,
  };

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
    await respond(msg, settings, 'confirm_opened', vars, replyContext);
    console.log(`[wa] ${question.door} confirmed open by ${question.actorName}`);
    return true;
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
  await respond(msg, settings, 'confirm_failed', vars, replyContext);
  console.log(`[wa] ${question.door} confirmed dead by ${question.actorName}`);
  return true;
}

module.exports = { handleMessage, respond, resolveConfirmation };
