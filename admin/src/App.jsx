import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
import { syncSubscription } from './lib/push';
import Login from './pages/Login';
import Connection from './pages/Connection';
import Members from './pages/Members';
import Contacts from './pages/Contacts';
import Messages from './pages/Messages';
import Activity from './pages/Activity';
import Settings from './pages/Settings';
import {
  ActivityIcon,
  ChatIcon,
  ContactsIcon,
  LinkIcon,
  MoonIcon,
  SignOutIcon,
  SlidersIcon,
  SunIcon,
  UsersIcon,
} from './components/icons';

const PAGES = [
  { key: 'connection', label: 'Connection', Icon: LinkIcon },
  { key: 'members', label: 'Members', Icon: UsersIcon },
  { key: 'contacts', label: 'Contacts', Icon: ContactsIcon },
  { key: 'messages', label: 'Messages', Icon: ChatIcon },
  { key: 'activity', label: 'Activity', Icon: ActivityIcon },
  { key: 'settings', label: 'Settings', Icon: SlidersIcon },
];

const STATUS_SEED = {
  ready: 'granted',
  qr: 'pending',
  starting: 'pending',
  authenticated: 'pending',
  disconnected: 'denied',
  auth_failure: 'denied',
};

const STATUS_LABEL = {
  ready: 'WhatsApp connected',
  qr: 'Waiting for QR scan',
  starting: 'WhatsApp starting…',
  authenticated: 'WhatsApp loading…',
  disconnected: 'WhatsApp disconnected',
  auth_failure: 'WhatsApp sign-in failed',
};

const PAGE_KEYS = new Set(PAGES.map((p) => p.key));

/**
 * The panel's whole router: "#messages/<chatId>" - a page, optionally with the
 * one thing that page can be pointed at.
 *
 * It exists for the notifications. A push that opens the panel on whatever tab
 * it was last left on, when it was announcing a specific conversation, wastes
 * the tap.
 */
function parseHash(hash) {
  const [page, chatId] = String(hash || '')
    .replace(/^#\/?/, '')
    .split('/');
  if (!PAGE_KEYS.has(page)) return { page: null, chatId: null };
  return { page, chatId: chatId ? decodeURIComponent(chatId) : null };
}

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('mindsept-theme') || 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('mindsept-theme', theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

export default function App() {
  const [authed, setAuthed] = useState(null); // null = still checking
  const [route, setRoute] = useState(() => {
    const parsed = parseHash(window.location.hash);
    return { page: parsed.page || 'connection', chatId: parsed.chatId };
  });
  const { page, chatId: routeChatId } = route;
  const setPage = useCallback((key) => {
    // Writing the hash is enough - the listener below is what moves the page,
    // so a tap and a notification take exactly the same path.
    window.location.hash = key;
    setRoute({ page: key, chatId: null });
  }, []);
  const [waState, setWaState] = useState({ status: 'starting' });
  const [settings, setSettings] = useState(null);
  const [doors, setDoors] = useState([]);
  const [offlineDoors, setOfflineDoors] = useState(new Map()); // key -> label
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    api
      .session()
      .then(({ authenticated }) => setAuthed(authenticated))
      .catch(() => setAuthed(false));
  }, []);

  // Back/forward, and any notification tap that lands on an already-open panel.
  useEffect(() => {
    const applyHash = () => {
      const parsed = parseHash(window.location.hash);
      if (parsed.page) setRoute({ page: parsed.page, chatId: parsed.chatId });
    };
    window.addEventListener('hashchange', applyHash);

    // A tapped notification reaches an open panel as a message from the
    // service worker: focus() alone would leave it on whatever tab it was on.
    const onWorkerMessage = (event) => {
      if (event.data?.type !== 'navigate' || !event.data.url) return;
      const hash = String(event.data.url).split('#')[1];
      if (!hash) return;
      window.location.hash = hash;
      applyHash();
    };
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage);

    return () => {
      window.removeEventListener('hashchange', applyHash);
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage);
    };
  }, []);

  const loadContext = useCallback(async () => {
    try {
      const [{ settings: s }, { doors: d }] = await Promise.all([api.settings(), api.doors()]);
      setSettings(s);
      setDoors(d);
    } catch (err) {
      if (err.status === 401) setAuthed(false);
    }
  }, []);

  useEffect(() => {
    if (authed) loadContext();
  }, [authed, loadContext]);

  // Re-announce this browser to the server on every load. A subscription the
  // server pruned - or lost with the database - leaves the device silently
  // unreachable otherwise, with the panel still showing alerts as on.
  useEffect(() => {
    if (authed) syncSubscription().catch(() => {});
  }, [authed]);

  // Live connection state over SSE. EventSource reconnects on its own, so a
  // server restart heals without a page reload.
  useEffect(() => {
    if (!authed) return undefined;
    const source = new EventSource('/api/status/stream');
    source.onmessage = (event) => {
      try {
        setWaState(JSON.parse(event.data));
      } catch {
        // Ignore malformed frames rather than tearing down the stream.
      }
    };
    return () => source.close();
  }, [authed]);

  // Door health, on its own stream. The server replays any door currently down
  // when the stream opens, so a tab loaded mid-outage shows the banner at once.
  useEffect(() => {
    if (!authed) return undefined;
    const source = new EventSource('/api/doors/stream');
    source.onmessage = (event) => {
      try {
        const { type, door, label } = JSON.parse(event.data);
        setOfflineDoors((current) => {
          const next = new Map(current);
          if (type === 'offline') next.set(door, label);
          else next.delete(door);
          return next;
        });
      } catch {
        // Ignore malformed frames rather than tearing down the stream.
      }
    };
    return () => source.close();
  }, [authed]);

  async function logout() {
    await api.logout();
    setAuthed(false);
  }

  if (authed === null) return null;
  if (!authed) return <Login onAuthenticated={() => setAuthed(true)} />;
  if (!settings) return null;

  /* Messages is a chat surface, not a document: on a phone it claims the whole
     screen rather than sitting in a padded card under a page title. */
  const flush = page === 'messages';

  return (
    <div className={`shell ${flush ? 'shell--flush' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand__mark" src="/logo.png" alt="Mindsept" />
          <div>
            <div className="brand__name">Mindsept</div>
            <div className="brand__sub">Door access</div>
          </div>
        </div>

        <nav className="nav">
          {PAGES.map((p) => (
            <button
              key={p.key}
              className={`nav__item ${page === p.key ? 'nav__item--active' : ''}`}
              onClick={() => setPage(p.key)}
              aria-current={page === p.key ? 'page' : undefined}
            >
              <span className="nav__icon">
                <p.Icon />
              </span>
              {p.label}
            </button>
          ))}
        </nav>

        <div className="sidebar__foot">
          <div className="row" style={{ fontSize: 'var(--fs-xs)' }}>
            <span
              className={`seed seed--${STATUS_SEED[waState.status] || 'pending'} ${
                waState.status === 'ready' ? '' : 'seed--pulsing'
              }`}
            />
            <span className="muted">{STATUS_LABEL[waState.status] || 'WhatsApp starting…'}</span>
          </div>
          {/* Icon-only on a phone, where the header is a single slim strip and
              a pill reading "Sign out" crowds it. The label returns on
              desktop, where the sidebar has the room for it. */}
          <div className="row sidebar__actions">
            <button
              className="btn btn--ghost btn--icon"
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
            <button
              className="btn btn--ghost btn--icon"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
            >
              <SignOutIcon />
              <span className="btn__label">Sign out</span>
            </button>
          </div>
        </div>
      </aside>

      <main className={`main ${flush ? 'main--flush' : ''}`}>
        {/*
          Test mode is the one setting that makes the whole system lie about
          what it did, so it is shown on every page rather than only where it
          is toggled.
        */}
        {settings.testMode && (
          <div className="test-banner">
            <span aria-hidden="true">🧪</span>
            <span>
              <strong>Test mode is on.</strong> Commands are checked and logged, but the door
              will not actually open.
            </span>
            <button className="btn btn--ghost btn--sm" onClick={() => setPage('settings')}>
              Turn off
            </button>
          </div>
        )}

        {/* A door nobody can open is the most urgent thing this panel knows,
            so it outranks the page you happened to be on. */}
        {offlineDoors.size > 0 && (
          <div className="test-banner test-banner--alert">
            <span aria-hidden="true">📡</span>
            <span>
              <strong>
                {[...offlineDoors.values()].join(', ')}{' '}
                {offlineDoors.size === 1 ? 'is not responding.' : 'are not responding.'}
              </strong>{' '}
              Check the relay's power and WiFi — commands are failing.
            </span>
          </div>
        )}

        {page === 'connection' && <Connection state={waState} doors={doors} />}
        {page === 'members' && <Members settings={settings} />}
        {page === 'contacts' && <Contacts waReady={waState.status === 'ready'} />}
        {page === 'messages' && (
          <Messages waReady={waState.status === 'ready'} initialChatId={routeChatId} />
        )}
        {page === 'activity' && <Activity />}
        {page === 'settings' && (
          <Settings
            settings={settings}
            doors={doors}
            waReady={waState.status === 'ready'}
            onSaved={(s) => setSettings(s)}
          />
        )}
      </main>
    </div>
  );
}
