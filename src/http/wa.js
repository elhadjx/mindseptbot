// Shared bits for the routes that read live data out of the WhatsApp page.

const { isReady } = require('../whatsapp/client');

/**
 * whatsapp-web.js runs much of its work inside WhatsApp's own minified bundle,
 * so a failure there arrives as a one-character message like "r". Passing that
 * to the panel tells nobody anything - say what we were doing instead, and keep
 * the original only when it looks like real text.
 */
function describePageError(err, context) {
  const message = String(err?.message || '').trim();
  const looksMinified = message.length < 3 || /^[a-z$_]\w?$/i.test(message);
  return looksMinified
    ? `${context}. WhatsApp Web returned an internal error - try again, or reconnect from the Connection tab.`
    : `${context}: ${message}`;
}

function requireReady(req, res, next) {
  if (!isReady()) {
    return res.status(409).json({ ok: false, error: 'whatsapp_not_ready' });
  }
  return next();
}

module.exports = { describePageError, requireReady };
