/* Service worker for the admin panel's door alerts.
 *
 * Served from the site root so its scope covers the whole panel. It does no
 * caching on purpose - the panel is useless offline anyway, and a stale cached
 * bundle is a worse problem than a slow load.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Straight passthrough. It exists because browsers want a fetch handler before
// treating the panel as installable - deliberately not a cache: a stale bundle
// controlling a door is a worse failure than a slow load, and the panel is
// useless offline anyway.
self.addEventListener('fetch', () => {});

/** VAPID keys travel as base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

/**
 * The browser has invalidated our push subscription.
 *
 * Chrome fires this when it rotates or drops one - notably when the server's
 * application server key changes underneath it. Ignoring it is how a device
 * goes quiet forever while its owner is told alerts are on: nothing else in
 * the panel ever notices, because the page may not be open for days.
 *
 * Same-origin fetches carry the panel's session cookie, which is what lets a
 * worker talk to an authenticated API at all.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const response = await fetch('/api/push/key', { credentials: 'same-origin' });
        if (!response.ok) return;
        const { configured, publicKey } = await response.json();
        if (!configured) return;

        const subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        const json = subscription.toJSON();

        await fetch('/api/push/subscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: json.keys,
            label: 'renewed automatically',
          }),
        });

        // The old endpoint is dead; leaving its row behind means every future
        // alert pays for a delivery that cannot succeed.
        const old = event.oldSubscription?.endpoint;
        if (old && old !== json.endpoint) {
          await fetch('/api/push/subscribe', {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: old }),
          });
        }
      } catch (err) {
        // Nothing else to try from here - the panel re-announces this browser
        // on its next load, which is the other half of this safety net.
        console.warn('[sw] could not renew the push subscription:', err);
      }
    })()
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Mindsept', body: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Mindsept', {
      body: payload.body || '',
      icon: '/logo.png',
      badge: '/logo.png',
      // Same tag replaces an earlier notice for the same door - or the same
      // conversation - instead of stacking, so neither a lingering outage nor
      // a busy chat is more than one line in the shade.
      tag: payload.tag || 'mindsept',
      renotify: true,
      // A door outage stays on screen until someone acknowledges it; an
      // incoming message says so and gets out of the way. The sender decides,
      // and anything that doesn't (an older payload) keeps the old behaviour.
      requireInteraction: payload.requireInteraction !== false,
      data: { url: payload.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  // Focus the panel if it's already open somewhere rather than piling up tabs,
  // and take it to wherever the notification points - a message alert names
  // the conversation it came from, and focusing a panel sitting on some other
  // tab would drop exactly the part the tap was asking for.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      for (const client of clientList) {
        if (!('focus' in client)) continue;
        // navigate() is refused across origins and unavailable in some
        // browsers; the panel also listens for this message and routes itself.
        try {
          client.postMessage({ type: 'navigate', url: target });
        } catch {
          // Focusing still beats doing nothing.
        }
        return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    })
  );
});
