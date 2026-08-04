# CLAUDE.md

## Project

Mindsept door access — a WhatsApp bot plus an admin panel that lets whitelisted
coworkers open the coworking space's front door themselves, without a manager
having to do it from the SmartLife app.

Phase 0 (prove the Tuya relay can be triggered from a webpage) is done. This is
Phase 1: the bot, the whitelist, the audit log and the panel.

## How it works

1. A member sends `/open` (or `ouvre`, `porte`, …) in **one of the WhatsApp groups the
   bot is configured to listen in** (managed from Settings → Groups).
2. The bot — a `whatsapp-web.js` client running headless Chromium — sees the message,
   identifies the sender, and checks them against a whitelist in MongoDB.
3. On success it pulses the front door relay through the Tuya Cloud API and reacts
   ✅ to the message. Denials get ⛔, failures ⚠️.
4. Every attempt, granted or not, is written to an audit log the panel can filter.

## Stack constraints

- **JS/TS only. No Python anywhere in this repo.**
- Node/Express backend (CommonJS). React + Vite admin panel (ESM) — the only
  build step in the repo.
- Door control goes through the **Tuya Cloud API** (`/v1.0/token`,
  `/v1.0/iot-03/devices/{id}/commands`), signed directly with Node's built-in
  `crypto`/`fetch` (`src/doors/tuya-cloud.js`) — deliberately not the official
  `@tuya/tuya-connector-nodejs` SDK, which pulls a vulnerable, unpatched `axios`.
- WhatsApp session persistence uses `RemoteAuth` with our own GridFS store
  (`src/whatsapp/mongo-session-store.js`), so the session survives Railway's
  ephemeral filesystem. See below for why this isn't `wwebjs-mongo`.

## Layout

```
src/
  index.js              boot: mongo -> express -> whatsapp
  config.js             env parsing, fails fast on missing vars
  events.js             in-process bus (WhatsApp state -> panel SSE)
  db/models/            User (whitelist), AuditLog, Settings (singleton)
  doors/                tuya-cloud.js (Phase 0, unchanged) + door-service.js
  whatsapp/             client.js, identity.js, command-router.js,
                        rate-limiter.js, handlers.js
  http/                 express app, password auth, /api routes
admin/                  React + Vite panel (built to admin/dist)
test/handler.test.js    end-to-end tests for the authorization pipeline
```

## Identity: why members store two identifiers

This is the subtle part. WhatsApp is migrating group addressing to **LIDs**
(Local Identifiers), so `msg.author` in a group is increasingly
`<random>@lid` rather than `<phone>@c.us`, and the phone number may not be
resolvable at all. Matching a whitelist on phone number alone silently denies
everyone once a group flips to LID addressing.

So every `User` stores both `waId` (the raw JID exactly as it appears on
messages — the exact-match fast path) and `phone` where known, and
`User.findAuthorized` matches on either. `src/whatsapp/identity.js` enriches one
into the other on a best-effort basis by reusing whatsapp-web.js's own injected
helper, `window.WWebJS.enforceLidAndPnRetrieval`.

Practical consequence: **enroll members from the Members screen's group
participant list**, not by typing phone numbers. That captures the exact `waId`
the bot will see.

## Safety properties worth preserving

These are all covered by `npm test` — don't regress them:

- **Group scope.** Commands are only honoured in groups that are in
  `Settings.groups` *and* enabled. DMs and other groups are dropped before
  anything is logged. The settings API refuses any id that isn't a `@g.us`
  group JID — a `@c.us` there would make the bot obey commands in a one-to-one
  chat, which bypasses the group entirely.
- **Message freshness.** Commands older than `maxMessageAgeSec` (default 90s) are
  ignored. Without this, whatsapp-web.js replaying a backlog after a reconnect
  would fire the relay once per old "open" message.
- **Anchored keyword matching.** A command must *start* the message, so "je peux
  pas ouvre" is chatter, not an open.
- **Rate limits.** Per-member and global sliding windows.
- **Deny-by-default,** and every denial is logged with a reason.
- **The process does not exit on an unhandled rejection.** RemoteAuth backs up
  on a `setInterval(async …)` with no catch, so one failed backup would
  otherwise terminate the process — dropping the very session it was protecting
  and forcing a re-scan. `installCrashGuards()` in `src/index.js` logs and
  keeps the door working instead.

## whatsapp-web.js sharp edges

Everything below cost real debugging time. The library does a lot of its work
inside WhatsApp's own minified bundle, so failures often arrive as a
single-letter message like `Error: r` — always log the full error server-side.

**Don't use `client.getChats()` to list groups.** Its injected helper builds a
full model for *every* chat in the account, and for each group that includes an
`await groupMetadata.update()` network round-trip plus LID migration of every
participant — all inside one `Promise.all`. A single unhappy chat rejects the
entire listing. `src/whatsapp/groups.js` reads id/name/size straight off the
chat collection instead, tolerates per-chat failures, and keeps `getChats()`
only as a fallback. Covered by `test/groups.test.js`.

### Session persistence: the traps

`RemoteAuth` is less forgiving than it looks, and all of these cost real time:

0. **Don't use `wwebjs-mongo`.** It is unmaintained (v1.1.0, 2022) and no longer
   agrees with whatsapp-web.js about where the session zip is.
   `RemoteAuth.compressSession()` writes it to
   `path.join(dataPath, '<session>.zip')`; `wwebjs-mongo`'s `save()` reads
   `'<session>.zip'` **relative to `process.cwd()`**. Any deployment where cwd
   isn't `dataPath` — i.e. all of them — fails every backup with `ENOENT`, and
   because that surfaces as an unhandled `'error'` on a ReadStream it kills the
   process. The container restarts with no saved session, so you re-scan the QR,
   and it repeats forever. `src/whatsapp/mongo-session-store.js` replaces it;
   `test/session-store.test.js` covers the round-trip.

1. **The session isn't saved until 60 seconds after the first scan.**
   `RemoteAuth.afterAuthReady()` hardcodes `await this.delay(60000)` before its
   first `storeRemoteSession`. Restart or redeploy inside that window and the
   link is gone with no trace. The Connection screen shows a warning banner
   until the first `remote session saved` lands — wait for it before deploying.

2. **A disconnect DELETES the stored session.** `Client.js` calls
   `authStrategy.disconnect()` for any state outside
   `CONNECTED/OPENING/PAIRING/TIMEOUT`, and `RemoteAuth.disconnect()` runs
   `deleteRemoteSession()`. So a transient problem doesn't just drop the
   connection, it wipes the credential and forces a new QR.

   The biggest trigger is `CONFLICT` — raised whenever a second WhatsApp Web
   session appears. **Two app containers is the usual cause** (an overlapping
   deploy, or a replica count above 1). We pass `takeoverOnConflict: true` so a
   conflict is reclaimed rather than treated as fatal, but the real fix is to
   never run two instances. See the deployment section.

   Note also that whatsapp-web.js `destroy()`s the client after emitting
   `disconnected`, so reconnecting requires building a **new** `Client` — you
   cannot re-`initialize()` the old one.

## Setup

```bash
cp .env.example .env      # fill in Tuya creds, Mongo URI, admin password
npm install
npm run build             # builds the admin panel into admin/dist
npm start
```

Then open http://localhost:3000, sign in, and:

1. **Connection** — scan the QR with the phone the bot should use.
2. **Settings** — load groups and pick the door group.
3. **Members** — load participants and allow people.

For panel development with hot reload, run `npm start` and `npm run dev:admin`
in parallel; Vite proxies `/api` to port 3000.

Run the tests — the session store round-trip and the authorization pipeline
(needs a local Mongo; uses a scratch database):

```bash
MONGODB_URI=mongodb://localhost:27017/mindsept-test npm test
```

## Deployment (Railway)

Use the `Dockerfile`, not Nixpacks — `whatsapp-web.js` drives a real browser and
the image installs Debian's `chromium` for it.

- **Give the service ~1GB of RAM.** Chromium will OOM-loop on 512MB.
- Set every var in `.env.example` in the Railway environment. Reference the
  database service rather than pasting a URL, and append a database name:
  `MONGODB_URI=${{MongoDB.MONGO_URL}}/mindsept` — without the name, Mongoose
  silently uses a database called `test`.
- **Exactly one replica, and no overlapping deploys.** Two containers means two
  WhatsApp Web sessions, which means `CONFLICT`, which (see above) destroys the
  stored session. Railway's default rolling deploy briefly runs old and new
  together — turn that off for this service.
- Run the app and the panel as **one service**; the panel reads the live client
  in-process (QR, `getChats()`, participants) and there is nothing to gain by
  splitting them, since the bot can never be scaled past one instance anyway.

## Security notes

- **The WhatsApp session in Mongo is a full credential.** Anyone who can read
  that database can impersonate the bot's WhatsApp account. Lock down DB access.
- `whatsapp-web.js` is unofficial and automating an account can get the number
  banned. Use a dedicated number, not a manager's personal one.
- The panel is protected by a single shared password (`ADMIN_PASSWORD`), so the
  audit log attributes panel opens to "Admin panel" rather than to a person.
  Per-admin accounts are the upgrade path if that matters.

## Background

- Mindsept (coworking space) has two doors on one Tuya-based Zigbee gateway: the
  front door (residency) and the inner door (coworking space).
- Tuya Cloud API credentials (Access ID/Secret) come from the Tuya IoT Platform's
  Cloud Project (Cloud → [project] → Overview). Device IDs come from the project's
  linked device list. These are setup steps outside this repo.

## Local control attempt (abandoned in Phase 0)

Local control (`tuyapi`, LAN-only, no cloud dependency) was the original plan and
is still preferable long-term — it removes any dependency on Tuya's servers. It
was abandoned because:

- The two doors are Zigbee sub-devices on one gateway (a Tuya "Multi Mode Gateway",
  model ZXGWMM-01) — they have no local key or IP of their own; local control means
  connecting to the gateway and addressing each sub-device by its own id as `cid`.
- The gateway's local key, pulled via two independent official Tuya APIs (IoT
  Platform console and the `tinytuya` Cloud API), consistently fails HMAC
  verification against the physical device during the protocol 3.4 session
  handshake. Cloud control works fine with the same device, so this looks like a
  gateway-firmware-specific quirk, not a wrong device/ID/key-transcription issue.
- Cloud control was confirmed working, so we switched to unblock progress.
  Revisiting local control (e.g. by re-pairing the gateway to force a fresh key
  sync) is a reasonable follow-up.

## Still out of scope

- **Inner door ("porte Mind7") remote unlock.** It's a smart lock (Tuya category
  `jtmspro`, model AT1), not a plain relay switch. Its debug command list has no
  simple "unlock" DP — the app opens it via Tuya's separate, ticket-based Smart
  Lock unlock flow (a provisioned per-user credential, not a stateless command),
  which needs its own investigation. The front door works today; the inner door
  intentionally returns an "unsupported" error until this is implemented.
- Home Assistant middleware.
- Per-admin panel accounts.

## Resolved questions

- **Momentary pulse vs. persistent unlock state:** confirmed momentary. Device logs
  show the front door's `switch_1` DP going `true` → `false` about 1 second later
  on every real open — matches the default `RELAY_PULSE_MS=1000`.
- **Device addressing:** each door is its own Tuya device id in the linked device
  list; cloud commands address that id directly (no gateway/local-key involved).
