// All communication with the backend goes through this file.

export class ApiError extends Error {
  constructor(status, message, fields = null) {
    super(message);
    this.status = status; // 0 means the server could not be reached
    this.fields = fields;
  }
}

let onUnauthorized = null;

/** Called when a request outside /auth comes back 401, which means the session has ended. */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
  }

  if (response.status === 204) return null;

  let data = null;
  try {
    data = await response.json();
  } catch {
    // body was empty or not JSON
  }

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/') && onUnauthorized) onUnauthorized();
    throw new ApiError(response.status, data?.error || 'Something went wrong. Please try again.', data?.fields);
  }

  return data;
}

export const api = {
  me: () => request('GET', '/auth/me'),
  login: (credentials) => request('POST', '/auth/login', credentials),
  register: (details) => request('POST', '/auth/register', details),
  logout: () => request('POST', '/auth/logout'),

  list({ priority = 'all', q = '', limit, offset } = {}) {
    const params = new URLSearchParams();
    if (priority !== 'all') params.set('priority', priority);
    if (q) params.set('q', q);
    if (limit) params.set('limit', limit);
    if (offset) params.set('offset', offset);
    const query = params.toString();
    return request('GET', `/announcements${query ? `?${query}` : ''}`);
  },
  create: (announcement) => request('POST', '/announcements', announcement),
  update: (id, changes) => request('PATCH', `/announcements/${encodeURIComponent(id)}`, changes),
  remove: (id) => request('DELETE', `/announcements/${encodeURIComponent(id)}`),
};
