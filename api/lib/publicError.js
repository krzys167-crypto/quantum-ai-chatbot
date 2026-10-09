/**
 * What a signed-in user is told when something fails on the server.
 *
 * Database errors carry table, column and constraint names; provider errors carry account, quota and project
 * details. Neither belongs in a response body. The detail goes to the server log (Vercel runtime logs), the caller
 * gets a fixed sentence. Validation answers (400, "id required", "up to 10 servers") are NOT routed through here:
 * they are written by us, are meant to be read, and contain no third-party text.
 *
 * Not used by api/admin/* (admin-only, those pages show the real error on purpose) or by api/chat.js, which has its
 * own provider-error handling.
 */

export const GENERIC = Object.freeze({
  server: 'Internal server error',
  provider: 'AI provider error',
  stt: 'Speech-to-text failed',
  tts: 'Text-to-speech failed',
  db: 'Request failed',
});

/**
 * A Supabase / PostgREST error reduced to what is safe to write to a log. `details` is left out on purpose: for a
 * constraint violation Postgres puts the failing row there, and for mcp_servers that row contains the user's auth token.
 */
export function dbDetail(error) {
  return { code: error?.code, message: error?.message };
}

/** An unexpected failure: log `detail` under `label`, answer 500 with the fixed `message`. Returns the response. */
export function fail(res, message, label, detail) {
  console.error(label, detail);
  return res.status(500).json({ error: message });
}

/** Upstream (provider) answered with a non-2xx status. The status number is logged, never echoed. */
export async function failUpstream(res, message, label, upstream, extra) {
  const text = await upstream.text().catch(() => '');
  console.error(label, upstream.status, text.slice(0, 1000), extra || '');
  return res.status(502).json({ error: message });
}
