const express = require('express');
const AuditLog = require('../../db/models/AuditLog');
const Settings = require('../../db/models/Settings');
const { listDoors, checkDoorOnline, triggerDoor, DOORS } = require('../../doors/door-service');
const { reportDoorOffline, reportDoorOnline, offlineDoorKeys } = require('../../doors/offline-alert');
const { bus, EVENTS } = require('../../events');

const router = express.Router();

router.get('/', async (req, res) => {
  const settings = await Settings.load();

  // The reachability probe is per door and hits Tuya, so run them together
  // rather than serially - this is on the panel's first paint. Live outage
  // state comes from /stream instead, which replays on connect.
  const doors = await Promise.all(
    listDoors().map(async (door) => ({
      ...door,
      enabled: settings.doorsEnabled?.get?.(door.key) !== false,
      // null means "couldn't tell", which the panel shows as unknown rather
      // than inventing a red or a green.
      online: door.configured ? await checkDoorOnline(door.key) : null,
    }))
  );
  res.json({ ok: true, doors });
});

// Live door health for the panel banner. Deliberately its own stream: the
// status one carries raw WhatsApp state objects, and giving those frames a type
// now would mean rewriting a parser that works.
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (type) => (payload) => res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  const onOffline = send('offline');
  const onOnline = send('online');

  // A tab opened mid-outage should show the banner immediately, not wait for
  // the next person to walk into a dead door.
  for (const door of offlineDoorKeys()) {
    onOffline({ door, label: DOORS[door]?.label || door });
  }

  bus.on(EVENTS.DOOR_OFFLINE, onOffline);
  bus.on(EVENTS.DOOR_ONLINE, onOnline);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    bus.off(EVENTS.DOOR_OFFLINE, onOffline);
    bus.off(EVENTS.DOOR_ONLINE, onOnline);
  });
});

// Manual open from the panel. Audited exactly like a WhatsApp command, just
// with source: 'panel' - "who opened the door" should have one answer, not two.
router.post('/:door/open', async (req, res) => {
  const { door } = req.params;
  const settings = await Settings.load();
  const startedAt = Date.now();
  const label = DOORS[door]?.label || door;

  const base = {
    source: 'panel',
    door,
    command: 'panel:open',
    actorName: 'Admin panel',
  };

  if (settings.doorsEnabled?.get?.(door) === false) {
    await AuditLog.create({ ...base, decision: 'denied', reason: 'door_disabled' });
    return res.status(409).json({ ok: false, error: 'door_disabled' });
  }

  try {
    const { simulated, recovered } = await triggerDoor(door, {
      pulseMs: settings.relayPulseMs,
      simulate: settings.testMode,
    });
    const durationMs = Date.now() - startedAt;
    reportDoorOnline({ door, label, simulated });
    await AuditLog.create({ ...base, decision: 'granted', durationMs, simulated });
    return res.json({ ok: true, door, durationMs, simulated, recovered });
  } catch (err) {
    const offline = Boolean(err.doorOffline);
    await AuditLog.create({
      ...base,
      decision: 'error',
      reason: offline ? `door_offline (${err.message})` : err.message,
      durationMs: Date.now() - startedAt,
    });
    console.error(`[${door}] trigger failed:`, err.message);

    if (offline) {
      await reportDoorOffline({ door, label, settings, actor: 'Admin panel' });
      return res.status(503).json({ ok: false, door, error: 'door_offline' });
    }
    return res.status(500).json({ ok: false, door, error: err.message });
  }
});

module.exports = router;
