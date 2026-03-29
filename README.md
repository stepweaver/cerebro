# Cerebro

**Cerebro** is a minimal **Notion → Supabase mirror** with a **hosted MCP** read API. Notion is the human-facing source of truth; Cerebro stores a **latest snapshot** of each page for **lexical search** and tool-based retrieval.

This version is intentionally small:

- **One** Postgres table: `thoughts`
- **One** Edge Function for capture: `cerebro-ingest-notion` (Notion webhooks → upsert)
- **One** Edge Function for retrieval: `cerebro-mcp` (read-only MCP over HTTP)
- **Lexical** search first (Postgres full-text search); **no** embeddings or model calls at ingest
- **No** AI enrichment pipeline yet (optional later)

Raw capture does **not** depend on any LLM. Optional enrichment can be added on top later.

---

## Architecture

- **Notion**: capture and editing UI; sends webhook **signals** only (not full page bodies).
- **`cerebro-ingest-notion`**: verifies `X-Notion-Signature`, fetches the page again from the Notion API (`Notion-Version: 2026-03-11`), prefers **page-as-markdown**, falls back to **block tree → plain text**, upserts into `thoughts`.
- **`cerebro-mcp`**: **read-only** MCP server (`name: cerebro`) using the **Streamable HTTP** transport; queries Supabase with the service role.

Mental model: **Cerebro is a single MCP server backed by Supabase; Notion is the capture UI.**

---

## Setup (in order)

### 1. Create a Supabase project

Create a project in the [Supabase dashboard](https://supabase.com/dashboard) and note **Project URL** and **service_role** key (Settings → API).

### 2. Link this repo to Supabase

Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from the repo root:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

### 3. Run the migration

```bash
supabase db push
```

(Or apply [`supabase/migrations/001_cerebro.sql`](supabase/migrations/001_cerebro.sql) in the SQL editor.)

### 4. Create a Notion internal integration

1. [My integrations](https://www.notion.so/my-integrations) → **New integration**.
2. Under **Capabilities**, enable **Read content** (required for page body and markdown).

### 5. Webhook subscription

1. Open the integration → **Webhooks** → **Create a subscription**.
2. **Webhook URL**:

   `https://YOUR_PROJECT_REF.supabase.co/functions/v1/cerebro-ingest-notion`

3. Subscribe at least to: `page.created`, `page.content_updated`, `page.properties_updated`, `page.deleted`, `page.undeleted`.
4. Complete Notion’s verification flow; copy the **webhook verification token** (used as the HMAC secret for `X-Notion-Signature`).

### 6. Share content with the integration

- Share the **pages** or **original data source** you want mirrored (**not** a linked database / linked data source view — the API does not treat those as first-class sync targets).
- If the integration is not invited to the page or data source, API reads will **404** / fail.

### 7. Set Edge Function secrets

```bash
supabase secrets set NOTION_API_KEY=secret_...
supabase secrets set NOTION_WEBHOOK_VERIFICATION_TOKEN=secret_...
supabase secrets set MCP_ACCESS_KEY=your-long-random-string
```

Optional (restrict mirroring to a subtree):

```bash
supabase secrets set NOTION_ALLOWED_PARENT_ID=uuid-of-parent-page-or-database
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are usually **injected automatically** for Edge Functions in hosted Supabase. If yours are not, set them explicitly:

```bash
supabase secrets set SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

### 8. Deploy Edge Functions

JWT verification is disabled so Notion and MCP clients do not need a Supabase JWT:

```bash
supabase functions deploy cerebro-ingest-notion --no-verify-jwt
supabase functions deploy cerebro-mcp --no-verify-jwt
```

### 9. Connect Cursor to `cerebro-mcp`

**MCP URL pattern** (query key):

`https://YOUR_PROJECT_REF.supabase.co/functions/v1/cerebro-mcp?key=YOUR_MCP_ACCESS_KEY`

Or send header **`x-brain-key: YOUR_MCP_ACCESS_KEY`** (same value as `MCP_ACCESS_KEY`).

- If Cursor supports **remote MCP URLs** directly, use the URL above.
- If Cursor only supports a **local stdio** MCP, use a bridge such as **`mcp-remote`**:

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
| `search_thoughts` | Lexical FTS (+ ILIKE fallback) over `thoughts` |
| `list_thoughts` | Recent rows by `updated_at` |
| `thought_stats` | Counts, date ranges, per-`source` totals |
| `get_thought` | One row by Cerebro `id` or Notion page id |

There is **no** `capture_thought`, `update_thought`, `delete_thought`, semantic search, or write-back to Notion in this build.

---

## Notion behavior notes

- Webhooks are **notifications**; this stack **always refetches** the page via the API after an event.
- **Page content** and **page properties** updates may arrive as **different** event types; both paths upsert the same row.
- Cerebro stores the **current** page snapshot only — **not** full revision history.
- This version is **lexical search only**; vector / enrichment can be layered on later.

---

## Common Notion gotchas

- **Sharing**: If the integration is not shared on the page or underlying data source, reads fail.
- **Linked views**: Linked databases / linked data sources are poor fit for API-based sync; share the **original** data source.
- **Latency**: Some events (e.g. `page.content_updated`) can be **aggregated** and arrive after a short delay.
- **Signature**: Store the **verification token** as `NOTION_WEBHOOK_VERIFICATION_TOKEN`; each payload is verified with **HMAC-SHA256** over the **raw** body (`X-Notion-Signature: sha256=...`).

---

## How to test

1. **Create or edit** a Notion page that is shared with the integration (add some title and body text).
2. Confirm the **webhook** fires (Notion integration webhook delivery UI or Supabase Edge Function logs).
3. In Supabase **Table Editor** or SQL: confirm a row in **`thoughts`** with the expected `source_page_id` and `content`.
4. Connect Cursor (or `mcp-remote`) to **`cerebro-mcp`** using `MCP_ACCESS_KEY`.
5. In the MCP client, run **`list_thoughts`**, **`search_thoughts`**, **`thought_stats`**, and optionally **`get_thought`** with a known page id.

---

## Repo layout

```text
supabase/
  migrations/
    001_cerebro.sql          -- thoughts + FTS + RLS + search/stats RPCs
  functions/
    cerebro-ingest-notion/   -- Notion webhook → mirror
    cerebro-mcp/             -- Hosted MCP (read-only)
```
