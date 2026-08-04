const { config } = require('./config');
const { connectMongo } = require('./db/mongo');
const Settings = require('./db/models/Settings');
const { createApp } = require('./http/app');
const { startWhatsApp, getClient } = require('./whatsapp/client');
const { handleMessage } = require('./whatsapp/handlers');

async function main() {
  await connectMongo();
  await Settings.load();

  // The panel comes up first and independently of WhatsApp: if linking fails,
  // an admin still needs somewhere to see the QR and the error.
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Mindsept door access listening on http://localhost:${config.port}`);
  });

  startWhatsApp((msg) => handleMessage(getClient(), msg)).catch((err) => {
    console.error('[wa] failed to start:', err);
  });

  const shutdown = async (signal) => {
    console.log(`\n[app] ${signal} - shutting down`);
    server.close();
    try {
      await getClient()?.destroy();
    } catch {
      // Already gone; nothing to clean up.
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[app] fatal:', err);
  process.exit(1);
});
