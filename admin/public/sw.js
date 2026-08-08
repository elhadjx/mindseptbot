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
