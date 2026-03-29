/**
 * cerebro-ingest-notion: Notion webhook receiver → fetch latest page → upsert into Supabase `thoughts`.
 * No model calls; mirrors raw Notion state for search/MCP.
 */
import { createClient } from "@supabase/supabase-js";

const NOTION_VERSION = "2026-03-11";
const NOTION_BASE = "https://api.notion.com";

// --- env -------------------------------------------------------------------
function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

// --- crypto: Notion X-Notion-Signature (HMAC-SHA256 over raw body, sha256=hex) ---
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const n = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(n)) return null;
    out[i / 2] = n;
  }
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function verifyNotionSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const theirHex = signatureHeader.slice("sha256=".length);
  const theirBytes = hexToBytes(theirHex);
  if (!theirBytes) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const ours = new Uint8Array(mac);
  return timingSafeEqual(ours, theirBytes);
}

// --- Notion API ------------------------------------------------------------
type NotionRichText = { plain_text?: string; text?: { content?: string } };

function flattenRichText(rich?: NotionRichText[] | null): string {
  if (!rich?.length) return "";
  return rich.map((t) => t.plain_text ?? t.text?.content ?? "").join("");
}

function extractTitleFromPage(page: Record<string, unknown>): string {
  const props = page.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return "";
  for (const def of Object.values(props)) {
    if (def?.type === "title") {
      const t = flattenRichText(def.title as NotionRichText[]);
      if (t.trim()) return t.trim();
    }
  }
  return "";
}

function summarizeProperties(
  properties: Record<string, Record<string, unknown>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!properties) return out;
  for (const [name, def] of Object.entries(properties)) {
    const type = def?.type as string;
    let s = type;
    try {
      switch (type) {
        case "title":
          s = flattenRichText(def.title as NotionRichText[]) || type;
          break;
        case "rich_text":
          s = flattenRichText(def.rich_text as NotionRichText[]) || type;
          break;
        case "select":
          s = String((def.select as { name?: string } | null)?.name ?? type);
          break;
        case "multi_select": {
          const ms = (def.multi_select as { name?: string }[]) ?? [];
          s = ms.map((x) => x.name).filter(Boolean).join(", ") || type;
          break;
        }
        case "status":
          s = String((def.status as { name?: string } | null)?.name ?? type);
          break;
        case "number":
          s = def.number != null ? String(def.number) : type;
          break;
        case "checkbox":
          s = def.checkbox === true ? "true" : def.checkbox === false ? "false" : type;
          break;
        case "url":
          s = String(def.url ?? type);
          break;
        case "email":
        case "phone_number":
          s = String(def[type] ?? type);
          break;
        case "date": {
          const d = def.date as { start?: string } | null;
          s = d?.start ?? type;
          break;
        }
        case "people":
        case "created_by":
        case "last_edited_by":
          s = type;
          break;
        default:
          s = type;
      }
    } catch {
      s = type;
    }
    if (s.length > 120) s = s.slice(0, 120) + "…";
    out[name] = s;
  }
  return out;
}

function notionHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notionGet(
  apiKey: string,
  path: string,
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    headers: notionHeaders(apiKey),
  });
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json(),
  };
}

function normalizeId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

/** Walk parent chain (page / database / block) until workspace or depth cap. */
async function isUnderAllowedParent(
  apiKey: string,
  start: Record<string, unknown>,
  allowedRaw: string,
): Promise<boolean> {
  const allowed = normalizeId(allowedRaw);
  let entity: Record<string, unknown> | null = start;
  for (let depth = 0; depth < 40 && entity; depth++) {
    const eid = String(entity.id ?? "");
    if (eid && normalizeId(eid) === allowed) return true;
    const parent = entity.parent as { type?: string; id?: string } | undefined;
    if (!parent?.type || parent.type === "workspace") return false;
    if (parent.id && normalizeId(parent.id) === allowed) return true;

    const pid = parent.id;
    if (!pid) return false;

    if (parent.type === "page_id") {
      const r = await notionGet(apiKey, `/v1/pages/${pid}`);
      if (!r.ok) return false;
      entity = (await r.json()) as Record<string, unknown>;
      continue;
    }
    if (parent.type === "database_id") {
      const r = await notionGet(apiKey, `/v1/databases/${pid}`);
      if (!r.ok) {
        entity = null;
        break;
      }
      entity = (await r.json()) as Record<string, unknown>;
      continue;
    }
    if (parent.type === "block_id") {
      const r = await notionGet(apiKey, `/v1/blocks/${pid}`);
      if (!r.ok) return false;
      entity = (await r.json()) as Record<string, unknown>;
      continue;
    }
    // data_source_id and others: treat as opaque; compare id only
    if (parent.type === "data_source_id") {
      const r = await notionGet(apiKey, `/v1/data_sources/${pid}`);
      if (r.ok) {
        entity = (await r.json()) as Record<string, unknown>;
        continue;
      }
      return false;
    }
    return false;
  }
  return false;
}

async function fetchPageMarkdown(apiKey: string, pageId: string): Promise<string | null> {
  const r = await notionGet(apiKey, `/v1/pages/${pageId}/markdown`);
  if (!r.ok) return null;
  const body = (await r.json()) as { object?: string; markdown?: string };
  if (body.object !== "page_markdown" || typeof body.markdown !== "string") return null;
  return body.markdown;
}

async function fetchBlocksAsText(apiKey: string, blockId: string): Promise<string> {
  const lines: string[] = [];

  async function walk(id: string, depth: number): Promise<void> {
    if (depth > 50) return;
    let cursor: string | undefined;
    do {
      const q = cursor
        ? `/v1/blocks/${id}/children?start_cursor=${encodeURIComponent(cursor)}&page_size=100`
        : `/v1/blocks/${id}/children?page_size=100`;
      const res = await fetch(`${NOTION_BASE}${q}`, { headers: notionHeaders(apiKey) });
      if (!res.ok) break;
      const data = (await res.json()) as {
        results?: Record<string, unknown>[];
        has_more?: boolean;
        next_cursor?: string | null;
      };
      const results = data.results ?? [];
      for (const block of results) {
        await emitBlock(block as Record<string, unknown>, depth);
        const bid = block.id as string;
        const type = block.type as string;
        if (
          bid &&
          type !== "child_page" &&
          type !== "child_database" &&
          (block as { has_children?: boolean }).has_children
        ) {
          await walk(bid, depth + 1);
        }
      }
      cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined;
    } while (cursor);
  }

  async function emitBlock(block: Record<string, unknown>, depth: number): Promise<void> {
    const type = block.type as string;
    const pad = "  ".repeat(Math.min(depth, 8));

    const rich = (t: string) =>
      flattenRichText((block[t] as { rich_text?: NotionRichText[] })?.rich_text);

    switch (type) {
      case "paragraph":
        lines.push(pad + rich("paragraph"));
        break;
      case "heading_1":
        lines.push(pad + "# " + rich("heading_1"));
        break;
      case "heading_2":
        lines.push(pad + "## " + rich("heading_2"));
        break;
      case "heading_3":
        lines.push(pad + "### " + rich("heading_3"));
        break;
      case "bulleted_list_item":
        lines.push(pad + "- " + rich("bulleted_list_item"));
        break;
      case "numbered_list_item":
        lines.push(pad + "1. " + rich("numbered_list_item"));
        break;
      case "to_do": {
        const td = block.to_do as { checked?: boolean; rich_text?: NotionRichText[] };
        const mark = td?.checked ? "[x]" : "[ ]";
        lines.push(pad + `${mark} ${flattenRichText(td?.rich_text)}`);
        break;
      }
      case "quote":
        lines.push(pad + "> " + rich("quote"));
        break;
      case "callout":
        lines.push(pad + rich("callout"));
        break;
      case "code": {
        const c = block.code as { rich_text?: NotionRichText[] };
        lines.push(pad + "```\n" + flattenRichText(c?.rich_text) + "\n```");
        break;
      }
      case "divider":
        lines.push(pad + "---");
        break;
      case "synced_block":
      case "table":
      case "column_list":
      case "column":
        break;
      case "child_page": {
        const cp = block.child_page as { title?: string };
        lines.push(pad + `[child page: ${cp?.title ?? "untitled"}]`);
        break;
      }
      case "child_database":
        lines.push(pad + "[child database]");
        break;
      default:
        if (type) lines.push(pad + `[${type}]`);
    }
  }

  await walk(blockId, 0);
  return lines.filter((l) => l.trim().length > 0).join("\n");
}

async function fetchPageContent(apiKey: string, pageId: string): Promise<string> {
  const md = await fetchPageMarkdown(apiKey, pageId);
  if (md != null && md.trim().length > 0) return md;
  const text = await fetchBlocksAsText(apiKey, pageId);
  return text;
}

// --- main ------------------------------------------------------------------

const PAGE_EVENTS = new Set([
  "page.created",
  "page.content_updated",
  "page.properties_updated",
  "page.deleted",
  "page.undeleted",
]);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const verificationToken = requireEnv("NOTION_WEBHOOK_VERIFICATION_TOKEN");
  const sigOk = await verifyNotionSignature(
    rawBody,
    req.headers.get("X-Notion-Signature"),
    verificationToken,
  );
  if (!sigOk) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Subscription verification payload (no event shape) — acknowledge.
  if ("verification_token" in payload && !("type" in payload)) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const eventType = payload.type as string | undefined;
  const entity = payload.entity as { id?: string; type?: string } | undefined;
  const eventId = payload.id as string | undefined;

  if (!eventType || !entity?.id || entity.type !== "page") {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!PAGE_EVENTS.has(eventType)) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const pageId = entity.id;
  const apiKey = requireEnv("NOTION_API_KEY");
  const supabase = createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  );

  const allowedParent = Deno.env.get("NOTION_ALLOWED_PARENT_ID")?.trim();

  try {
    if (eventType === "page.deleted") {
      await supabase
        .from("thoughts")
        .update({ is_deleted: true })
        .eq("source_page_id", pageId);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const pageRes = await notionGet(apiKey, `/v1/pages/${pageId}`);
    if (!pageRes.ok) {
      // Page gone or no access — soft success for webhook ack
      return new Response(JSON.stringify({ ok: true, skipped: "page_not_readable" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const page = (await pageRes.json()) as Record<string, unknown>;

    if (allowedParent) {
      const okScope = await isUnderAllowedParent(apiKey, page, allowedParent);
      if (!okScope) {
        return new Response(JSON.stringify({ ok: true, skipped: "outside_allowed_parent" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (eventType === "page.undeleted") {
      await supabase.from("thoughts").update({ is_deleted: false }).eq(
        "source_page_id",
        pageId,
      );
    }

    const title = extractTitleFromPage(page);
    const content = await fetchPageContent(apiKey, pageId);
    const titleTrim = title.trim();
    const contentTrim = content.trim();

    if (titleTrim.length === 0 && contentTrim.length === 0) {
      return new Response(JSON.stringify({ ok: true, skipped: "empty" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const props = page.properties as Record<string, Record<string, unknown>> | undefined;
    const parent = page.parent as { type?: string; id?: string } | undefined;
    const sourceUrl = typeof page.url === "string" ? page.url : null;

    const rawMetadata = {
      source: "notion",
      notion_page_id: pageId,
      notion_parent: parent ?? null,
      notion_url: sourceUrl,
      notion_last_edited_time: page.last_edited_time ?? null,
      notion_created_time: page.created_time ?? null,
      notion_created_by: page.created_by ?? null,
      notion_last_edited_by: page.last_edited_by ?? null,
      notion_webhook_event_id: eventId ?? null,
      notion_event_type: eventType,
      notion_api_version: NOTION_VERSION,
      notion_properties_summary: summarizeProperties(props),
    };

    const row = {
      source: "notion",
      source_key: `notion:page:${pageId}`,
      source_page_id: pageId,
      source_url: sourceUrl,
      title: titleTrim.length ? title : null,
      content: contentTrim.length ? content : "",
      raw_metadata: rawMetadata,
      metadata: {},
      embedding: null,
      enriched_at: null,
      is_deleted: false,
    };

    const { error } = await supabase.from("thoughts").upsert(row, {
      onConflict: "source_page_id",
    });

    if (error) {
      console.error("supabase upsert error", error);
      return new Response(JSON.stringify({ error: "upsert_failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
