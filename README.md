# Cerebro

**Cerebro** is a small **personal memory service** on Supabase: **Slack** is the capture inbox, **MCP** is the read-only layer for AI tools. Messages are stored **raw** first; **lexical search** only—no embeddings or model calls at ingest.

- **One** table: `thoughts`
- **One** capture Edge Function: `cerebro-ingest-slack`
- **One** read Edge Function: `cerebro-mcp`

Mental model: *Cerebro is a small personal memory service backed by Supabase. Slack is the capture inbox. MCP is the read layer for AI tools.*

---

## Setup (in order)

### 1. Create a Supabase project

Note **project ref**, **URL**, and **service_role** key.

### 2. Link this repo

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

### 3. Run the migration

```bash
supabase db push
```

### 4. Secrets

```bash
supabase secrets set SLACK_SIGNING_SECRET=...
supabase secrets set SLACK_CAPTURE_CHANNEL_ID=C...
supabase secrets set MCP_ACCESS_KEY=your-long-random-string
```

Optional (log label only):

```bash
supabase secrets set SLACK_CAPTURE_CHANNEL_NAME=my-inbox
```

Or use a local `credentials.env` (see `credentials.env.example`):

```bash
supabase secrets set --env-file credentials.env
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are usually auto-injected on hosted Supabase. If not:

```bash
supabase secrets set SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

### 5. Deploy Edge Functions

```bash
supabase functions deploy cerebro-ingest-slack --no-verify-jwt
supabase functions deploy cerebro-mcp --no-verify-jwt
```

### 6. Slack app

1. Create a [Slack app](https://api.slack.com/apps).
2. **Event Subscriptions** → On → **Request URL**:
   `https://YOUR_PROJECT_REF.supabase.co/functions/v1/cerebro-ingest-slack`
3. Subscribe to **Bot events**: `message.channels`, `message.groups`.
4. **Install to workspace**, then **invite the app** to your capture channel.
5. Set `SLACK_CAPTURE_CHANNEL_ID` to that channel’s ID (`C...` or private equivalent).

**Gotchas**

- Private channels need `message.groups` and the bot **in the channel**.
- Slack **retries** → duplicate `event_id` is idempotent via unique `source_key`.
- The endpoint must pass **URL verification** (`challenge`) and verify **`X-Slack-Signature`** ([Slack signing secret](https://api.slack.com/authentication/verifying-requests-from-slack)).

### 7. Connect an MCP client

**URL:** `https://YOUR_PROJECT_REF.supabase.co/functions/v1/cerebro-mcp?key=YOUR_MCP_ACCESS_KEY`

Or header **`x-brain-key`** (same value as `MCP_ACCESS_KEY`).

Bridge example (`mcp-remote`):

```json
{
  "mcpServers": {
    "cerebro": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://YOUR_PROJECT_REF.supabase.co/functions/v1/cerebro-mcp",
        "--header",
        "x-brain-key:${BRAIN_KEY}"
      ],
      "env": {
        "BRAIN_KEY": "your-access-key-here"
      }
    }
  }
}
```

---

## MCP tools (read-only)

| Tool | Purpose |
|------|---------|
| `search_thoughts` | Lexical FTS + ILIKE fallback |
| `list_thoughts` | Recent rows by `updated_at` |
| `thought_stats` | Totals, by source, enrichment pending |
| `get_thought` | One row by `id` or `sourceKey` |

---

## How to test

1. Slack **URL verification** succeeds in Event Subscriptions.
2. Post a message in the **capture channel**.
3. Confirm a row in **`thoughts`** (`source_key` = `slack:event:…`).
4. Connect an MCP client to **`cerebro-mcp`**.
5. Run **`list_thoughts`**, **`search_thoughts`**, **`thought_stats`**, **`get_thought`**.

---

## Repo layout

```text
supabase/
  migrations/
    001_cerebro.sql
  functions/
    cerebro-ingest-slack/
    cerebro-mcp/
```

---

## Migrating from an older Notion/hybrid Cerebro

If you already applied older migrations (`source_page_id`, Notion ingest), this branch expects **`001_cerebro.sql` only** (Slack-shaped `thoughts`). Easiest path for a personal project: **new Supabase project** or reset DB and `db push`. Otherwise add a hand-written migration to drop `source_page_id` and remove Notion rows before switching.
