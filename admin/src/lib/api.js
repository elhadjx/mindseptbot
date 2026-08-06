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

  doors: () => request('/doors'),
  openDoor: (door) => request(`/doors/${door}/open`, { method: 'POST' }),
};
