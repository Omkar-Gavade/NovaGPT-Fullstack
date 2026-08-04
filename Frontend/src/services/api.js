/**
 * Single gateway for every backend call — NovaGPT API v1.
 *
 *   GET    /api/v1/models                         -> { data, meta }
 *   GET    /api/v1/providers                      -> { data }
 *   GET    /api/v1/threads                        -> { data: [summary], meta: { cursor } }
 *   GET    /api/v1/threads/:id                    -> { data: thread }
 *   PATCH  /api/v1/threads/:id                    -> { data: thread }
 *   DELETE /api/v1/threads/:id                    -> { data: { deleted } }
 *   GET    /api/v1/threads/:id/settings           -> { data: settings }
 *   PUT    /api/v1/threads/:id/settings           -> { data: settings }
 *   POST   /api/v1/threads/:id/duplicate          -> { data: thread }
 *   POST   /api/v1/threads/:id/share              -> { data: { shareId, url } }
 *   PATCH  /api/v1/threads/:id/messages/:mid/pin  -> { data: message }
 *   POST   /api/v1/chat                           -> { data: { threadId, message, switched } }
 *   POST   /api/v1/chat/stream                    -> SSE
 *   POST   /api/v1/chat/regenerate                -> { data: { threadId, message } }
 *   POST   /api/v1/chat/continue                  -> { data: { threadId, message } }
 *   POST   /api/v1/chat/stop                      -> { data: { stopped } }
 *
 * Two things changed from the previous API, and both matter to callers:
 *
 *   1. **Every response is enveloped** as `{ data, meta }`, and every error as
 *      `{ error: { kind, message, traceId } }`. Callers branch on `kind`, never
 *      on message text — the wording is copy and may change freely.
 *   2. **The stream protocol is typed.** `delta` is no longer the only event:
 *      `switched`, `usage`, `reasoning` and a leading `stream` frame all carry
 *      information the old string-delta protocol had nowhere to put.
 */

const BASE = "/api/v1";

/** Error kinds the UI branches on. Anything else is a generic failure. */
export const ErrorKind = Object.freeze({
  VALIDATION: "validation",
  NOT_FOUND: "not_found",
  RATE_LIMITED: "rate_limited",
  QUOTA: "quota",
  UNSUPPORTED_CAPABILITY: "unsupported_capability",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  TIMEOUT: "timeout",
});

/** Stream event types, mirroring the backend's `StreamEvent` protocol. */
export const StreamEvent = Object.freeze({
  STREAM: "stream",
  START: "start",
  DELTA: "delta",
  REASONING: "reasoning",
  USAGE: "usage",
  SWITCHED: "switched",
  DONE: "done",
  ERROR: "error",
});

export class ApiError extends Error {
  constructor({ kind, message, field, details, traceId, status }) {
    super(message ?? "Request failed");
    this.name = "ApiError";
    this.kind = kind ?? "internal";
    this.field = field ?? null;
    this.details = details ?? null;
    // Always present on a backend error, and worth surfacing in a support
    // flow: it turns "something went wrong" into a single log query.
    this.traceId = traceId ?? null;
    this.status = status;
  }
}

/**
 * The access token, held in memory only.
 *
 * Deliberately not in `localStorage`: anything readable by JavaScript is
 * readable by an XSS payload, and a token in storage survives the tab that
 * leaked it. The refresh token lives in an httpOnly cookie the browser sends on
 * its own and this file can never see — which is what makes a page reload
 * recover a session without persisting a credential.
 */
let accessToken = null;
const listeners = new Set();

export const session = {
  get token() {
    return accessToken;
  },
  set(token) {
    accessToken = token ?? null;
    for (const listener of listeners) listener(accessToken);
  },
  clear() {
    session.set(null);
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/**
 * A single in-flight refresh, shared.
 *
 * Without this, a page that fires six requests on mount answers one expired
 * token with six concurrent refreshes — and because refresh tokens **rotate**,
 * five of them present an already-used token, which the backend correctly reads
 * as replay and revokes the entire session.
 */
let refreshing = null;

function refreshOnce() {
  refreshing ??= fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: "{}",
  })
    .then(async (res) => {
      if (!res.ok) throw new ApiError({ kind: "unauthenticated", status: res.status });
      const payload = await res.json();
      session.set(payload.data.accessToken);
      return payload.data;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function withAuth(options = {}) {
  return {
    ...options,
    // Sends the refresh cookie. Same-origin through the dev proxy, so this is
    // the only thing needed for the cookie to travel.
    credentials: "include",
    headers: {
      ...options.headers,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  };
}

async function request(path, options, { retryOn401 = true } = {}) {
  const res = await fetch(`${BASE}${path}`, withAuth(options));

  // A 15-minute access token expires mid-session by design. Refresh and retry
  // once — the alternative is signing the user out every quarter hour.
  if (res.status === 401 && retryOn401 && !path.startsWith("/auth/")) {
    try {
      await refreshOnce();
    } catch {
      session.clear();
      throw new ApiError({ kind: "unauthenticated", status: 401 });
    }
    return request(path, options, { retryOn401: false });
  }

  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body — fall through to a generic message */
    }
    throw new ApiError({ ...(payload?.error ?? {}), status: res.status });
  }

  if (res.status === 204) return null;
  return res.json();
}

/** Unwrap the envelope. Callers deal in data, not in transport shape. */
const unwrap = async (promise) => (await promise)?.data ?? null;

const json = (body, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const enc = encodeURIComponent;

export const api = {
  /* --------------------------------- auth ----------------------------- */

  /**
   * Every auth call stores the returned access token as a side effect, so no
   * caller has to remember to — forgetting once produces a "signed in" screen
   * whose next request is a 401.
   */
  register: async ({ email, password, displayName }) => {
    const data = await unwrap(
      request("/auth/register", json({ email, password, ...(displayName ? { displayName } : {}) }))
    );
    session.set(data.accessToken);
    return data.user;
  },

  login: async ({ email, password }) => {
    const data = await unwrap(request("/auth/login", json({ email, password })));
    session.set(data.accessToken);
    return data.user;
  },

  /**
   * Restore a session from the refresh cookie.
   *
   * Called once on load. Resolves to `null` rather than throwing when there is
   * no session, because "not signed in" is the normal state of a first visit.
   */
  resume: async () => {
    try {
      const data = await refreshOnce();
      return data.user;
    } catch {
      session.clear();
      return null;
    }
  },

  logout: async ({ everywhere = false } = {}) => {
    try {
      await request("/auth/logout", json({ everywhere }));
    } finally {
      // Cleared even if the call failed. A logout that leaves the token in
      // memory is a logout that did not happen.
      session.clear();
    }
  },

  me: () => unwrap(request("/auth/me")),

  changePassword: async ({ currentPassword, newPassword }) => {
    const data = await unwrap(
      request("/auth/password", json({ currentPassword, newPassword }))
    );
    session.set(data.accessToken);
    return data.user;
  },

  /* ------------------------------- catalog ---------------------------- */

  listModels: () => request("/models"),
  listProviders: () => unwrap(request("/providers")),

  /* ------------------------------- threads ---------------------------- */

  /**
   * Cursor-paginated. Rows are **summaries**: the backend deliberately projects
   * message bodies out, because loading every message of every thread to render
   * a sidebar is the easiest way to make this endpoint slow.
   */
  listThreads: ({ limit = 50, cursor = null, archived = false, q = null } = {}) => {
    const params = new URLSearchParams({ limit: String(limit), archived: String(archived) });
    if (cursor) params.set("cursor", cursor);
    if (q) params.set("q", q);
    return request(`/threads?${params}`);
  },

  getThread: (threadId) => unwrap(request(`/threads/${enc(threadId)}`)),

  /** Messages only, for callers that do not need the thread envelope. */
  getThreadMessages: async (threadId) => {
    const thread = await api.getThread(threadId);
    return thread?.messages ?? [];
  },

  deleteThread: (threadId) => unwrap(request(`/threads/${enc(threadId)}`, { method: "DELETE" })),

  /** Rename / pin / archive. Accepts any subset of { title, pinned, archived }. */
  patchThread: (threadId, patch) =>
    unwrap(request(`/threads/${enc(threadId)}`, json(patch, "PATCH"))),

  duplicateThread: (threadId) => unwrap(request(`/threads/${enc(threadId)}/duplicate`, json({}))),

  shareThread: (threadId) => unwrap(request(`/threads/${enc(threadId)}/share`, json({}))),

  unshareThread: (threadId) =>
    unwrap(request(`/threads/${enc(threadId)}/share`, { method: "DELETE" })),

  getSettings: (threadId) => unwrap(request(`/threads/${enc(threadId)}/settings`)),

  saveSettings: (threadId, settings) =>
    unwrap(request(`/threads/${enc(threadId)}/settings`, json(settings, "PUT"))),

  pinMessage: (threadId, messageId, pinned) =>
    unwrap(
      request(`/threads/${enc(threadId)}/messages/${enc(messageId)}/pin`, json({ pinned }, "PATCH"))
    ),

  /* --------------------------------- chat ----------------------------- */

  sendMessage: ({ threadId, message, settings }) =>
    unwrap(request("/chat", json({ threadId, message, settings }))),

  regenerate: ({ threadId, messageId, settings }) =>
    unwrap(request("/chat/regenerate", json({ threadId, messageId, settings }))),

  /** Extend a reply that stopped at the output limit. */
  continueMessage: ({ threadId, messageId, settings }) =>
    unwrap(request("/chat/continue", json({ threadId, messageId, settings }))),

  /**
   * Stop a stream server-side.
   *
   * Distinct from aborting the fetch: aborting stops *us* reading, while this
   * stops the provider generating. Without it a cancelled request keeps burning
   * quota for output nobody will ever see.
   */
  stopStream: (streamId) => unwrap(request("/chat/stop", json({ streamId }))),

  /**
   * Streaming chat over SSE.
   *
   * Calls `onEvent(event)` for every frame. The parser buffers partial frames:
   * TCP splits them at arbitrary byte boundaries, and treating each chunk as
   * complete silently drops content in a way that only appears on real
   * networks.
   */
  streamMessage: async ({ threadId, message, settings }, onEvent, signal) => {
    const open = () =>
      fetch(`${BASE}/chat/stream`, withAuth({ ...json({ threadId, message, settings }), signal }));

    let res = await open();

    // The stream is the longest-lived request in the app and the most likely to
    // start on a token that just expired. It gets the same refresh-and-retry as
    // every other call, written out here because it does not go through
    // `request` — SSE needs the raw body.
    if (res.status === 401) {
      await refreshOnce();
      res = await open();
    }

    // A failure before the first token is still a normal HTTP error, which is
    // more useful than an error frame — the backend commits to 200 only once
    // the stream is genuinely starting.
    if (!res.ok || !res.body) {
      let payload = null;
      try {
        payload = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError({ ...(payload?.error ?? {}), status: res.status });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        // Anything after the last separator is incomplete and stays buffered.
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          // Keep-alive comments (`: ping`) carry no data line and are skipped.
          if (!line) continue;
          try {
            onEvent(JSON.parse(line.slice(5).trim()));
          } catch {
            /* malformed frame — skip it rather than killing a working stream */
          }
        }
      }
    } finally {
      // Releases the connection when the caller aborts or breaks out early.
      reader.cancel().catch(() => {});
    }
  },
};
