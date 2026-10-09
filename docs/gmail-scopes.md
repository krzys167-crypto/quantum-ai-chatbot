# Gmail scopes vs. what the product does (F04)

Status: **text aligned with the product; scopes unchanged.** `public/privacy.html`, `public/home.html`, `public/terms.html` and the README now describe the scopes the code requests (option 1 below). `tests/policy-matches-scopes.test.mjs` compares the `<code>` scope tokens on those pages with `PROVIDER_SCOPES` / `MS_PROVIDER_SCOPES` and fails when they drift, or when a page calls Gmail read-only while write scopes are requested.

Not covered by this change, and not verifiable from this repository:

- the OAuth consent-screen text and scope list configured in the Google Cloud console must match (the owner edits it there);
- Google's verification status for the restricted/sensitive Gmail scopes;
- whether the policy wording is acceptable to the owner's lawyer. The edit states facts read from the code; it is not legal advice.

The original finding, kept for the record: `public/privacy.html` said the app requests **read-only** access and "does not request permission to send, delete, or modify your email", while the code requests more.

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

1. **Align the text with the product (done on this branch).** Describe sending, drafting and label/archive/trash actions in `public/privacy.html` and in the Google consent-screen configuration; keep the scopes. Smallest change, but the product then asks every Gmail user for write access. Sending is already gated by the server-signed approval of PR #1 (F09).
2. **Least privilege by default (recommended to evaluate).** Keep the `gmail` provider read-only (`gmail.readonly`) and add a second, opt-in provider (for example `gmail_actions`: send, compose, modify) that is requested only when the user turns on actions. Needs: a new provider name in `PROVIDER_SCOPES`, in the `connectors_provider_check` constraint, in the UI, and tool gating on the provider. The privacy text then stays true for the default connection.
3. **Remove the write tools** and keep the text as it is.

## Check before choosing

- Google classifies some Gmail scopes as restricted or sensitive and requires verification (restricted scopes can require a third-party security assessment). As far as I know `gmail.readonly`, `gmail.modify` and `gmail.compose` are restricted and `gmail.send` is sensitive; confirm in Google's current scope list before relying on this.
- The consent screen text configured in the Google Cloud console is not in this repository and was not read.
- Existing users keep the scopes they already granted until they reconnect.
