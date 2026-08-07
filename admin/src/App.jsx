import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api';
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
  const [page, setPage] = useState('connection');
  const [waState, setWaState] = useState({ status: 'starting' });
  const [settings, setSettings] = useState(null);
  const [doors, setDoors] = useState([]);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    api
      .session()
      .then(({ authenticated }) => setAuthed(authenticated))
      .catch(() => setAuthed(false));
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

        {page === 'connection' && <Connection state={waState} doors={doors} />}
        {page === 'members' && <Members settings={settings} />}
        {page === 'contacts' && <Contacts waReady={waState.status === 'ready'} />}
        {page === 'messages' && <Messages waReady={waState.status === 'ready'} />}
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
