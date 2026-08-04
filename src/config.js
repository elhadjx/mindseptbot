require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (see .env.example)`);
  }
  return value;
}

const isProd = process.env.NODE_ENV === 'production';

const config = {
  isProd,
  port: Number(process.env.PORT) || 3000,

  mongoUri: required('MONGODB_URI'),

  admin: {
    password: required('ADMIN_PASSWORD'),
    sessionSecret: required('SESSION_SECRET'),
    // How long a panel login stays valid.
    sessionMaxAgeMs: Number(process.env.ADMIN_SESSION_MAX_AGE_MS) || 12 * 60 * 60 * 1000,
  },

  tuya: {
    accessId: required('TUYA_ACCESS_ID'),
    accessSecret: required('TUYA_ACCESS_SECRET'),
    region: process.env.TUYA_REGION || 'eu',
  },

  doors: {
    frontDeviceId: process.env.DOOR_FRONT_DEVICE_ID,
    relayPulseMs: Number(process.env.RELAY_PULSE_MS) || 1000,
  },

  whatsapp: {
    // Distinguishes sessions sharing one database (e.g. staging vs prod).
    clientId: process.env.WA_CLIENT_ID || 'mindsept',
    // RemoteAuth rejects anything below 60000.
    backupSyncIntervalMs: Math.max(
      60000,
      Number(process.env.WA_BACKUP_SYNC_INTERVAL_MS) || 300000
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

module.exports = { config };
