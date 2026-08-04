const express = require('express');
const { getState, logoutWhatsApp } = require('../../whatsapp/client');
const { bus, EVENTS } = require('../../events');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ ok: true, wa: getState() });
});

// Server-sent events: the panel's Connection screen follows the QR and the
// connection state live instead of polling.
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Railway sits behind a proxy that would otherwise buffer the stream.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (state) => res.write(`data: ${JSON.stringify(state)}\n\n`);
  send(getState());

  bus.on(EVENTS.WA_STATE, send);
  // Comment frames keep intermediaries from closing an idle connection.
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    bus.off(EVENTS.WA_STATE, send);
  });
});

router.post('/logout', async (req, res) => {
  try {
    await logoutWhatsApp();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
