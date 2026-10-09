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

/**
 * What the chat endpoint tells the user when a turn fails. A provider status maps to a fixed sentence; the provider's
 * response body and the message of any other exception stay in the server log (api/chat.js logs the error itself).
 * The 401 and 429 sentences are the ones the endpoint always used.
 */
export function chatErrorMessage(err) {
  const status = Number(err?.status) || 0;
  if (status === 401) return 'AI provider auth failed. Check ANTHROPIC_API_KEY on the server.';
  if (status === 429) return 'AI rate limit hit. Wait a moment and try again.';
  if (status === 400 || status === 413) return 'The AI provider rejected this request. The conversation may be too long: start a new chat or shorten the message.';
  if (status >= 500) return 'The AI provider is having trouble. Try again in a moment.';
  if (status) return `AI provider error (${status}).`;
  return GENERIC.server;
}
