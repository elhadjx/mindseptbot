const express = require('express');
const multer = require('multer');
const { getClient } = require('../../whatsapp/client');
const { bus, EVENTS } = require('../../events');
const {
  listChats,
  fetchMessages,
  sendMessage,
  markRead,
  downloadMessageMedia,
  sendMedia,
} = require('../../whatsapp/messages');
const { describePageError, requireReady } = require('../wa');

const router = express.Router();

// Voice notes and phone photos run a few MB; 32MB covers those comfortably
// without letting someone upload something absurd through the panel.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024 } });

// The full inbox of the linked account - every chat, not just the doors the
// bot is configured to listen in.
router.get('/chats', requireReady, async (req, res) => {
  try {
    res.json({ ok: true, chats: await listChats(getClient()) });
  } catch (err) {
    console.error('[api] listing chats failed:', err);
    res.status(500).json({ ok: false, error: describePageError(err, 'Could not list chats') });
  }
});

router.get('/chats/:id/messages', requireReady, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const messages = await fetchMessages(getClient(), req.params.id, { limit });
    if (!messages) return res.status(404).json({ ok: false, error: 'chat_not_found' });
    res.json({ ok: true, messages });
  } catch (err) {
    console.error('[api] fetching messages failed:', err);
    res.status(500).json({ ok: false, error: describePageError(err, 'Could not load messages') });
  }
});

router.post('/chats/:id/messages', requireReady, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'empty_message' });
  try {
    const message = await sendMessage(getClient(), req.params.id, text);
    res.json({ ok: true, message });
  } catch (err) {
    console.error('[api] sending message failed:', err);
    res.status(500).json({ ok: false, error: describePageError(err, 'Could not send message') });
  }
});

router.post('/chats/:id/read', requireReady, async (req, res) => {
  try {
    await markRead(getClient(), req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[api] marking chat read failed:', err);
    res.status(500).json({ ok: false, error: describePageError(err, 'Could not mark as read') });
  }
});

router.post('/chats/:id/media', requireReady, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no_file' });
  try {
    const message = await sendMedia(getClient(), req.params.id, {
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      filename: req.file.originalname,
      caption: req.body?.caption ? String(req.body.caption) : undefined,
      asVoice: req.body?.voice === '1',
      asDocument: req.body?.asDocument === '1',
    });
    res.json({ ok: true, message });
  } catch (err) {
    console.error('[api] sending media failed:', err);
    res.status(500).json({ ok: false, error: describePageError(err, 'Could not send media') });
  }
});

// Media is fetched by id, lazily, one bubble at a time - not bundled into the
// message list - so opening a chat never triggers a burst of downloads.
router.get('/messages/:id/media', requireReady, async (req, res) => {
  try {
    const media = await downloadMessageMedia(getClient(), req.params.id);
    if (!media) return res.status(404).json({ ok: false, error: 'no_media' });
    res.set('Content-Type', media.mimetype || 'application/octet-stream');
    if (media.filename) {
      res.set('Content-Disposition', `inline; filename="${media.filename.replace(/"/g, '')}"`);
    }
    res.send(Buffer.from(media.data, 'base64'));
  } catch (err) {
    console.error('[api] downloading media failed:', err);
    res.status(500).json({ ok: false, error: describePageError(err, 'Could not download media') });
  }
});

// Server-sent events: live inbound/outbound messages, keyed by chat, so the
// panel can update the open conversation and the chat list without polling.
router.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  bus.on(EVENTS.WA_MESSAGE, send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    bus.off(EVENTS.WA_MESSAGE, send);
  });
});

module.exports = router;
