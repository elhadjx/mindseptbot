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

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) || null;
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

  // userVisibleOnly is required by Chrome, and honest here - every push we send
  // does show a notification.
  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = subscription.toJSON();
  await api.subscribePush({ endpoint: json.endpoint, keys: json.keys, label: navigator.userAgent });
  localStorage.setItem(VAPID_KEY_STORAGE, json.endpoint);
  return { ok: true };
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
