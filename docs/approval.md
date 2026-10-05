# Server-side approval for irreversible actions (audit F09)

`send_email`, `reply_email` and `forward_email` used to be guarded by `input.user_confirmed === true`. That value is an
argument **the model supplies**, so it is not evidence that the user agreed to anything.

## What this adds
* `api/lib/approval.js` - HMAC-SHA256 approval tokens bound to the user, the action, a digest of the exact arguments
  (to/cc/bcc/subject/body, or message_id/reply_all/body ...), an expiry (default 120 s) and a nonce.
* `api/approve-action.js` - `POST /api/approve-action {action, args}` with the user's Supabase bearer token returns a token.
  The front end calls it **after the user clicked Confirm on the exact content**.
* `api/lib/sendGuard.js` - used by `runTool`. `APPROVAL_MODE=legacy` (default, unchanged behaviour) or
  `APPROVAL_MODE=server` (requires a valid `approval_token`; `user_confirmed` is ignored; a missing/short
  `APPROVAL_SECRET` or an unknown mode blocks).
* `npm test` - 18 `node:test` tests (a mutation check of 8 faults: all killed).

## What is NOT done (so F09 stays OPEN until it is)
1. **Front end**: nothing shows the user the content and calls `/api/approve-action` yet. Until it does, `server` mode would
   block every send. Needed: render the pending action from the blocked tool result, a Confirm button, then pass
   `approval_token` back to the assistant.
2. **Single use**: tokens are stateless, so the same token can be replayed for the same user + content until it expires.
   The nonce is in the token; a Supabase table of used nonces closes this.
3. Set `APPROVAL_SECRET` (random, >= 32 characters) in the deployment, then `APPROVAL_MODE=server`.
