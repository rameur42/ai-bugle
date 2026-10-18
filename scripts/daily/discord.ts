// scripts/daily/discord.ts — post the veille digest to a Discord channel via an incoming webhook.
//
// Used by veille.ts:
//   import { postDigestToDiscord } from "./discord";
//   await postDigestToDiscord(markdownDigest);
//
// Discord limits: 2 000 chars per message `content`, ~5 requests/s per webhook.
// The digest is split on paragraph boundaries into ≤2 000-char chunks and posted in order.

const WEBHOOK_URL = process.env.VEILLE_DISCORD_WEBHOOK_URL;
const REQUIRE = (process.env.VEILLE_REQUIRE_DISCORD ?? "false").toLowerCase() === "true";
const MAX_LEN = 2000;

/** Slack mrkdwn → Discord markdown. Only needed if the digest is still generated in Slack syntax. */
export function slackToDiscord(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)") // <url|label> → [label](url)
    .replace(/<(https?:\/\/[^>]+)>/g, "$1") // <url> → url
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1**$2**") // *bold* → **bold**
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1*$2*"); // _italic_ → *italic*
}

/** Split on blank lines, then on single lines, then hard-cut, so every chunk fits Discord's limit. */
export function chunk(text: string, max = MAX_LEN): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trimEnd());
    cur = "";
  };
  for (const para of text.split(/\n{2,}/)) {
    const piece = para + "\n\n";
    if (cur.length + piece.length <= max) {
      cur += piece;
      continue;
    }
    push();
    if (piece.length <= max) {
      cur = piece;
      continue;
    }
    for (const line of para.split("\n")) {
      const l = line + "\n";
      if (cur.length + l.length > max) push();
      if (l.length > max) {
        for (let i = 0; i < l.length; i += max) out.push(l.slice(i, i + max));
      } else {
        cur += l;
      }
    }
    cur += "\n";
  }
  push();
  return out;
}

const MAX_ATTEMPTS = 5;
const SUPPRESS_EMBEDS = 1 << 2; // no link-preview cards: the digest has a dozen links per post

async function send(content: string, attempt = 1): Promise<void> {
  const url = new URL(WEBHOOK_URL!); // keeps an existing ?thread_id=… intact
  url.searchParams.set("wait", "true");
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS }),
    signal: AbortSignal.timeout(15_000),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
    const retry = Number((await res.json().catch(() => ({})))?.retry_after ?? attempt);
    await new Promise((r) => setTimeout(r, retry * 1000 + 100));
    return send(content, attempt + 1);
  }
  if (!res.ok) throw new Error(`Discord webhook ${res.status}: ${await res.text()}`);
}

/** Posts the digest. Falls back to stdout when no webhook is configured (fails if VEILLE_REQUIRE_DISCORD=true). */
export async function postDigestToDiscord(digest: string): Promise<void> {
  if (!WEBHOOK_URL) {
    if (REQUIRE) throw new Error("VEILLE_DISCORD_WEBHOOK_URL is not set but VEILLE_REQUIRE_DISCORD=true");
    console.log("[veille] no VEILLE_DISCORD_WEBHOOK_URL — printing digest to stdout\n");
    console.log(digest);
    return;
  }
  const parts = chunk(digest);
  for (let i = 0; i < parts.length; i++) {
    await send(parts[i]);
    if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 300)); // stay under the rate limit
  }
  console.log(`[veille] posted ${parts.length} message(s) to Discord`);
}
