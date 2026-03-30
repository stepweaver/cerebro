/**
 * cerebro-mcp: hosted read-only MCP server over Streamable HTTP (Hono + MCP SDK).
 * Auth: x-brain-key header or ?key= query (must match MCP_ACCESS_KEY secret).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function timingSafeEqualUtf8(a: string, b: string): boolean {
  const ae = new TextEncoder().encode(a);
  const be = new TextEncoder().encode(b);
  if (ae.length !== be.length) return false;
  let d = 0;
  for (let i = 0; i < ae.length; i++) d |= ae[i] ^ be[i];
  return d === 0;
}

function excerpt(text: string, max = 200): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function createMcpServer(supabase: SupabaseClient): McpServer {
  const server = new McpServer({ name: "cerebro", version: "1.0.0" });

  server.registerTool(
    "search_thoughts",
    {
      description:
        "Lexical full-text search over captured Slack messages (title + content). Ranked excerpts.",
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        limit: z.number().int().min(1).max(50).optional().default(10),
        includeDeleted: z.boolean().optional().default(false),
      },
    },
    async ({ query, limit, includeDeleted }) => {
      const { data, error } = await supabase.rpc("lexical_search_thoughts", {
        search_query: query,
        result_limit: limit,
        include_deleted: includeDeleted,
      });
      if (error) {
        return textResult(`search error: ${error.message}`);
      }
      const rows = (data ?? []) as Array<{
        title: string | null;
        updated_at: string;
        source: string;
        source_key: string;
        source_url: string | null;
        content: string;
      }>;
      if (rows.length === 0) {
        return textResult("No matching thoughts.");
      }
      const lines = rows.map((r, i) => {
        const title = r.title?.trim() || "(no title)";
        return [
          `--- ${i + 1} ---`,
          `Source: ${r.source}`,
          `Updated: ${r.updated_at}`,
          `Title: ${title}`,
          `Source key: ${r.source_key}`,
          `Excerpt: ${excerpt(r.content)}`,
          "",
        ].join("\n");
      });
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "list_thoughts",
    {
      description: "List recent captured thoughts, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().default(10),
        days: z.number().int().min(1).max(3650).optional(),
        includeDeleted: z.boolean().optional().default(false),
      },
    },
    async ({ limit, days, includeDeleted }) => {
      let q = supabase
        .from("thoughts")
        .select(
          "id, title, source, source_key, source_url, updated_at, is_deleted, content, raw_metadata",
        )
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (!includeDeleted) q = q.eq("is_deleted", false);
      if (days != null) {
        const since = new Date();
        since.setUTCDate(since.getUTCDate() - days);
        q = q.gte("updated_at", since.toISOString());
      }
      const { data, error } = await q;
      if (error) return textResult(`list error: ${error.message}`);
      const rows = data ?? [];
      if (rows.length === 0) return textResult("No thoughts found.");
      const lines = rows.map((r: Record<string, unknown>, i: number) => {
        const title = (r.title as string | null)?.trim() || "(no title)";
        const rm = r.raw_metadata as Record<string, unknown> | null;
        const slackTs = rm?.slack_ts ?? "n/a";
        const slackUser = rm?.slack_user ?? "n/a";
        return [
          `--- ${i + 1} ---`,
          `Source: ${r.source}`,
          `Updated: ${r.updated_at}`,
          `Title: ${title}`,
          `Source key: ${r.source_key}`,
          `Slack user: ${slackUser}`,
          `Slack ts: ${slackTs}`,
          `Deleted: ${r.is_deleted}`,
          `Preview: ${excerpt(String(r.content ?? ""))}`,
          "",
        ].join("\n");
      });
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "thought_stats",
    {
      description: "Aggregate counts and date ranges.",
    },
    async () => {
      const { data, error } = await supabase.rpc("cerebro_thought_stats");
      if (error) return textResult(`stats error: ${error.message}`);
      const s = data as Record<string, unknown> | null;
      if (!s) return textResult("No stats.");
      const lines = [
        `Total rows: ${s.total}`,
        `Active (not deleted): ${s.active}`,
        `Deleted: ${s.deleted}`,
        `Earliest created_at: ${s.earliest_created_at ?? "n/a"}`,
        `Latest updated_at: ${s.latest_updated_at ?? "n/a"}`,
        `By source: ${JSON.stringify(s.by_source ?? {})}`,
        `Awaiting enrichment (enriched_at is null): ${s.awaiting_enrichment}`,
      ];
      return textResult(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_thought",
    {
      description: "Fetch one thought by row id or source_key.",
      inputSchema: {
        id: z.string().uuid().optional().describe("Cerebro row UUID"),
        sourceKey: z.string().min(1).optional().describe("e.g. slack:event:…"),
      },
    },
    async (args: { id?: string; sourceKey?: string }) => {
      const hasId = args.id != null && String(args.id).trim().length > 0;
      const hasKey = args.sourceKey != null && String(args.sourceKey).trim().length > 0;
      if (hasId === hasKey) {
        return textResult("Provide exactly one of id or sourceKey");
      }
      let q = supabase.from("thoughts").select("*");
      if (hasId) q = q.eq("id", args.id!);
      else q = q.eq("source_key", args.sourceKey!.trim());
      const { data, error } = await q.maybeSingle();
      if (error) return textResult(`get error: ${error.message}`);
      if (!data) return textResult("Not found.");
      const r = data as Record<string, unknown>;
      const meta = r.raw_metadata as Record<string, unknown> | null;
      const lines = [
        `id: ${r.id}`,
        `source: ${r.source}`,
        `source_key: ${r.source_key}`,
        `source_url: ${r.source_url ?? "n/a"}`,
        `title: ${r.title ?? "(none)"}`,
        `updated_at: ${r.updated_at}`,
        `created_at: ${r.created_at}`,
        `is_deleted: ${r.is_deleted}`,
        `enriched_at: ${r.enriched_at ?? "null"}`,
        "",
        "Metadata summary:",
        `  slack_event_id: ${meta?.slack_event_id ?? "n/a"}`,
        `  slack_channel: ${meta?.slack_channel ?? "n/a"}`,
        `  slack_user: ${meta?.slack_user ?? "n/a"}`,
        `  slack_ts: ${meta?.slack_ts ?? "n/a"}`,
        `  slack_team_id: ${meta?.slack_team_id ?? "n/a"}`,
        "",
        "Content:",
        String(r.content ?? ""),
      ];
      return textResult(lines.join("\n"));
    },
  );

  return server;
}

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "mcp-session-id",
      "Last-Event-ID",
      "mcp-protocol-version",
      "x-brain-key",
    ],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  }),
);

app.use("*", async (c, next) => {
  const expected = Deno.env.get("MCP_ACCESS_KEY");
  const key = c.req.header("x-brain-key") ?? c.req.query("key") ?? "";
  if (!expected || !timingSafeEqualUtf8(key, expected)) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }
  await next();
});

app.all("*", async (c) => {
  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const transport = new WebStandardStreamableHTTPServerTransport();
  const mcp = createMcpServer(supabase);
  await mcp.connect(transport);
  return transport.handleRequest(c.req.raw);
});

Deno.serve(app.fetch);