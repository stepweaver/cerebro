# Cerebro

**Cerebro** is a small **personal memory service**: **Slack** is the quick capture inbox, **Notion** is an optional structured source, and both stream **raw** rows into Supabase. **MCP** is the read-only retrieval layer. **AI enrichment** can be added later; capture does **not** depend on any model.

This build stays intentionally small:

- **One** Postgres table: `thoughts`
- **Two** capture Edge Functions: `cerebro-ingest-slack`, `cerebro-ingest-notion`
- **One** read Edge Function: `cerebro-mcp` (lexical search only; no embeddings at ingest)

Mental model: *Cerebro is an owned memory store with multiple raw capture sources. Slack is the quick inbox. Notion is optional structured input. MCP is the retrieval layer.*

---

## Architecture

- **Slack**: humans post in a dedicated channel; Events API delivers `message` payloads; **one message = one thought**, keyed by `slack:event:{event_id}`.
- **Notion**: webhooks are signals only; ingest refetches the page (`Notion-Version: 2026-03-11`), prefers markdown, falls back to blocks; keyed by `notion:page:{page_id}`.
- **`cerebro-mcp`**: read-only tools (`search_thoughts`, `list_thoughts`, `thought_stats`, `get_thought`) using the service role.

---

## Setup (in order)

### 1. Create a Supabase project

Note **Project URL**, **project ref**, and **service_role** key (Settings → API).

### 2. Link this repo

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

### 3. Run migrations

```bash
supabase db push
```

### 4. Slack app (inbox)

1. Create a [Slack app](https://api.slack.com/apps) for your workspace.
2. **Event Subscriptions** → On → **Request URL**:
   `https://YOUR_PROJECT_REF.supabase.co/functions/v1/cerebro-ingest-slack`
3. Subscribe to bot events: **`message.channels`** and **`message.groups`** (private channels need `message.groups`).
4. **Install to workspace**, then **invite the app/bot** to your dedicated capture channel.
5. Copy the channel ID (e.g. `C...`) for `SLACK_CAPTURE_CHANNEL_ID`.

**Slack gotchas**

- The app must be **in the channel** to receive messages.
- Private channels need **`message.groups`** and an install that includes that scope.
- Slack **retries** deliveries; duplicate `event_id` hits the unique `source_key` and returns **200** (idempotent).

### 5. Notion (optional mirror)

1. [My integrations](https://www.notion.so/my-integrations) → internal integration with **Read content**.
2. **Webhooks** → URL:
   `https://YOUR_PROJECT_REF.supabase.co/functions/v1/cerebro-ingest-notion`
3. Subscribe to page events you care about (e.g. `page.created`, `page.content_updated`, `page.properties_updated`, `page.deleted`, `page.undeleted`).
4. Copy the webhook **verification token** for `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
5. Share **pages or the original data source** with the integration (avoid linked-only views for API sync).

**Notion gotchas**

- Without sharing, reads fail.
- Webhooks are notifications only; ingest **refetches** the page.
- This mirror is **latest state only**, not revision history.

### 6. Secrets

```bash
supabase secrets set NOTION_API_KEY=secret_...
supabase secrets set NOTION_WEBHOOK_VERIFICATION_TOKEN=secret_...
supabase secrets set SLACK_SIGNING_SECRET=...
supabase secrets set SLACK_CAPTURE_CHANNEL_ID=C...
supabase secrets set MCP_ACCESS_KEY=your-long-random-string
```

Optional:

```bash
supabase secrets set NOTION_ALLOWED_PARENT_ID=uuid
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are usually auto-injected on hosted Supabase. If not:

```bash
supabase secrets set SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

### 7. Deploy Edge Functions

```bash
supabase functions deploy cerebro-ingest-notion --no-verify-jwt
supabase functions deploy cerebro-ingest-slack --no-verify-jwt
supabase functions deploy cerebro-mcp --no-verify-jwt
```

### 8. Connect Cursor to `cerebro-mcp`

**URL with query key:**

`https://YOUR_PROJECT_REF.supabase.co/functions/v1/cerebro-mcp?key=YOUR_MCP_ACCESS_KEY`

Or header **`x-brain-key`** (same value as `MCP_ACCESS_KEY`).

If you need a local bridge, use **`mcp-remote`**:

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
| `search_thoughts` | Lexical FTS + optional `source` filter |
| `list_thoughts` | Recent rows; optional `source`, `days` |
| `thought_stats` | Totals, by source, enrichment pending count |
| `get_thought` | One row by `id` or `sourceKey` |

Not implemented: capture/update/delete tools, semantic search, write-back to Slack or Notion.

---

## How to test

1. **Slack**: Complete URL verification in Event Subscriptions; post a message in the capture channel.
2. **DB**: Row in `thoughts` with `source = slack`, `source_key = slack:event:...`, `content` = message text.
3. **MCP**: `list_thoughts` with `source: "slack"`; `search_thoughts` on a phrase from the message.
4. **Notion**: Edit a shared page; confirm a `source = notion` row (or update) still works.
5. **MCP**: `thought_stats` shows counts for both sources.

---

## Repo layout

```text
supabase/
  migrations/
    001_cerebro.sql
    002_hybrid_slack.sql
  functions/
    cerebro-ingest-notion/
    cerebro-ingest-slack/
    cerebro-mcp/
```
