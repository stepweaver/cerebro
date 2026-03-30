/**
 * cerebro-ingest-slack: Slack Events API → one raw row per human message in a capture channel.
 * Verifies signing secret; no models, no write-back.
 */
import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function verifySlackSignature(
  rawBody: string,
  sigHeader: string | null,
  tsHeader: string | null,
  signingSecret: string,
): Promise<boolean> {
  if (!sigHeader?.startsWith("v0=") || !tsHeader) return false;
  const ts = parseInt(tsHeader, 10);
  if (Number.isNaN(ts)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (age > 60 * 5) return false;

  const base = `v0:${tsHeader}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const ours = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const theirBytes = new TextEncoder().encode(sigHeader);
  const ourBytes = new TextEncoder().encode(ours);
  return timingSafeEqual(theirBytes, ourBytes);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const signingSecret = requireEnv("SLACK_SIGNING_SECRET");
  const okSig = await verifySlackSignature(
    rawBody,
    req.headers.get("X-Slack-Signature"),
    req.headers.get("X-Slack-Request-Timestamp"),
    signingSecret,
  );
  if (!okSig) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // URL verification challenge (Slack sends this when you set the Request URL)
  if (body.type === "url_verification" && typeof body.challenge === "string") {
    return new Response(body.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (body.type !== "event_callback") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const eventId = typeof body.event_id === "string" ? body.event_id : null;
  const teamId = typeof body.team_id === "string" ? body.team_id : null;
  const event = body.event as Record<string, unknown> | undefined;
  const captureChannel = requireEnv("SLACK_CAPTURE_CHANNEL_ID").trim();
  const channelLabel = Deno.env.get("SLACK_CAPTURE_CHANNEL_NAME")?.trim();

  if (!eventId || !event) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const evType = event.type as string | undefined;
  if (evType !== "message") {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Subtypes: edits, deletes, bot_message, etc. — only plain human messages
  if (event.subtype != null) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (event.bot_id != null || event.bot_profile != null) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const channel = typeof event.channel === "string" ? event.channel : "";
  if (channel !== captureChannel) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const text = typeof event.text === "string" ? event.text.trim() : "";
  if (!text) {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const user = typeof event.user === "string" ? event.user : null;
  const ts = typeof event.ts === "string" ? event.ts : null;

  const supabase = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));

  const rawMetadata: Record<string, unknown> = {
    source: "slack",
    slack_event_id: eventId,
    slack_channel: channel,
    slack_user: user,
    slack_ts: ts,
    capture_kind: "inbox",
  };
  if (teamId) rawMetadata.slack_team_id = teamId;

  const row = {
    source: "slack",
    source_key: `slack:event:${eventId}`,
    source_url: null as string | null,
    title: null as string | null,
    content: text,
    raw_metadata: rawMetadata,
    metadata: {},
    embedding: null,
    enriched_at: null,
    is_deleted: false,
  };

  const { error } = await supabase.from("thoughts").insert(row);

  if (error) {
    // Slack retries duplicate event deliveries → idempotent source_key
    if (error.code === "23505") {
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("slack insert error", error);
    return new Response(JSON.stringify({ error: "insert_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (channelLabel) {
    console.log(`cerebro-ingest-slack: captured message in ${channelLabel} (${channel})`);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
