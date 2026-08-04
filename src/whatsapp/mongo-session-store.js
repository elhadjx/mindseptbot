const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

/**
 * RemoteAuth session store backed by GridFS.
 *
 * This replaces the `wwebjs-mongo` package, which is unmaintained (v1.1.0,
 * 2022) and no longer agrees with whatsapp-web.js about where the session zip
 * lives: RemoteAuth.compressSession() writes it to
 * `path.join(dataPath, '<session>.zip')`, but wwebjs-mongo's save() reads
 * `'<session>.zip'` relative to process.cwd(). In any deployment where cwd
 * isn't dataPath - i.e. all of them - every backup failed with ENOENT, and
 * because the failure surfaced as an unhandled 'error' on a ReadStream it took
 * the whole process down. The container then restarted without a saved
 * session, so the QR had to be scanned again.
 *
 * RemoteAuth's store interface is four methods; only `extract` is handed an
 * explicit path, so `save` has to rebuild the same path RemoteAuth used, which
 * is why this store needs to know dataPath.
 */
class MongoSessionStore {
  constructor({ mongoose, dataPath }) {
    if (!mongoose) throw new Error('MongoSessionStore requires a mongoose instance');
    if (!dataPath) throw new Error('MongoSessionStore requires dataPath');
    this.mongoose = mongoose;
    // Must match RemoteAuth's own `path.resolve(dataPath)`.
    this.dataPath = path.resolve(dataPath);
  }

  /** Where RemoteAuth.compressSession() leaves the archive. */
  zipPath(session) {
    return path.join(this.dataPath, `${session}.zip`);
  }

  bucket(session) {
    return new this.mongoose.mongo.GridFSBucket(this.mongoose.connection.db, {
      bucketName: `whatsapp-${session}`,
    });
  }

  filename(session) {
    return `${session}.zip`;
  }

  async sessionExists({ session }) {
    const files = this.mongoose.connection.db.collection(`whatsapp-${session}.files`);
    return (await files.countDocuments({ filename: this.filename(session) })) > 0;
  }

  async save({ session }) {
    const source = this.zipPath(session);
    if (!fs.existsSync(source)) {
      throw new Error(`Session archive not found at ${source}`);
    }

    const bucket = this.bucket(session);

    // Record what's already there so we can drop it only after the new upload
    // lands - a crash mid-upload must not leave the session unrecoverable.
    const previous = await bucket.find({ filename: this.filename(session) }).toArray();

    // pipeline() rejects on stream errors rather than emitting an unhandled
    // 'error' event, which is what made the old failure fatal.
    await pipeline(
      fs.createReadStream(source),
      bucket.openUploadStream(this.filename(session))
    );

    for (const doc of previous) {
      await bucket.delete(doc._id).catch((err) =>
        console.warn(`[session-store] could not remove old revision: ${err.message}`)
      );
    }
  }

  async extract({ session, path: destination }) {
    const bucket = this.bucket(session);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await pipeline(
      bucket.openDownloadStreamByName(this.filename(session)),
      fs.createWriteStream(destination)
    );
  }

  async delete({ session }) {
    const bucket = this.bucket(session);
    const documents = await bucket.find({ filename: this.filename(session) }).toArray();
    for (const doc of documents) {
      await bucket.delete(doc._id);
    }
  }
}

module.exports = { MongoSessionStore };
