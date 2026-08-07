import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Empty, Flash, useFlash } from '../components/ui';
import { makeSearch } from '../lib/search';

// The full inbox of the linked WhatsApp number - not just the door groups the
// bot listens in. Mobile-first: the chat list and the open conversation are
// two full-width views that swap on selection; layout.css turns that same
// markup into a permanent split pane once there is room for one.

const MEDIA_PREVIEW = {
  image: '📷 Photo',
  video: '🎬 Video',
  audio: '🎵 Audio',
  ptt: '🎤 Voice message',
  document: '📎 Document',
  sticker: '🩹 Sticker',
};

function previewText(last) {
  if (!last) return '';
  const body = last.hasMedia ? MEDIA_PREVIEW[last.type] || '📎 Attachment' : last.body || '';
  return last.fromMe ? `You: ${body}` : body;
}

function initials(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

function formatChatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

function formatClock(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** What an optimistic message and its delivered counterpart have in common. */
function sameContent(a, b) {
  return a.fromMe && b.fromMe && a.type === b.type && (a.body || '') === (b.body || '');
}

/**
 * Union two views of a conversation by message id, oldest first.
 *
 * The server's copy wins on conflict (it carries real delivery acks), while
 * anything local it hasn't caught up with yet - an optimistic send still in
 * flight - is kept rather than made to flicker out and back in.
 *
 * Returning `prev` unchanged when nothing moved is not just an optimisation:
 * a fresh array every poll re-fired the follow-the-newest-message effect, so
 * the view jumped to the bottom every few seconds and reading back through
 * the history became impossible.
 */
function mergeMessages(prev, fresh) {
  const incoming = Array.isArray(fresh) ? fresh : [];
  const byId = new Map();
  for (const m of incoming) byId.set(m.id, m);
  for (const m of prev) if (!byId.has(m.id)) byId.set(m.id, m);

  const all = [...byId.values()];
  // Retire an optimistic bubble once its real message has landed.
  const delivered = all.filter((m) => !m.pending);
  const merged = all
    .filter((m) => !(m.pending && delivered.some((d) => sameContent(m, d))))
    // Array.sort is stable, so same-second messages keep the server's order.
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const unchanged =
    merged.length === prev.length &&
    merged.every((m, i) => {
      const p = prev[i];
      return m.id === p.id && m.ack === p.ack && m.pending === p.pending;
    });

  return unchanged ? prev : merged;
}

function formatSeconds(total) {
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/**
 * Profile picture, with initials as the resting state rather than a fallback
 * bolted on: plenty of chats have no picture, or hide it, and a broken image
 * icon in a contact list looks like a bug.
 */
function Avatar({ chatId, name }) {
  const [failed, setFailed] = useState(false);

  if (failed || !chatId) {
    return (
      <span className="chat-item__avatar" aria-hidden="true">
        {initials(name)}
      </span>
    );
  }
  return (
    <img
      className="chat-item__avatar chat-item__avatar--photo"
      src={api.chatAvatarUrl(chatId)}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/* An inline clock: a glyph would be at the mercy of whatever emoji font the
   device has, and this needs to sit level with the ticks it turns into. */
function ClockMark() {
  return (
    <svg className="ack ack--clock" viewBox="0 0 16 16" aria-label="Sending" role="img">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 4.4V8l2.4 1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AckMark({ message }) {
  if (message.failed) {
    return (
      <span className="ack ack--error" title="Not sent">
        !
      </span>
    );
  }
  if (message.pending) return <ClockMark />;

  const { ack } = message;
  if (ack === undefined || ack === null) return null;
  if (ack === -1) return <span className="ack ack--error">!</span>;
  if (ack >= 3) return <span className="ack ack--read">✓✓</span>;
  if (ack === 2) return <span className="ack">✓✓</span>;
  return <span className="ack">✓</span>;
}

function MessageContent({ message, mediaUrl, onMediaError }) {
  if (!message.hasMedia) {
    return <div className="bubble__text">{message.body || <span className="muted">…</span>}</div>;
  }
  switch (message.type) {
    case 'image':
    case 'sticker':
      return (
        <a href={mediaUrl} target="_blank" rel="noreferrer" className="bubble__media">
          <img src={mediaUrl} loading="lazy" alt={message.body || 'Photo'} onError={onMediaError} />
          {message.body && <div className="bubble__caption">{message.body}</div>}
        </a>
      );
    case 'video':
      return (
        <div className="bubble__media">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video controls preload="metadata" src={mediaUrl} onError={onMediaError} />
          {message.body && <div className="bubble__caption">{message.body}</div>}
        </div>
      );
    case 'audio':
    case 'ptt':
      return (
        <div className="bubble__media">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls preload="metadata" src={mediaUrl} className="bubble__audio" onError={onMediaError} />
          {message.body && <div className="bubble__caption">{message.body}</div>}
        </div>
      );
    case 'document':
      return (
        <a className="bubble__document" href={mediaUrl} download={message.filename || undefined}>
          <span aria-hidden="true">📎</span>
          <span>{message.filename || message.body || 'Document'}</span>
        </a>
      );
    default:
      return <div className="bubble__text muted">Unsupported message ({message.type})</div>;
  }
}

function MessageBubble({ message }) {
  // WhatsApp drops the bytes for old media, and the phone has to re-upload it
  // before it can be fetched again. A broken-image icon doesn't say that.
  const [mediaFailed, setMediaFailed] = useState(false);
  const mediaUrl = message.hasMedia ? api.chatMediaUrl(message.id) : null;

  // An optimistic bubble has no server-side message to fetch bytes from yet,
  // so it shows the local file it was created from.
  if (message.pending && message.hasMedia) {
    return (
      <div
        className={`bubble ${message.fromMe ? 'bubble--out' : 'bubble--in'} ${
          message.pending ? 'bubble--pending' : ''
        }`}
      >
        <div className="bubble__media">
          {message.thumbnail ? (
            <img src={message.thumbnail} alt={message.body || 'Sending'} />
          ) : (
            <div className="bubble__text muted">
              {message.filename || MEDIA_PREVIEW[message.type] || '📎 Attachment'}
            </div>
          )}
          {message.body && <div className="bubble__caption">{message.body}</div>}
        </div>
        <div className="bubble__meta">
          {formatClock(message.timestamp)}
          <AckMark message={message} />
        </div>
      </div>
    );
  }

  return (
    <div
        className={`bubble ${message.fromMe ? 'bubble--out' : 'bubble--in'} ${
          message.pending ? 'bubble--pending' : ''
        }`}
      >
      {mediaFailed ? (
        // WhatsApp expires media the phone has to re-upload before it can be
        // fetched again. The preview that came with the message still shows
        // what it was, which beats a shrug.
        <div className="bubble__media">
          {message.thumbnail ? (
            <>
              <img src={message.thumbnail} alt={message.body || 'Preview'} />
              <div className="bubble__caption muted">Preview only — full size unavailable.</div>
            </>
          ) : (
            <div className="bubble__text muted">
              {MEDIA_PREVIEW[message.type] || '📎 Attachment'} — not available.
            </div>
          )}
          {message.body && <div className="bubble__caption">{message.body}</div>}
        </div>
      ) : (
        <MessageContent
          message={message}
          mediaUrl={mediaUrl}
          onMediaError={() => setMediaFailed(true)}
        />
      )}
      <div className="bubble__meta">
        {formatClock(message.timestamp)}
        {message.fromMe && <AckMark message={message} />}
      </div>
    </div>
  );
}

function ChatList({ chats, loading, selectedId, query, onQuery, onSelect, onRefresh }) {
  const search = makeSearch(query);
  const filtered = (chats || []).filter((c) => !search.active || search.matches([c.name], [c.id]));

  return (
    <div className="chat-list">
      <div className="chat-list__head">
        <input
          className="input"
          placeholder="Search chats…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh"
        >
          {loading ? '…' : '↻'}
        </button>
      </div>
      <div className="chat-list__items">
        {!chats && <Empty>Loading chats…</Empty>}
        {chats && filtered.length === 0 && <Empty>No chats match.</Empty>}
        {filtered.map((c) => (
          <button
            type="button"
            key={c.id}
            className={`chat-item ${selectedId === c.id ? 'chat-item--active' : ''}`}
            onClick={() => onSelect(c)}
          >
            <Avatar chatId={c.id} name={c.name} />
            <span className="chat-item__body">
              <span className="chat-item__row">
                <span className="chat-item__name">{c.name}</span>
                <span className="chat-item__time">{formatChatTime(c.timestamp)}</span>
              </span>
              <span className="chat-item__row">
                <span className="chat-item__preview">{previewText(c.lastMessage)}</span>
                {c.unreadCount > 0 && <span className="chat-item__badge">{c.unreadCount}</span>}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Messages({ waReady }) {
  const [chats, setChats] = useState(null);
  const [loadingChats, setLoadingChats] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [query, setQuery] = useState('');
  const [composeText, setComposeText] = useState('');
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useFlash();
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const selectedIdRef = useRef(null);
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recordTimerRef = useRef(null);
  const pendingSeqRef = useRef(0);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const loadChats = useCallback(async ({ silent = false, background = false } = {}) => {
    if (!background) setLoadingChats(true);
    try {
      const { chats: list } = await api.chats();
      setChats(list);
    } catch (err) {
      if (!silent) setFlash({ ok: false, message: err.message });
    } finally {
      if (!background) setLoadingChats(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (waReady && !chats && !loadingChats) loadChats({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waReady]);

  async function openChat(chat) {
    setSelectedId(chat.id);
    setMessages([]);
    setLoadingMessages(true);
    // A freshly opened chat starts pinned to its newest message.
    atBottomRef.current = true;
    setChats((prev) => prev?.map((c) => (c.id === chat.id ? { ...c, unreadCount: 0 } : c)) ?? prev);
    try {
      const { messages: list } = await api.chatMessages(chat.id, { limit: 50 });
      setMessages(list);
      api.markChatRead(chat.id).catch(() => {});
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    } finally {
      setLoadingMessages(false);
    }
  }

  /**
   * Refresh on a timer as well as over the stream.
   *
   * The SSE stream is the fast path, but it is a long-lived connection through
   * whatever proxy sits in front of this app, and when it is silently dropped
   * the tab just quietly stops updating - which looks exactly like the app
   * being broken. Polling makes the tab correct on its own and leaves the
   * stream as an optimisation.
   */
  useEffect(() => {
    if (!waReady || !selectedId) return undefined;
    const timer = setInterval(async () => {
      // Nothing to reconcile against a backgrounded tab.
      if (document.hidden) return;
      try {
        const { messages: list } = await api.chatMessages(selectedId, { limit: 50 });
        setMessages((prev) => mergeMessages(prev, list));
      } catch {
        // Transient - the next tick tries again.
      }
    }, 8000);
    return () => clearInterval(timer);
  }, [waReady, selectedId]);

  useEffect(() => {
    if (!waReady) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) loadChats({ silent: true, background: true });
    }, 30000);
    return () => clearInterval(timer);
  }, [waReady, loadChats]);

  // Live updates: append to the open conversation, bump the chat list.
  useEffect(() => {
    if (!waReady) return undefined;
    const source = new EventSource('/api/messages/stream');
    source.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      const { chatId, message } = payload || {};
      if (!chatId || !message) return;

      if (chatId === selectedIdRef.current) {
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
        if (!message.fromMe) api.markChatRead(chatId).catch(() => {});
      }

      setChats((prev) => {
        if (!prev) return prev;
        const idx = prev.findIndex((c) => c.id === chatId);
        if (idx === -1) {
          // A brand new conversation - refetch so it shows up with real name/metadata.
          loadChats({ silent: true });
          return prev;
        }
        const next = [...prev];
        const [chat] = next.splice(idx, 1);
        const updated = {
          ...chat,
          timestamp: message.timestamp,
          lastMessage: {
            body: message.body,
            type: message.type,
            fromMe: message.fromMe,
            timestamp: message.timestamp,
            hasMedia: message.hasMedia,
          },
          unreadCount:
            !message.fromMe && chatId !== selectedIdRef.current
              ? (chat.unreadCount || 0) + 1
              : chat.unreadCount,
        };
        next.unshift(updated);
        return next;
      });
    };
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waReady]);

  // Follow the newest message, but only when there IS a newer message and the
  // reader is at the bottom. Keying this on the last id rather than on the
  // array means a poll that changed nothing - or that only updated a delivery
  // tick - leaves the scroll position alone.
  const lastMessageId = messages.length ? messages[messages.length - 1].id : null;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lastMessageId, selectedId]);

  function onConversationScroll() {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  /**
   * Put the message on screen before the network has agreed to it.
   *
   * A round trip to WhatsApp through the browser page is slow enough to feel
   * like nothing happened, so the bubble appears at once carrying a clock,
   * and the real delivery ticks replace it when the send comes back.
   */
  function addPendingMessage(fields) {
    pendingSeqRef.current += 1;
    const pending = {
      id: `pending:${pendingSeqRef.current}`,
      timestamp: Math.floor(Date.now() / 1000),
      fromMe: true,
      pending: true,
      body: '',
      type: 'chat',
      hasMedia: false,
      ...fields,
    };
    // Sending is an explicit act - always follow it down.
    atBottomRef.current = true;
    setMessages((prev) => [...prev, pending]);
    return pending.id;
  }

  /** Swap the placeholder for the delivered message, or mark it failed. */
  function settlePending(pendingId, message, { failed = false } = {}) {
    setMessages((prev) => {
      const next = [];
      for (const m of prev) {
        if (m.id !== pendingId) {
          // The poll or the stream may have raced us to the real message.
          if (message && m.id === message.id) continue;
          next.push(m);
          continue;
        }
        if (message?.id) {
          // Carry the local preview over: the delivered message points at a
          // media URL the server may not be able to serve yet.
          next.push({ ...message, thumbnail: message.thumbnail || m.thumbnail });
        } else {
          next.push({ ...m, pending: !failed, failed });
        }
      }
      return next;
    });
  }

  async function sendText(event) {
    event.preventDefault();
    const text = composeText.trim();
    if (!text || !selectedId || sending) return;

    // Clear the box immediately - retyping because the UI looked stuck is
    // exactly how a message gets sent twice.
    setComposeText('');
    const pendingId = addPendingMessage({ body: text, type: 'chat' });
    setSending(true);
    try {
      const { message } = await api.sendChatMessage(selectedId, text);
      settlePending(pendingId, message);
    } catch (err) {
      settlePending(pendingId, null, { failed: true });
      setFlash({ ok: false, message: err.message });
    } finally {
      setSending(false);
    }
  }

  async function uploadMedia(fileOrBlob, { asVoice = false } = {}) {
    if (!selectedId) return;

    const type = asVoice
      ? 'ptt'
      : fileOrBlob.type?.startsWith('image/')
        ? 'image'
        : fileOrBlob.type?.startsWith('video/')
          ? 'video'
          : fileOrBlob.type?.startsWith('audio/')
            ? 'audio'
            : 'document';
    // Show the picture the moment it is picked, straight from the local file.
    const localPreview = type === 'image' ? URL.createObjectURL(fileOrBlob) : null;
    const pendingId = addPendingMessage({
      type,
      hasMedia: true,
      thumbnail: localPreview,
      filename: fileOrBlob.name || null,
    });

    setSending(true);
    try {
      const form = new FormData();
      form.append('file', fileOrBlob, fileOrBlob.name || (asVoice ? 'voice-note.webm' : 'file'));
      if (asVoice) form.append('voice', '1');
      const { message } = await api.sendChatMedia(selectedId, form);
      settlePending(pendingId, message);
    } catch (err) {
      settlePending(pendingId, null, { failed: true });
      setFlash({ ok: false, message: err.message });
    } finally {
      setSending(false);
      if (localPreview) {
        // The bubble has had its moment; the delivered message serves its own
        // bytes from here on.
        setTimeout(() => URL.revokeObjectURL(localPreview), 60000);
      }
    }
  }

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function onFileChosen(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await uploadMedia(file);
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setFlash({ ok: false, message: 'This browser does not offer microphone access here.' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        uploadMedia(blob, { asVoice: true });
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setFlash({ ok: false, message: 'Microphone access was denied.' });
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
    clearInterval(recordTimerRef.current);
  }

  useEffect(() => () => clearInterval(recordTimerRef.current), []);

  const selectedChat = chats?.find((c) => c.id === selectedId) || null;

  return (
    <div className="stack messages-page">
      <div className="page-head">
        <h1>Messages</h1>
        <p>The full inbox of the linked WhatsApp number — read and reply from here.</p>
      </div>

      <Flash flash={flash} />

      {!waReady ? (
        <Empty>Connect WhatsApp first — messages come straight from the linked phone.</Empty>
      ) : (
        <div className={`messages-shell ${selectedId ? 'messages-shell--chat' : 'messages-shell--list'}`}>
          <ChatList
            chats={chats}
            loading={loadingChats}
            selectedId={selectedId}
            query={query}
            onQuery={setQuery}
            onSelect={openChat}
            onRefresh={() => loadChats()}
          />

          <div className="conversation">
            {!selectedChat ? (
              <div className="conversation__placeholder">
                <Empty>Pick a chat to see the conversation.</Empty>
              </div>
            ) : (
              <>
                <div className="conversation__head">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm conversation__back"
                    onClick={() => setSelectedId(null)}
                  >
                    ← Back
                  </button>
                  <Avatar chatId={selectedChat.id} name={selectedChat.name} />
                  <div className="conversation__title">
                    <div>{selectedChat.name}</div>
                    {selectedChat.isGroup && (
                      <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                        Group
                      </div>
                    )}
                  </div>
                </div>

                <div className="conversation__scroll" ref={scrollRef} onScroll={onConversationScroll}>
                  {loadingMessages && messages.length === 0 && <Empty>Loading…</Empty>}
                  {!loadingMessages && messages.length === 0 && <Empty>No messages yet.</Empty>}
                  {messages.map((m) => (
                    <MessageBubble key={m.id} message={m} />
                  ))}
                </div>

                <form className="composer" onSubmit={sendText}>
                  <input ref={fileInputRef} type="file" hidden onChange={onFileChosen} />
                  <button
                    type="button"
                    className="btn btn--ghost composer__icon"
                    onClick={pickFile}
                    disabled={sending || recording}
                    title="Attach a file"
                  >
                    📎
                  </button>

                  {recording ? (
                    <div className="composer__recording">
                      <span className="seed seed--denied seed--pulsing" />
                      Recording… {formatSeconds(recordSeconds)}
                      <button type="button" className="btn btn--sm btn--danger" onClick={stopRecording}>
                        Stop &amp; send
                      </button>
                    </div>
                  ) : (
                    <>
                      <input
                        className="input composer__input"
                        placeholder="Message"
                        value={composeText}
                        onChange={(e) => setComposeText(e.target.value)}
                        disabled={sending}
                      />
                      {composeText.trim() ? (
                        <button type="submit" className="btn composer__icon" disabled={sending}>
                          ➤
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--ghost composer__icon"
                          onClick={startRecording}
                          disabled={sending}
                          title="Record a voice note"
                        >
                          🎤
                        </button>
                      )}
                    </>
                  )}
                </form>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
