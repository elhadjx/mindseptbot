export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export const api = {
  session: () => request('/auth/session'),
  login: (password) => request('/auth/login', { method: 'POST', body: { password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword, newPassword) =>
    request('/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),

  status: () => request('/status'),
  unlinkWhatsApp: () => request('/status/logout', { method: 'POST' }),

  groups: () => request('/groups'),
  participants: (groupId) => request(`/groups/${encodeURIComponent(groupId)}/participants`),

  contacts: ({ refresh = false } = {}) => request(`/contacts${refresh ? '?refresh=1' : ''}`),

  members: () => request('/members'),
  addMember: (member) => request('/members', { method: 'POST', body: member }),
  updateMember: (id, patch) => request(`/members/${id}`, { method: 'PATCH', body: patch }),
  deleteMember: (id) => request(`/members/${id}`, { method: 'DELETE' }),

  logs: (params) => request(`/logs?${new URLSearchParams(params)}`),

  settings: () => request('/settings'),
  saveSettings: (patch) => request('/settings', { method: 'PATCH', body: patch }),
  outcomes: () => request('/settings/outcomes'),

  aiCredentials: () => request('/ai-credentials'),
  saveAiCredential: (provider, apiKey, currentPassword) =>
    request('/ai-credentials', {
      method: 'POST',
      body: { provider, apiKey, currentPassword },
    }),
  removeAiCredential: (provider, currentPassword) =>
    request(`/ai-credentials/${provider}`, {
      method: 'DELETE',
      body: { currentPassword },
    }),
  testAiCredential: (provider) =>
    request(`/ai-credentials/${provider}/test`, { method: 'POST' }),

  doors: () => request('/doors'),
  openDoor: (door) => request(`/doors/${door}/open`, { method: 'POST' }),

  pushKey: () => request('/push/key'),
  subscribePush: (subscription) => request('/push/subscribe', { method: 'POST', body: subscription }),
  unsubscribePush: (endpoint) =>
    request('/push/subscribe', { method: 'DELETE', body: { endpoint } }),
  testPush: () => request('/push/test', { method: 'POST' }),

  chats: () => request('/messages/chats'),
  chatMessages: (chatId, { limit } = {}) =>
    request(
      `/messages/chats/${encodeURIComponent(chatId)}/messages${limit ? `?limit=${limit}` : ''}`
    ),
  sendChatMessage: (chatId, text) =>
    request(`/messages/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: { text },
    }),
  markChatRead: (chatId) =>
    request(`/messages/chats/${encodeURIComponent(chatId)}/read`, { method: 'POST' }),
  chatMediaUrl: (messageId) => `/api/messages/messages/${encodeURIComponent(messageId)}/media`,
  chatAvatarUrl: (chatId) => `/api/messages/chats/${encodeURIComponent(chatId)}/avatar`,
  // Multipart, not JSON - bypasses request() so the browser sets its own
  // Content-Type with the multipart boundary.
  sendChatMedia: async (chatId, formData) => {
    const res = await fetch(`/api/messages/chats/${encodeURIComponent(chatId)}/media`, {
      method: 'POST',
      credentials: 'same-origin',
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
    return data;
  },
};
