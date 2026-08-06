const { mongoose } = require('../mongo');
const { config } = require('../../config');
const { hashPassword } = require('../../security/passwords');

// The admin panel's login password, hashed. Singleton, same shape as Settings.
//
// ADMIN_PASSWORD only seeds this ONCE on first boot - identical to how
// WA_GROUP_ID seeds Settings.groups and DEFAULT_COUNTRY_CODE seeds
// Settings.defaultCountryCode. After that the panel (Settings -> Admin
// password) owns it, and changing the env var has no further effect.
const credentialsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'admin' },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true, versionKey: false, _id: false }
);

credentialsSchema.statics.load = async function load() {
  let doc = await this.findById('admin');
  if (!doc) {
    doc = await this.create({
      _id: 'admin',
      passwordHash: await hashPassword(config.admin.password),
    });
    console.log('[credentials] seeded the admin password from ADMIN_PASSWORD');
  }
  return doc;
};

module.exports = mongoose.model('Credentials', credentialsSchema);
