/**
 * API client.
 *
 * Built on fetch rather than a HTTP library: the surface needed here is small,
 * and the one behaviour worth writing by hand is transparent token refresh —
 * a 401 triggers a single refresh and replays the original request, with
 * concurrent 401s sharing that one refresh instead of stampeding.
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

const STORAGE_KEY = 'attendance.session';

export function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(session) {
  if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(STORAGE_KEY);
}

export function clearSession() {
  saveSession(null);
}

/** Raised for any non-2xx response, carrying the API's structured error body. */
export class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthenticated = () => {};
export function setUnauthenticatedHandler(fn) {
  onUnauthenticated = fn;
}

// Shared across concurrent 401s so only one refresh request is ever in flight.
let refreshInFlight = null;

async function refreshAccessToken() {
  const session = loadSession();
  if (!session?.refreshToken) return null;

  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const next = { ...loadSession(), ...data };
      saveSession(next);
      return next.accessToken;
    } catch {
      return null;
    } finally {
      // Release the lock on the next tick so callers awaiting this promise all
      // observe the same result before a new refresh can start.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

function buildUrl(path, params) {
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, v));
    else search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseError(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const error = body?.error ?? {};
  return new ApiError(error.message ?? `Request failed (${res.status})`, {
    status: res.status,
    code: error.code,
    details: error.details,
  });
}

async function performRequest(path, { method = 'GET', body, params, headers = {}, raw = false, retry = true } = {}) {
  const session = loadSession();
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (session?.accessToken) requestHeaders.Authorization = `Bearer ${session.accessToken}`;

  const res = await fetch(buildUrl(path, params), {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && retry) {
    const token = await refreshAccessToken();
    if (token) return performRequest(path, { method, body, params, headers, raw, retry: false });
    clearSession();
    onUnauthenticated();
    throw await parseError(res);
  }

  if (!res.ok) throw await parseError(res);
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  get: (path, params) => performRequest(path, { params }),
  post: (path, body, params) => performRequest(path, { method: 'POST', body, params }),
  patch: (path, body) => performRequest(path, { method: 'PATCH', body }),
  put: (path, body) => performRequest(path, { method: 'PUT', body }),
  delete: (path) => performRequest(path, { method: 'DELETE' }),

  /**
   * Trigger a file download. Reports come back as CSV or PDF attachments, so
   * the response is turned into a blob and handed to the browser with the
   * filename the server chose.
   */
  async download(path, params, fallbackName = 'download') {
    const res = await performRequest(path, { params, raw: true });
    const disposition = res.headers.get('content-disposition') ?? '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = match?.[1] ?? fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Give the browser a moment to start the download before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};

export default api;
