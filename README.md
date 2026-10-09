# Quantum AI Chatbot

Premium mobile-first AI chatbot with **Supabase Auth**, **conversation history**, and **granular Connectors** (Gmail first).

## Features

- Smooth mobile-first UI (dark/light)
- Supabase email/password auth
- Persistent chat history per user
- **Connectors**: connect Gmail alone (Drive & Sheets coming next)
- AI can search connected Gmail via tool calling
- Secure Anthropic proxy (API key never in the browser)

## Setup

### 1. Supabase — Phase 1 tables

Run the conversations/messages SQL from the earlier setup (or see git history).

### 2. Supabase — Connectors table

> After this step also run `supabase/connectors-hardening.sql` (OAuth state table + token column privileges). See `docs/connector-security.md`; the OAuth connect flow fails closed until it is applied.

**SQL Editor → New query → run** `supabase/connectors.sql` (also below):

```sql
create table if not exists public.connectors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  provider text not null check (provider in ('gmail', 'google_drive', 'google_sheets')),
  account_email text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scopes text[] default '{}',
  status text not null default 'connected' check (status in ('connected', 'error', 'revoked')),
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique (user_id, provider)
);

create index if not exists connectors_user_id_idx on public.connectors(user_id);
alter table public.connectors enable row level security;

create policy "Users can view own connectors"
  on public.connectors for select using (auth.uid() = user_id);

create policy "Users can delete own connectors"
  on public.connectors for delete using (auth.uid() = user_id);
```

### 3. Google Cloud OAuth (for Gmail connector)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create/select a project
3. **APIs & Services → Enable APIs**: Gmail API
4. **OAuth consent screen** → External → add scopes:
   - `.../auth/gmail.readonly`
   - `.../auth/userinfo.email`
5. **Credentials → Create OAuth client ID** → Web application
6. Authorized redirect URIs:
   - `https://YOUR-APP.vercel.app/api/connectors/google-callback`
   - `http://localhost:5173/api/connectors/google-callback` (local, if testing API)
7. Copy **Client ID** and **Client Secret**

### 4. Environment variables

**Vercel → Project → Settings → Environment Variables:**

| Name | Where |
|------|--------|
| `VITE_SUPABASE_URL` | Client + server |
| `VITE_SUPABASE_ANON_KEY` | Client |
| `ANTHROPIC_API_KEY` | Server |
| `SUPABASE_SERVICE_ROLE_KEY` | Server (Supabase → Settings → API) |
| `GOOGLE_CLIENT_ID` | Server |
| `GOOGLE_CLIENT_SECRET` | Server |
| `APP_URL` | Server, e.g. `https://quantumy-xi.vercel.app` |

Redeploy after adding env vars.

### 5. Run locally

```bash
npm install
npm run dev
```

Note: OAuth callback and tool APIs need the Vercel deployment (or a local serverless adapter). Connect Gmail on the production URL.

## How Connectors work

1. Settings → **Connectors** → **Connect** on Gmail
2. User is sent to Google and only asked for Gmail read access
3. Tokens stored in `connectors` (server uses service role)
4. When the user asks about email, Claude can call `search_gmail`
5. **Disconnect** removes the row and access

Drive / Sheets buttons are visible but marked **Soon** — same pattern when you enable them.

## Security

- Anthropic + Google client secret stay on the server
- Service role is only used in API routes
- Client only selects non-token columns from `connectors`
- Each connector is opt-in with minimal scopes
