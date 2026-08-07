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

function formatSeconds(total) {
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function AckMark({ ack }) {
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

  return (
    <div className={`bubble ${message.fromMe ? 'bubble--out' : 'bubble--in'}`}>
      {mediaFailed ? (
        <div className="bubble__text muted">
          {MEDIA_PREVIEW[message.type] || '📎 Attachment'} — not available.
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
        {message.fromMe && <AckMark ack={message.ack} />}
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
            <span className="chat-item__avatar" aria-hidden="true">
              {initials(c.name)}
            </span>
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
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recordTimerRef = useRef(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const loadChats = useCallback(async ({ silent = false } = {}) => {
    setLoadingChats(true);
    try {
      const { chats: list } = await api.chats();
      setChats(list);
    } catch (err) {
      if (!silent) setFlash({ ok: false, message: err.message });
    } finally {
      setLoadingChats(false);
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

  // Always scroll to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, selectedId]);

  // A send can succeed without handing back the stored message (see
  // sendMessage in whatsapp/messages.js). The MESSAGE_CREATE stream delivers
  // it a moment later, so there is nothing to do here but not crash.
  function appendOwnMessage(message) {
    if (!message?.id) return;
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
  }

  async function sendText(event) {
    event.preventDefault();
    const text = composeText.trim();
    if (!text || !selectedId || sending) return;
    setSending(true);
    try {
      const { message } = await api.sendChatMessage(selectedId, text);
      setComposeText('');
      appendOwnMessage(message);
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    } finally {
      setSending(false);
    }
  }

  async function uploadMedia(fileOrBlob, { asVoice = false } = {}) {
    if (!selectedId) return;
    setSending(true);
    try {
      const form = new FormData();
      form.append('file', fileOrBlob, fileOrBlob.name || (asVoice ? 'voice-note.webm' : 'file'));
      if (asVoice) form.append('voice', '1');
      const { message } = await api.sendChatMedia(selectedId, form);
      appendOwnMessage(message);
    } catch (err) {
      setFlash({ ok: false, message: err.message });
    } finally {
      setSending(false);
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
                  <span className="chat-item__avatar" aria-hidden="true">
                    {initials(selectedChat.name)}
                  </span>
                  <div className="conversation__title">
                    <div>{selectedChat.name}</div>
                    {selectedChat.isGroup && (
                      <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                        Group
                      </div>
                    )}
                  </div>
                </div>

                <div className="conversation__scroll" ref={scrollRef}>
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
