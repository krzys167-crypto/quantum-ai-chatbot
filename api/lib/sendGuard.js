// Guard for irreversible Gmail actions, called from runTool().
//
//   APPROVAL_MODE unset / "legacy"  -> the old behaviour: the MODEL-supplied `user_confirmed === true` (F09: this is
//                                      not evidence of user consent; kept as the default so production does not change
//                                      before the front end can ask the user).
//   APPROVAL_MODE = "server"        -> a server-signed approval token for exactly these arguments is required
//                                      (see approval.js). `user_confirmed` is ignored. Misconfiguration blocks.
import { verifyApproval, approvalSecretProblem, APPROVABLE_ACTIONS } from './approval.js';

export function approvalMode(env = process.env) {
  const raw = String(env.APPROVAL_MODE || 'legacy').trim().toLowerCase();
  return raw === 'server' ? 'server' : raw === 'legacy' ? 'legacy' : 'invalid';
}

const LEGACY_TEXT = {
  send_email: 'Send blocked: user_confirmed must be true. Confirm To/Subject/Body with the user first, then call send_email with user_confirmed=true. Prefer create_email_draft if unconfirmed.',
  reply_email: 'Reply blocked: user_confirmed must be true. Confirm the reply with the user first.',
  forward_email: 'Forward blocked: user_confirmed must be true. Confirm recipient with the user first.',
};

// Returns null when the action may proceed, otherwise the text of the error to give back to the model.
export function guardIrreversible(name, input, user, { env = process.env, now = Date.now() } = {}) {
  if (!APPROVABLE_ACTIONS.includes(name)) return null;
  const mode = approvalMode(env);
  if (mode === 'invalid') return `${name} blocked: APPROVAL_MODE must be "legacy" or "server".`;
  if (mode === 'legacy') return input && input.user_confirmed === true ? null : LEGACY_TEXT[name];
  const problem = approvalSecretProblem(env.APPROVAL_SECRET);
  if (problem) return `${name} blocked: ${problem}.`;
  const v = verifyApproval({
    secret: env.APPROVAL_SECRET, token: input && input.approval_token, userId: user && user.id, action: name, args: input, now,
  });
  return v.ok ? null : `${name} blocked: ${v.reason}. The user must confirm the exact content in the app; the assistant cannot confirm for them.`;
}
