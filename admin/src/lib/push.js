import { api } from './api';

/**
 * Browser side of the door-offline alerts.
 *
 * Push needs three separate things to line up - a registered service worker,
 * OS-level permission, and a server with VAPID keys - and any of them can be
 * missing. Every function here reports what's actually true rather than
 * throwing, so the panel can explain the situation instead of just failing.
 */

const VAPID_KEY_STORAGE = 'mindsept-push-endpoint';

/** VAPID keys travel as base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * iOS only delivers Web Push to a panel installed to the home screen. Detecting
 * that up front is what lets the UI say so, instead of leaving an iPhone user
 * tapping a button that can never work.
 */
export function iosNeedsInstall() {
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
  return isIOS && !standalone;
}

/** The reverse of urlBase64ToUint8Array, for reading a key back off a
 * subscription so it can be compared with the server's. */
function uint8ArrayToUrlBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Which application server key this subscription is bound to.
 *
 * A subscription is only valid for the key it was created with: rotate the
 * VAPID pair and every existing one starts failing at the push service, which
 * is invisible from here. Null means the browser doesn't expose it, and the
 * caller has to give the subscription the benefit of the doubt.
 */
function keyOf(subscription) {
  const key = subscription?.options?.applicationServerKey;
  return key ? uint8ArrayToUrlBase64(key) : null;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  // `getRegistration()` resolves with undefined while registration is still in
  // flight - and the worker is registered on window load, which is *after*
  // this panel has mounted and asked. Reading that as "no subscription" is
  // what made the settings card report alerts off on a device that had them
  // on. `ready` waits for an active registration instead.
  //
  // It never rejects and never resolves without one, so a panel opened before
  // main.jsx got to register would hang here: register first, which is
  // idempotent, and let ready settle against that.
  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch {
    // Already registered, or blocked - `ready` is still the right question.
  }

  // `ready` never rejects: where a worker can't be activated at all it simply
  // never settles, which would leave the settings card spinning forever with
  // nothing to show. Give up after a moment and report what we know.
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  if (!registration) return null;

  return (await registration.pushManager.getSubscription()) || null;
}

/**
 * Register, ask permission, subscribe, and tell the server.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function enablePush() {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };

  const { configured, publicKey } = await api.pushKey();
  if (!configured) return { ok: false, reason: 'server_not_configured' };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'permission_denied' };

  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();

  // Reusing a subscription bound to a key the server no longer signs with is
  // the worst of both worlds: the panel says alerts are on, and every push is
  // rejected by the push service. Rotating the VAPID pair has to be survivable
  // by re-enabling, so throw the stale one away and take a fresh one.
  const boundKey = keyOf(subscription);
  if (subscription && boundKey && boundKey !== publicKey) {
    console.warn('[push] this device was subscribed with an older key - resubscribing');
    await subscription.unsubscribe().catch(() => {});
    await api.unsubscribePush(subscription.endpoint).catch(() => {});
    subscription = null;
  }

  if (!subscription) {
    try {
      // userVisibleOnly is required by Chrome, and honest here - every push we
      // send does show a notification.
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    } catch (err) {
      // The push service itself can refuse (AbortError is the usual one on
      // Android). Carry the name out: "could not enable alerts" with no reason
      // is not something anyone can act on.
      return { ok: false, reason: 'subscribe_failed', detail: err.name || err.message };
    }
  }

  const json = subscription.toJSON();
  await api.subscribePush({ endpoint: json.endpoint, keys: json.keys, label: navigator.userAgent });
  localStorage.setItem(VAPID_KEY_STORAGE, json.endpoint);
  return { ok: true };
}

/**
 * Make the server's record of this browser match reality. Called on every
 * panel load.
 *
 * The server row can go missing without the browser ever knowing - it is
 * pruned when a push service reports the endpoint dead, and it is gone
 * entirely if the database is replaced. Until now nothing ever put it back,
 * so a device would sit there believing alerts were on and never hear
 * anything again. Re-announcing is one upsert, and it costs nothing.
 */
export async function syncSubscription() {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' };

  try {
    const subscription = await currentSubscription();
    // Never subscribed, or unsubscribed on purpose - not ours to undo.
    if (!subscription) return { ok: false, reason: 'not_subscribed' };

    const { configured, publicKey } = await api.pushKey();
    if (!configured) return { ok: false, reason: 'server_not_configured' };

    // Bound to a key the server has since rotated away from. Permission is
    // already granted, so this re-subscribes without prompting anyone.
    const boundKey = keyOf(subscription);
    if (boundKey && boundKey !== publicKey) return enablePush();

    const json = subscription.toJSON();
    await api.subscribePush({
      endpoint: json.endpoint,
      keys: json.keys,
      label: navigator.userAgent,
    });
    return { ok: true };
  } catch (err) {
    // Best-effort housekeeping: it must never break loading the panel.
    console.warn('[push] could not sync this device:', err.message);
    return { ok: false, reason: 'error' };
  }
}

export async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  // Drop the server row first: a subscription the browser has already forgotten
  // is one we could never clean up afterwards.
  await api.unsubscribePush(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
  localStorage.removeItem(VAPID_KEY_STORAGE);
}
