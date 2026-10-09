# Gmail scopes vs. what the product does (F04)

Facts from the code on this branch; the decision is the owner's. `public/privacy.html` currently says the app requests **read-only** access and "does not request permission to send, delete, or modify your email".

## Scopes requested (`api/lib/google.js`, provider `gmail`)

`gmail.readonly`, `gmail.send`, `gmail.compose`, `gmail.modify` (plus `userinfo.email`, `userinfo.profile`).

## What each feature actually calls

| Tool (`api/lib/claudeTools.js`) | Gmail endpoint | Needs |
|---|---|---|
| `search_gmail`, `get_gmail_message` | `messages.list`, `messages.get` | `gmail.readonly` |
| `send_email`, `reply_email`, `forward_email` | `messages.send` | `gmail.send` |
| `create_email_draft` | `drafts.create` | `gmail.compose` |
| `modify_gmail`, `bulk_archive_gmail`, `list_gmail_labels` | `messages.modify`, `messages.batchModify`, `labels.*`, `messages.trash` | `gmail.modify` |

Every requested scope is used by a shipped tool, so dropping one scope without dropping its tool would break that tool. The privacy text, not the code, is out of line with reality today.

## Options

1. **Align the text with the product.** Describe sending, drafting and label/archive/trash actions in `public/privacy.html` and in the Google consent-screen configuration; keep the scopes. Smallest change, but the product then asks every Gmail user for write access. Sending is already gated by the server-signed approval of PR #1 (F09).
2. **Least privilege by default (recommended to evaluate).** Keep the `gmail` provider read-only (`gmail.readonly`) and add a second, opt-in provider (for example `gmail_actions`: send, compose, modify) that is requested only when the user turns on actions. Needs: a new provider name in `PROVIDER_SCOPES`, in the `connectors_provider_check` constraint, in the UI, and tool gating on the provider. The privacy text then stays true for the default connection.
3. **Remove the write tools** and keep the text as it is.

## Check before choosing

- Google classifies some Gmail scopes as restricted or sensitive and requires verification (restricted scopes can require a third-party security assessment). As far as I know `gmail.readonly`, `gmail.modify` and `gmail.compose` are restricted and `gmail.send` is sensitive; confirm in Google's current scope list before relying on this.
- The consent screen text configured in the Google Cloud console is not in this repository and was not read.
- Existing users keep the scopes they already granted until they reconnect.
