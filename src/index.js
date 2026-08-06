const { config } = require('./config');
const { connectMongo } = require('./db/mongo');
const Settings = require('./db/models/Settings');
const Credentials = require('./db/models/Credentials');
const User = require('./db/models/User');
const { backfillPhones } = require('./whatsapp/phone');
const { createApp } = require('./http/app');
const { startWhatsApp, stopWhatsApp, getClient } = require('./whatsapp/client');
const { handleMessage } = require('./whatsapp/handlers');

// RemoteAuth runs its periodic backup as `setInterval(async () => ...)` with no
// catch of its own, so a single failed backup becomes an unhandled rejection -
// which Node terminates the process for. Restarting on a failed *backup* is the
// worst possible response: it drops the session we were trying to protect and
// forces a re-scan. Log loudly and keep the door working instead.
function installCrashGuards() {
  process.on('unhandledRejection', (reason) => {
    console.error('[app] unhandled rejection (continuing):', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[app] uncaught exception (continuing):', err);
  });
}

async function main() {
  installCrashGuards();

  await connectMongo();
  const settings = await Settings.load();
  await Credentials.load();

  // Repairs members enrolled before phone normalisation existed. Idempotent, so
  // it costs nothing on every boot after the first - which is the point: there
  // is no migration script anyone has to remember to run.
  await backfillPhones(User, settings.defaultCountryCode).catch((err) =>
    console.error('[phones] backfill failed (continuing):', err.message)
  );

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
    stopWhatsApp();
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
