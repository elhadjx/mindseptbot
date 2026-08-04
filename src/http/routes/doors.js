const express = require('express');
const AuditLog = require('../../db/models/AuditLog');
const Settings = require('../../db/models/Settings');
const { listDoors, triggerDoor } = require('../../doors/door-service');

const router = express.Router();

router.get('/', async (req, res) => {
  const settings = await Settings.load();
  const doors = listDoors().map((door) => ({
    ...door,
    enabled: settings.doorsEnabled?.get?.(door.key) !== false,
  }));
  res.json({ ok: true, doors });
});

// Manual open from the panel. Audited exactly like a WhatsApp command, just
// with source: 'panel' - "who opened the door" should have one answer, not two.
router.post('/:door/open', async (req, res) => {
  const { door } = req.params;
  const settings = await Settings.load();
  const startedAt = Date.now();

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
    await triggerDoor(door, { pulseMs: settings.relayPulseMs });
    const durationMs = Date.now() - startedAt;
    await AuditLog.create({ ...base, decision: 'granted', durationMs });
    return res.json({ ok: true, door, durationMs });
  } catch (err) {
    await AuditLog.create({
      ...base,
      decision: 'error',
      reason: err.message,
      durationMs: Date.now() - startedAt,
    });
    console.error(`[${door}] trigger failed:`, err.message);
    return res.status(500).json({ ok: false, door, error: err.message });
  }
});

module.exports = router;
