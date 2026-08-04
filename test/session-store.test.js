const path = require('path');
const fs = require('fs');
const os = require('os');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { connectMongo, mongoose } = require('../src/db/mongo');
const { MongoSessionStore } = require('../src/whatsapp/mongo-session-store');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

async function main() {
  await connectMongo();

  // A dataPath deliberately different from process.cwd() - that difference is
  // exactly what the old wwebjs-mongo store got wrong.
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-store-'));
  const session = 'RemoteAuth-storetest';
  const store = new MongoSessionStore({ mongoose, dataPath });

  await store.delete({ session }).catch(() => {});

  console.log('\n-- path resolution --');
  check(
    'zip path resolves against dataPath, not cwd',
    store.zipPath(session) === path.join(dataPath, `${session}.zip`),
    store.zipPath(session)
  );
  check('and is not relative to cwd', store.zipPath(session) !== path.resolve(`${session}.zip`));

  console.log('\n-- empty state --');
  check('sessionExists is false before any save', (await store.sessionExists({ session })) === false);

  console.log('\n-- save --');
  // Stand in for what RemoteAuth.compressSession() produces.
  const payload = Buffer.from('fake session archive contents '.repeat(500));
  fs.writeFileSync(store.zipPath(session), payload);

  await store.save({ session });
  check('save() uploads without throwing', true);
  check('sessionExists is true after save', (await store.sessionExists({ session })) === true);

  console.log('\n-- extract round-trip --');
  const outPath = path.join(dataPath, 'restored.zip');
  await store.extract({ session, path: outPath });
  const restored = fs.readFileSync(outPath);
  check('extracted bytes match what was saved', restored.equals(payload), `${restored.length} vs ${payload.length}`);

  console.log('\n-- re-save keeps exactly one revision --');
  await store.save({ session });
  await store.save({ session });
  const files = mongoose.connection.db.collection(`whatsapp-${session}.files`);
  const count = await files.countDocuments({ filename: `${session}.zip` });
  check('old revisions are pruned', count === 1, `found ${count}`);
  check('session still exists after re-saves', (await store.sessionExists({ session })) === true);

  console.log('\n-- missing archive is a clean error, not a stream crash --');
  fs.unlinkSync(store.zipPath(session));
  let threw = null;
  try {
    await store.save({ session });
  } catch (err) {
    threw = err;
  }
  check('save() rejects instead of emitting an unhandled error', threw !== null);
  check('  and says where it looked', /Session archive not found/.test(threw?.message || ''), threw?.message);

  console.log('\n-- delete --');
  await store.delete({ session });
  check('sessionExists is false after delete', (await store.sessionExists({ session })) === false);

  fs.rmSync(dataPath, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
