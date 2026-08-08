require('dotenv').config();

// Collect every missing var rather than throwing on the first one. On a
// platform that restarts the container on exit, failing one at a time means one
// crash-loop per missing variable.
const missing = [];

function required(name) {
  const value = process.env[name];
  if (!value) {
    missing.push(name);
    return null;
  }
  return value;
}

// A missing variable is an operator problem, not a bug - print something
// readable and exit rather than dumping a stack trace into the deploy log.
function assertConfigured() {
  if (missing.length === 0) return;
  console.error(
    [
      '',
      `Cannot start: missing required environment variable${missing.length > 1 ? 's' : ''}.`,
      '',
      ...missing.map((name) => `  - ${name}`),
      '',
      'Set these in your deployment environment (or .env locally).',
      'See .env.example for what each one is.',
      '',
      'On Railway, reference the database service instead of pasting a URL:',
      '  MONGODB_URI=${{MongoDB.MONGO_URL}}',
      '',
    ].join('\n')
  );
  process.exit(1);
}

const isProd = process.env.NODE_ENV === 'production';

const config = {
  isProd,
  port: Number(process.env.PORT) || 3000,

  mongoUri: required('MONGODB_URI'),

  // Prepended to member phone numbers typed in national format ("0549212025").
  // Only seeds the Settings singleton on first boot; the panel owns it after
  // that. 213 = Algeria.
  defaultCountryCode: (process.env.DEFAULT_COUNTRY_CODE || '213').replace(/\D/g, ''),

  admin: {
    password: required('ADMIN_PASSWORD'),
    sessionSecret: required('SESSION_SECRET'),
    // How long a panel login stays valid. 30 days because the panel is meant to
    // be installed to a phone's home screen and woken by door alerts - and iOS
    // gives an installed app its own cookie jar, so a short session means
    // re-authenticating on the device you most need to answer from. The trade
    // is a longer-lived credential on a phone; the panel is behind one password
    // and a lost phone means revoking it by changing that password.
    sessionMaxAgeMs: Number(process.env.ADMIN_SESSION_MAX_AGE_MS) || 30 * 24 * 60 * 60 * 1000,
  },

  tuya: {
    accessId: required('TUYA_ACCESS_ID'),
    accessSecret: required('TUYA_ACCESS_SECRET'),
    region: process.env.TUYA_REGION || 'eu',
  },

  doors: {
    frontDeviceId: process.env.DOOR_FRONT_DEVICE_ID,
    relayPulseMs: Number(process.env.RELAY_PULSE_MS) || 1000,
    // Tuya marks a device offline on a heartbeat timeout, so a single "offline"
    // reading is often just a gap. Wait this long and ask once more before
    // believing it.
    offlineRecheckMs: Number(process.env.DOOR_OFFLINE_RECHECK_MS) || 3000,
  },

  // Web Push for the admin panel.
  //
  // These keys are baked in so the panel works on a fresh deploy with nothing
  // configured. They are a deliberate exception to "secrets come from env", and
  // only defensible because this repo is private: a VAPID pair identifies this
  // server to the push services, and anyone holding the private key plus a
  // subscription endpoint could send notifications that look like ours.
  // Endpoints live in Mongo, not here, so the key alone isn't enough - but if
  // this repo is ever made public or shared, rotate with `npm run keys:vapid`
  // and move them to the env vars below, which still take precedence.
  push: {
    publicKey:
      process.env.VAPID_PUBLIC_KEY ||
      'BNtxmEqo9oBDxcxRKaOlpAZ8-j5rC6Qo49ppstXUYWHksg-9jdoqMjhj2wNJhaubF1VsRGQCekP0-bH31TtS3Jo',
    privateKey: process.env.VAPID_PRIVATE_KEY || 'lAT0Nq8A9v7cVE329yB5ANs3EIGbOBcXWndtlm1A4ak',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@mindsept.local',
  },

  whatsapp: {
    // Distinguishes sessions sharing one database (e.g. staging vs prod).
    clientId: process.env.WA_CLIENT_ID || 'mindsept',
    // RemoteAuth rejects anything below 60000, and every missed backup is a
    // window where a restart loses the link - so sync at the minimum.
    backupSyncIntervalMs: Math.max(
      60000,
      Number(process.env.WA_BACKUP_SYNC_INTERVAL_MS) || 60000
    ),
    // Local scratch dir RemoteAuth zips from. Ephemeral by design - the
    // real session lives in Mongo.
    dataPath: process.env.WA_DATA_PATH || '/tmp/.wwebjs_auth',
    puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    // Only used to seed the Settings singleton on first boot; after that the
    // admin panel is the source of truth.
    seedGroupId: process.env.WA_GROUP_ID || null,
  },
};

assertConfigured();

module.exports = { config };
