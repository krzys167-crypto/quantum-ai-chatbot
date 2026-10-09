// Gate for irreversible actions with third-party effects (send / reply / forward e-mail, calendar events with
// guests), called from runTool().
//
//   APPROVAL_MODE unset / "server"  -> the model can NEVER send: the call is turned into a pending approval and
//                                      a Confirm card with the exact content is shown to the signed-in user
//                                      (see approvals.js). Misconfiguration or a missing store blocks (fail closed).
//   APPROVAL_MODE = "legacy"        -> the old behaviour: the MODEL-supplied `user_confirmed === true` (F09: this is
//                                      not evidence of user consent). Kept only as an explicit, logged emergency
//                                      switch; it is not the default.
import { APPROVABLE_ACTIONS, attendeeEntries, createPending, normalizeArgs } from './approvals.js';

/** The only value that lets the caller run the action itself. Anything else (null, undefined, a typo) is a block. */
export const PROCEED = Object.freeze({ proceed: true });
// A reply or a forward goes to people read from a received message. The card must show them, so without a readable
// original there is no card and nothing is sent.
const NEEDS_ORIGINAL = new Set(['reply_email', 'forward_email']);

export function approvalMode(env = process.env) {
  const raw = String(env.APPROVAL_MODE || 'server').trim().toLowerCase();
  return raw === 'server' ? 'server' : raw === 'legacy' ? 'legacy' : 'invalid';
}

const LEGACY_TEXT = {
  send_email: 'Send blocked: user_confirmed must be true. Confirm To/Subject/Body with the user first, then call send_email with user_confirmed=true. Prefer create_email_draft if unconfirmed.',
  reply_email: 'Reply blocked: user_confirmed must be true. Confirm the reply with the user first.',
  forward_email: 'Forward blocked: user_confirmed must be true. Confirm recipient with the user first.',
};

const PENDING_TEXT = (action) =>
  action === 'create_calendar_event'
    ? 'NOT CREATED YET. The user has been shown a Confirm card with exactly these event details and guests. The event is created, and the guests are invited, only when the user presses Confirm in the app; you cannot confirm for them and must not call this tool again for the same content. Tell the user briefly to review the card and press Confirm (or Cancel).'
    : `NOT SENT YET. The user has been shown a Confirm card with exactly these fields for ${action}. It is sent only when the user presses Confirm in the app; you cannot confirm for them and must not call this tool again for the same content. Tell the user briefly to review the card and press Confirm (or Cancel).`;

const NO_CARD_TEXT = (name) =>
  name === 'create_calendar_event'
    ? `${name} blocked: this request cannot show a Confirm card (non-interactive mode). Create the event without guests, or tell the user to invite them themselves.`
    : `${name} blocked: this request cannot show a Confirm card (non-interactive mode). Create a draft instead and tell the user to send it themselves.`;

const blocked = (content) => ({ content, is_error: true });

const REASON_TEXT = {
  too_many_pending: 'blocked: too many unconfirmed requests are waiting. Ask the user to confirm or cancel the open ones first.',
  approval_store_unavailable: 'blocked: the approval store is unavailable (apply supabase/approval-requests.sql), so nothing can be sent.',
};

/**
 * Returns PROCEED when the action may proceed right now (legacy mode with the model's flag, or a calendar event without
 * guests, which has no third-party effect), otherwise
 * { content, is_error } to hand back to the model as the tool result.
 *   ctx.admin               Supabase service client
 *   ctx.onApprovalRequired  (card) => void : pushes the Confirm card to the user's open stream; absent => cannot confirm
 *   ctx.describe            async () => object|null : best-effort context for the card (e.g. the message being replied to)
 */
export async function gateIrreversible(name, input, user, ctx = {}) {
  if (!APPROVABLE_ACTIONS.includes(name)) return PROCEED;
  // An event for the user alone has no third-party effect: it stays immediate. Guests make it approvable.
  if (name === 'create_calendar_event' && attendeeEntries(input).length === 0) return PROCEED;
  const env = ctx.env || process.env;
  const log = ctx.log || console;
  const mode = approvalMode(env);
  if (mode === 'invalid') return blocked(`${name} blocked: APPROVAL_MODE must be "server" or "legacy".`);

  if (mode === 'legacy') {
    if (name === 'create_calendar_event') {
      log.warn?.(`[approval] APPROVAL_MODE=legacy: ${name} with guests released without approval (F09 open)`);
      return PROCEED;
    }
    if (input && input.user_confirmed === true) {
      log.warn?.(`[approval] APPROVAL_MODE=legacy: ${name} released on the model's own flag (F09 open)`);
      return PROCEED;
    }
    return blocked(LEGACY_TEXT[name]);
  }

  if (!user?.id) return blocked(`${name} blocked: no signed-in user.`);
  if (typeof ctx.onApprovalRequired !== 'function') {
    return blocked(NO_CARD_TEXT(name));
  }
  let normalized;
  try {
    normalized = normalizeArgs(name, input);
  } catch (e) {
    return blocked(`${name} blocked: ${e.message}.`);
  }
  let extra = null;
  if (NEEDS_ORIGINAL.has(name)) {
    try { extra = (await ctx.describe?.(normalized)) || null; } catch { extra = null; }
    if (!extra) return blocked(`${name} blocked: the original message could not be read, so no Confirm card was created and nothing was sent. Try again in a moment.`);
  }
  let pending;
  try {
    pending = await createPending({ admin: ctx.admin, userId: user.id, action: name, args: normalized, now: ctx.now });
  } catch (e) {
    if (e?.code === 'invalid_args') return blocked(`${name} blocked: ${e.message}.`);
    return blocked(`${name} ${REASON_TEXT[e?.code] || REASON_TEXT.approval_store_unavailable}`);
  }
  if (!NEEDS_ORIGINAL.has(name)) {
    try { extra = (await ctx.describe?.(pending.args)) || null; } catch { /* the card still shows the exact fields */ }
  }
  try {
    ctx.onApprovalRequired({
      id: pending.id,
      action: name,
      fields: pending.args,
      context: extra,
      expires_at: new Date(pending.expiresAt).toISOString(),
    });
  } catch {
    return blocked(`${name} blocked: the Confirm card could not be delivered to the user. Nothing was sent.`);
  }
  log.info?.(JSON.stringify({ evt: 'approval_requested', user: user.id, action: name, reused: pending.reused }));
  return { content: PENDING_TEXT(name), is_error: false };
}

export { normalizeArgs };
