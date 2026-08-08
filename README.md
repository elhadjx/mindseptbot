# CLAUDE.md

## Project

Mindsept door access — a WhatsApp bot plus an admin panel that lets whitelisted
coworkers open the coworking space's front door themselves, without a manager
having to do it from the SmartLife app.

Phase 0 (prove the Tuya relay can be triggered from a webpage) is done. This is
Phase 1: the bot, the whitelist, the audit log and the panel.

## How it works

1. A member sends `/open` (or `ouvre`, `porte`, …) in **one of the WhatsApp groups the
   bot is configured to listen in** (managed from Settings → Groups), or — when
   Settings → Private conversations is on — **directly to the bot in a one-to-one
   chat**.
2. The bot — a `whatsapp-web.js` client running headless Chromium — sees the message,
   identifies the sender, and checks them against a whitelist in MongoDB.
3. On success it checks the relay is reachable, then pulses the front door relay
   through the Tuya Cloud API and reacts ✅ to the message. Denials get ⛔,
   failures ⚠️, an unreachable door 📡.
4. Every attempt, granted or not, is written to an audit log the panel can filter.

## Offline doors

Before pulsing, `triggerDoor()` asks Tuya whether the relay is reachable
(`GET /v1.0/iot-03/devices/{id}` → `online`). A negative answer is re-checked
once after `DOOR_OFFLINE_RECHECK_MS` (3s).

**An offline reading never cancels the open.** Tuya's flag is heartbeat-based and
lags reality by minutes in *both* directions, so refusing on it alone would lock
members out of a door that works. The open is attempted regardless:

- **It opens** → the flag was stale. Normal ✅, no alert, and the door is marked
  healthy again. `triggerDoor` returns `recovered: true` for the log.
- **It fails** → confirmed offline. The member gets the `door_offline` reply, the
  audit row gets a `door_offline` reason, and the admin is alerted.

The check is the *diagnosis*, not the decision — which is why a failed status
call (`checkDoorOnline` returns `null`) is treated as "don't know", never as
offline.

A command that fails on its own is also classified offline if its Tuya error code
is in `OFFLINE_ERROR_CODES`. That list is best-effort and unverified against a
live device; nothing depends on it being right, because the status probe is the
signal that actually decides. Being wrong there costs a generic error message
instead of a specific one.

### Alerts

Confirmed outages reach the admin three ways, from `src/doors/offline-alert.js`:

1. **Panel banner** — over `GET /api/doors/stream` (SSE). Its own stream, not
   `/api/status/stream`, whose frames are raw WhatsApp state objects. A tab
   opened mid-outage is replayed the current state on connect.
2. **Web Push** — for browsers that opted in from Settings → Phone notifications.
   A VAPID pair is **hardcoded in `src/config.js`** so a fresh deploy needs no
   setup; `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` still override it. That's a
   deliberate exception to keeping secrets in env, and it only holds while this
   repo is private — **if it ever goes public or gets shared, rotate with
   `npm run keys:vapid` and move the pair to env vars.** On iOS this requires the
   panel to be installed to the home screen — see *Installing the panel*.
3. **WhatsApp DM** — to Settings → *Fallback WhatsApp number*, used only when
   push reached nobody. It's the least reliable channel (the bot's own connection
   is exactly what tends to break at the same time), so it's the fallback.

**Outages are latched per door.** Ten people queued outside a dead door fire ten
commands; the first alerts, the rest are logged only, and the latch clears on the
next successful open. The dashboard still sees every attempt — the dedupe is
about not teaching an admin to swipe the alert away.

A simulated open never clears the latch. `reportDoorOnline()` takes `simulated`
and refuses it there rather than leaving it to each caller: test mode sends no
command, so it is no evidence the door is back, and one caller forgetting that
would silently bury a live outage.

## Installing the panel

The panel is a PWA, installed to the home screen on the phones that should
receive door alerts. That isn't cosmetic — **iOS delivers Web Push only to an
installed app**, never to a Safari tab.

What makes it installable:

- `admin/public/manifest.webmanifest` — `display: standalone`, plus 192/512 icons
  and a `maskable` 512 whose mark sits inside the middle ~60% so Android's circle
  crop doesn't clip it.
- Apple-only `<meta>` tags in `admin/index.html`. iOS reads *these*, not the
  manifest, to decide on standalone mode.
- The service worker is registered in `main.jsx` **on load**, not on first push
  opt-in. A browser won't offer to install without an active service worker, and
  iOS won't push until installed — registering lazily makes those circular. Its
  `fetch` handler is a deliberate passthrough: a stale cached bundle controlling
  a door is worse than a slow load.
- Icons are flattened onto the bone background rather than left transparent —
  iOS refuses to composite icon alpha and renders those pixels black.

The panel login lasts **30 days** (`ADMIN_SESSION_MAX_AGE_MS`). An installed iOS
app gets its own cookie jar, so it needs a separate login from Safari, and a
short session would mean re-authenticating on the device you most need to answer
from. A lost phone is revoked by changing the panel password.

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
  db/models/            User (whitelist), AuditLog, Settings, Credentials (singletons),
                        PushSubscription (browsers opted into alerts)
  security/             passwords.js - scrypt hashing for the panel login
  doors/                tuya-cloud.js (Phase 0, unchanged), door-service.js,
                        offline-alert.js (one alert per outage, not per attempt)
  notify/               push.js - Web Push fan-out, prunes dead subscriptions
  whatsapp/             client.js, identity.js, phone.js, command-router.js,
                        rate-limiter.js, handlers.js, groups.js, contacts.js
  http/                 express app, password auth, /api routes
admin/                  React + Vite panel (built to admin/dist)
admin/public/sw.js      service worker - shows pushed alerts, no caching
admin/public/manifest.webmanifest   PWA manifest + icons, so it installs to a
                        home screen (required for push on iOS)
test/handler.test.js    end-to-end tests for the authorization pipeline
test/doors.test.js      reachability check, retry, failure classification, alert dedupe
test/phone.test.js      phone number normalisation rules
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

Practical consequence: **enroll members from a list WhatsApp gave us** — the
Members screen's group participant list, or the Contacts screen — rather than by
typing phone numbers. That captures the exact `waId` the bot will see. Enrolling
from Contacts sends only a `waId`, so `POST /api/members` resolves the LID and
phone server-side for that one person (`enrich()` in `src/http/routes/members.js`);
doing it for a whole contact list up front would be thousands of page calls.

## Phone numbers

Typed numbers are normalised by `src/whatsapp/phone.js` against
`Settings.defaultCountryCode` (default `213`): `0549212025`, `+213549212025`,
`00213549212025` and `549212025` all become `213549212025`, which is what
WhatsApp addresses that person by. The Members form previews the result before
saving, and the server rejects anything implausible rather than storing junk.

Two rules carry the weight:

- **`identity.digitsOnly` is deliberately not this function.** It parses the user
  part out of a JID, where the number is already exact — giving it country-code
  logic would mangle a LID like `18712345678901@lid`.
- **10+ digits with no leading zero is treated as already complete.** That is what
  stops a French member typed as `33612345678` becoming `21333612345678`. A
  leading `0` is unambiguous the other way: no country calling code starts with 0.

`backfillPhones()` runs at boot from `src/index.js`, repairing members enrolled
before this existed. It is idempotent and timid on purpose: it only rewrites
phones starting with `0`, only rewrites a `waId` that was *derived* from the bad
phone (never a `@lid` or a JID captured from a real message), and logs and skips
unique-index collisions rather than failing the boot. Anything else that looks
odd is logged for a human instead of being rewritten.

## Replies

Settings → What the bot replies edits the emoji and text for every outcome
(opened, not on the list, rate limited, test mode, …). `replyMode` still decides
whether the bot reacts, sends text, or both.

The catalogue lives in `src/whatsapp/replies.js` and is served to the panel from
`GET /api/settings/outcomes`, so **adding a case there makes it appear in
Settings with no panel change**. Each outcome needs a `key`, `label`, `hint`,
default `emoji`/`text`, and an entry in `OUTCOME_DECISION`.

Notes:

- An empty emoji or text means *stay silent on that outcome* — it is a real
  choice, not a missing value, and is never replaced by the default.
- `{name}` and `{door}` are substituted. Unknown placeholders are left visible
  rather than blanked, so a typo shows up instead of vanishing.
- Reactions are validated as a single grapheme, so a ZWJ emoji like 👨‍👩‍👧
  is accepted but `✅✅` is rejected.
- The audit `reason` stays separate from the reply wording: it carries detail
  (which limit, what count) that shouldn't go into a group message.

## Test mode

Settings → Test mode runs the entire pipeline — group scope, whitelist, rate
limits, replies, audit log — but never sends the Tuya command. Use it to try the
bot out without opening a real door onto the street.

The check lives inside `triggerDoor()` (`src/doors/door-service.js`), not in its
callers, so there is no path — WhatsApp command or panel button — that can open
the door while it is on.

When it's on: senders get 🧪 instead of ✅ and a reply saying the door did not
open, audit rows are flagged `simulated` and badged in the Activity table, and
the panel shows a banner on every page. All of that is deliberate — a test mode
that looks like success is worse than no test mode.

## Safety properties worth preserving

These are all covered by `npm test` — don't regress them:

- **Chat scope.** `Settings.chatScope()` is the single gate. Groups must be in
  `Settings.groups` *and* enabled; one-to-one chats are honoured only when
  `allowDirectMessages` is on. Everything else — other groups, `status@broadcast`,
  broadcast lists, `@newsletter` channels, and our own messages — is dropped
  before anything is logged. The server allowlists the JID *servers* it accepts
  (`g.us`, `c.us`, `lid`) rather than treating "not a group" as "must be a DM",
  which would put status replies in scope the moment DMs were switched on. The
  settings API still refuses any id that isn't `@g.us` in the `groups` list —
  DMs are a separate switch, not a group entry.
- **Strangers in a DM get no reply.** A non-whitelisted sender in a *group* gets
  ⛔; in a DM the denial is logged and answered with silence, so the bot never
  confirms to someone guessing numbers that this line runs a door bot. Denials
  are not rate limited, which is the other half of the reason.
- **Message freshness.** Commands older than `maxMessageAgeSec` (default 90s) are
  ignored. Without this, whatsapp-web.js replaying a backlog after a reconnect
  would fire the relay once per old "open" message.
- **Anchored keyword matching.** A command must *start* the message, so "je peux
  pas ouvre" is chatter, not an open.
- **Rate limits.** Per-member and global sliding windows.
- **An offline reading never refuses an open.** The relay is probed before every
  pulse, but the pulse is attempted whichever way the probe answers — see
  *Offline doors*. A stale flag must never become a lockout, and a failed probe
  must never read as offline.
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

**Don't use `client.getChatById()` to read a group either.** Same underlying
helper (`getChatModel`), same failure. `listParticipants()` in
`src/whatsapp/groups.js` reads cached metadata, only refreshes when nothing is
cached, and never lets a failed refresh discard what it already had.

**`client.getContacts()` is better behaved, but still not safe enough.** No
metadata refresh and no LID migration, but it runs one `Promise.all` over every
contact and calls `contact.serialize()` on each — and `getContactModel` is
synchronous code that can throw (`createWidFromWidLike`, `getAlternateUserWid`,
the `Blocklist` lookup), so one bad contact rejects the whole listing.
`src/whatsapp/contacts.js` reads the collection and projects only the fields the
panel needs, per contact, in a try/catch, keeping `getContacts()` as a fallback.
The result is cached for five minutes in `src/http/routes/contacts.js`.

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
4. **Install the panel** on each phone that should receive alerts (Android: the
   browser's install prompt; iOS: Share → Add to Home Screen), then open the
   installed app and sign in — iOS keeps a separate session from Safari.
5. **Settings → Phone notifications** — enable alerts on that device, and set a
   fallback WhatsApp number.
   Push needs HTTPS, so on a plain `http://localhost` this only works in Chrome
   (which exempts localhost); Safari will not offer it.

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
- The panel is protected by a single shared password, so the audit log
  attributes panel opens to "Admin panel" rather than to a person. Per-admin
  accounts are the upgrade path if that matters.
- `ADMIN_PASSWORD` only seeds the password on **first boot** — hashed with
  scrypt into `Credentials` (`src/security/passwords.js`,
  `src/db/models/Credentials.js`), same pattern as `WA_GROUP_ID` and
  `DEFAULT_COUNTRY_CODE`. After that, Settings → Admin password owns it, and
  changing the env var does nothing; changing it there requires the current
  password, so a stolen session cookie alone can't lock the real admin out.

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
