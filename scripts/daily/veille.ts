/**
 * Monday/Thursday AI/tech "veille technique" digest → Discord.
 *
 * Pulls the latest research + model releases + tools + discussion from automation-friendly
 * sources (arXiv, Hugging Face Daily Papers/models, OpenRouter, Hacker News, GitHub, lab RSS),
 * dedupes + ranks them, optionally has Claude write an editor's brief, and posts the result to a
 * Discord channel. Runs on a GitHub Actions cron (`.github/workflows/ai-veille.yml`).
 *
 * Zero runtime deps (Bun native fetch). Nothing is required to produce a useful digest; the
 * Claude Code CLI (logged in, or CLAUDE_CODE_OAUTH_TOKEN) upgrades it from "ranked links" to
 * "editor's brief" on the Claude subscription, and
 * VEILLE_DISCORD_WEBHOOK_URL routes it to Discord (otherwise it prints to stdout).
 *
 *   bun scripts/daily/veille.ts
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assignIds,
  BRIEF_SCHEMA,
  buildIndex,
  type Brief,
  type Category,
  type Item,
  renderMarkdown,
  resolveBrief,
  type Veille,
} from "./brief.ts";
import { postDigestToDiscord } from "./discord.ts";

// ── Config (env-driven) ──────────────────────────────────────────────────────
const UA = "prsnl-veille/1.0 (AI digest)";
const NOW = Date.now();
const HOURS_PER_DAY = 24;
const QUEUE_DELAY_BUFFER_HOURS = 6;
const UTC_WEEKDAY = { MONDAY: 1, THURSDAY: 4 } as const;
const SCHEDULE_GAP_DAYS_BY_UTC_WEEKDAY: Partial<Record<number, number>> = {
  [UTC_WEEKDAY.MONDAY]: 4,
  [UTC_WEEKDAY.THURSDAY]: 3,
};
const scheduledGapDays = SCHEDULE_GAP_DAYS_BY_UTC_WEEKDAY[new Date(NOW).getUTCDay()] ?? 4;
const DEFAULT_LOOKBACK_H = scheduledGapDays * HOURS_PER_DAY + QUEUE_DELAY_BUFFER_HOURS;
const LOOKBACK_H = Number(process.env.VEILLE_LOOKBACK_HOURS ?? DEFAULT_LOOKBACK_H);
const SINCE = NOW - LOOKBACK_H * 3_600_000;
const ARXIV_CATS = (process.env.VEILLE_ARXIV_CATS ?? "cs.AI,cs.LG,cs.CL,cs.CV,stat.ML").split(",");
// arXiv: the whole announcement window is fetched (≈700 papers per weekday across these cats), in
// pages, up to ARXIV_MAX. See arxivWindow() for why the window is not simply [SINCE, NOW].
const ARXIV_MAX = Number(process.env.VEILLE_ARXIV_MAX ?? 4000);
const ARXIV_PAGE = 1000;
const MODEL = process.env.VEILLE_MODEL ?? "claude-sonnet-5-5";
// Each run writes its veille as JSON for the site (site/veilles/YYYY-MM-DD.json + index.json).
const OUT_DIR = process.env.VEILLE_OUT_DIR ?? fileURLToPath(new URL("../../site/veilles/", import.meta.url));
const WRITE_JSON = (process.env.VEILLE_WRITE_JSON ?? "true").toLowerCase() !== "false";
const SITE_URL = process.env.VEILLE_SITE_URL; // optional "📖 Lire sur le site" link in the Discord post
const CAPS: Record<Category, number> = { paper: 8, release: 8, tool: 6, discussion: 6 };
const KEYWORDS = (
  process.env.VEILLE_KEYWORDS ??
  "AI,LLM,GPT,agent,model,transformer,diffusion,RAG,inference,fine-tun,open-source,open source,neural,machine learning,reasoning,multimodal,Claude,OpenAI,Anthropic,Gemini,Mistral,Llama,Qwen,DeepSeek,robot,GPU,CUDA"
)
  .split(",")
  .map((k) => k.trim().toLowerCase())
  .filter(Boolean);

// Verified-live lab/practitioner feeds (2026-08). Anthropic, Meta/FAIR, xAI and DeepSeek publish
// no usable RSS — their launches are caught via OpenRouter's model list + HF orgs + Hacker News.
const FEEDS: { name: string; url: string }[] = [
  { name: "OpenAI", url: "https://openai.com/news/rss.xml" },
  { name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml" },
  { name: "Google AI", url: "https://blog.google/innovation-and-ai/technology/ai/rss/" },
  { name: "Hugging Face", url: "https://huggingface.co/blog/feed.xml" },
  { name: "Mistral", url: "https://mistral.ai/rss.xml" },
  { name: "Qwen", url: "https://qwenlm.github.io/blog/index.xml" },
  { name: "Simon Willison", url: "https://simonwillison.net/atom/everything/" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
];

const log = (msg: string): void => {
  process.stderr.write(`[veille] ${msg}\n`);
};

// ── Small utils ──────────────────────────────────────────────────────────────
function decode(s: string): string {
  return (s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
const stripTags = (s: string): string => decode((s ?? "").replace(/<[^>]+>/g, " "));
const clip = (s: string | undefined, n: number): string =>
  !s ? "" : s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
const matchesKeywords = (text: string): boolean =>
  KEYWORDS.length === 0 || KEYWORDS.some((k) => text.toLowerCase().includes(k));

async function getText(url: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) {
      log(`skip ${url} -> HTTP ${r.status}`);
      return null;
    }
    return await r.text();
  } catch (e) {
    log(`skip ${url} -> ${(e as Error).message}`);
    return null;
  }
}
async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json", ...headers },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      log(`skip ${url} -> HTTP ${r.status}`);
      return null;
    }
    return (await r.json()) as T;
  } catch (e) {
    log(`skip ${url} -> ${(e as Error).message}`);
    return null;
  }
}

// Minimal RSS/Atom parser — good enough for the well-formed feeds above.
function parseFeed(xml: string): { title: string; link: string; date?: string; desc?: string }[] {
  const out: { title: string; link: string; date?: string; desc?: string }[] = [];
  for (const b of xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/g) ?? []) {
    const title = decode((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) ?? [])[1] ?? "");
    let link = decode((b.match(/<link[^>]*>([\s\S]*?)<\/link>/) ?? [])[1] ?? "");
    if (!link) link = (b.match(/<link[^>]*href=["']([^"']+)["']/) ?? [])[1] ?? "";
    const date = (b.match(/<(pubDate|published|updated)[^>]*>([\s\S]*?)<\/\1>/) ?? [])[2];
    const desc = stripTags((b.match(/<(description|summary|content)[^>]*>([\s\S]*?)<\/\1>/) ?? [])[2] ?? "");
    if (title && link) out.push({ title, link, date, desc });
  }
  return out;
}

// ── Source response shapes ───────────────────────────────────────────────────
interface HfPaper {
  paper?: { id?: string; title?: string; summary?: string; upvotes?: number; publishedAt?: string; authors?: { name?: string }[] };
  id?: string;
  title?: string;
  summary?: string;
  authors?: { name?: string }[];
  upvotes?: number;
  publishedAt?: string;
  url?: string;
  submittedOnDailyAt?: string;
}
interface HfModel {
  id: string;
  likes?: number;
  downloads?: number;
  pipeline_tag?: string;
  lastModified?: string;
}
interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  created?: number;
  context_length?: number;
}
interface HnHit {
  title?: string;
  url?: string;
  objectID: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
}
interface GhRepo {
  full_name: string;
  html_url: string;
  description?: string;
  stargazers_count?: number;
  language?: string;
  pushed_at?: string;
}
interface RedditChild {
  data?: { title?: string; permalink?: string; ups?: number; num_comments?: number; created_utc?: number };
}

// ── Sources (each returns Item[] and never throws) ───────────────────────────

// Hugging Face Daily Papers — curated + community-upvoted. The best "what matters today" signal.
async function fromHFDailyPapers(): Promise<Item[]> {
  const data = await getJson<HfPaper[]>("https://huggingface.co/api/daily_papers?limit=60");
  if (!Array.isArray(data)) return [];
  return data
    .map((it): Item => {
      const p = it.paper ?? it;
      const id = p.id ?? it.id;
      const up = p.upvotes ?? it.upvotes ?? 0;
      const authors = (p.authors ?? []).map((a) => a.name).filter(Boolean).slice(0, 4);
      return {
        source: "HF Daily Papers",
        category: "paper",
        title: decode(p.title ?? ""),
        url: id ? `https://huggingface.co/papers/${id}` : (it.url ?? ""),
        summary: clip(stripTags(p.summary ?? ""), 300),
        score: Number(up) || 0,
        published: p.publishedAt ?? it.submittedOnDailyAt,
        meta: `▲${up} · ${authors.join(", ")}${authors.length >= 4 ? " et al." : ""}`,
      };
    })
    .filter((i) => i.title && i.url);
}

// arXiv only exposes a paper once it is announced: submissions close 18:00 UTC Mon–Fri and are
// announced at the next 00:00 UTC Sun–Thu (Friday's batch on Monday). A plain [SINCE, NOW] window
// therefore misses the ~2 days still unannounced at run time, and the next run never looks back far
// enough to catch them. Instead, both window edges snap to the latest submission cutoff already
// announced: Monday's run covers Wed 18:00 → Fri 18:00, Thursday's Fri 18:00 → Wed 18:00 — each
// paper lands in exactly one digest. (arXiv holidays are not modelled; they only shift a batch.)
function latestAnnouncedCutoff(t: number): number {
  const day = new Date(t);
  day.setUTCHours(18, 0, 0, 0);
  for (let i = 0; i < 10; i++, day.setUTCDate(day.getUTCDate() - 1)) {
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue; // no submission cutoff on weekends
    const announcedAt = day.getTime() + (wd === 5 ? 54 : 6) * 3_600_000; // Fri → Mon 00:00, else next 00:00
    if (announcedAt <= t) return day.getTime();
  }
  return t - 7 * 24 * 3_600_000;
}
function arxivWindow(): { from: number; to: number } {
  return { from: latestAnnouncedCutoff(SINCE + QUEUE_DELAY_BUFFER_HOURS * 3_600_000), to: latestAnnouncedCutoff(NOW) };
}
const arxivStamp = (t: number): string => new Date(t).toISOString().slice(0, 16).replace(/[-T:]/g, "");

// arXiv — every submission in the watched categories over the announcement window (the firehose).
async function fromArxiv(): Promise<Item[]> {
  const { from, to } = arxivWindow();
  if (from >= to) return [];
  const cats = ARXIV_CATS.map((c) => `cat:${c.trim()}`).join(" OR ");
  const q = encodeURIComponent(`(${cats}) AND submittedDate:[${arxivStamp(from)} TO ${arxivStamp(to)}]`);
  log(`arXiv window ${new Date(from).toISOString()} → ${new Date(to).toISOString()}`);
  const items: Item[] = [];
  for (let start = 0; start < ARXIV_MAX; start += ARXIV_PAGE) {
    if (start > 0) await new Promise((r) => setTimeout(r, 3000)); // arXiv API terms: ≥3 s between calls
    const xml = await getText(
      `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&start=${start}&max_results=${ARXIV_PAGE}`,
      60_000,
    );
    if (!xml) break;
    const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/g) ?? [];
    for (const e of entries) {
      const title = decode((e.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? "");
      const abs = ((e.match(/<id>([\s\S]*?)<\/id>/) ?? [])[1] ?? "").trim();
      const published = ((e.match(/<published>([\s\S]*?)<\/published>/) ?? [])[1] ?? "").trim();
      const summary = stripTags((e.match(/<summary>([\s\S]*?)<\/summary>/) ?? [])[1] ?? "");
      const authors = (e.match(/<name>([\s\S]*?)<\/name>/g) ?? [])
        .map((m) => decode(m.replace(/<\/?name>/g, "")))
        .slice(0, 4);
      if (!title || !abs) continue;
      items.push({
        source: "arXiv",
        category: "paper",
        title,
        url: abs.replace("http://", "https://"),
        summary: clip(summary, 300),
        published,
        meta: authors.join(", ") + (authors.length >= 4 ? " et al." : ""),
      });
    }
    const total = Number((xml.match(/<opensearch:totalResults[^>]*>(\d+)</) ?? [])[1] ?? 0);
    if (entries.length < ARXIV_PAGE || start + ARXIV_PAGE >= total) break;
  }
  log(`arXiv: ${items.length} papers`);
  return items;
}

// Hugging Face trending models — proxy for "weights just dropped / notable release".
async function fromHFModels(): Promise<Item[]> {
  const data = await getJson<HfModel[]>("https://huggingface.co/api/models?sort=trendingScore&limit=20&full=false");
  if (!Array.isArray(data)) return [];
  return data.map((m): Item => ({
    source: "HF Models",
    category: "release",
    title: m.id,
    url: `https://huggingface.co/${m.id}`,
    score: Number(m.likes) || 0,
    meta: `♥${m.likes ?? 0} · ⬇${(m.downloads ?? 0).toLocaleString()} · ${m.pipeline_tag ?? ""}`.trim(),
    published: m.lastModified,
  }));
}

// OpenRouter — newly-LISTED hosted models. Catches Anthropic / OpenAI / Google / DeepSeek / xAI
// launches the day they go live, without scraping the labs that publish no RSS.
async function fromOpenRouter(): Promise<Item[]> {
  const data = await getJson<{ data: OpenRouterModel[] }>("https://openrouter.ai/api/v1/models");
  if (!Array.isArray(data?.data)) return [];
  return data.data
    .filter((m) => (Number(m.created) || 0) * 1000 >= SINCE)
    .map((m): Item => {
      const when = new Date((Number(m.created) || 0) * 1000);
      return {
        source: "OpenRouter",
        category: "release",
        title: `New model: ${m.name ?? m.id}`,
        url: `https://openrouter.ai/${m.id}`,
        summary: clip(stripTags(m.description ?? ""), 200),
        published: when.toISOString(),
        meta: `listed ${when.toISOString().slice(0, 10)} · ctx ${m.context_length ?? "?"}`,
      };
    });
}

// Hacker News (Algolia) — high-signal tech discussion in the lookback window.
async function fromHN(): Promise<Item[]> {
  const sinceSec = Math.floor(SINCE / 1000);
  const url = `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${sinceSec},points>60&hitsPerPage=60`;
  const data = await getJson<{ hits?: HnHit[] }>(url);
  if (!data?.hits) return [];
  return data.hits
    .filter((h) => h.title && matchesKeywords(`${h.title} ${h.url ?? ""}`))
    .map((h): Item => ({
      source: "Hacker News",
      category: "discussion",
      title: decode(h.title ?? ""),
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      score: h.points ?? 0,
      published: h.created_at,
      meta: `${h.points}pts · ${h.num_comments ?? 0} comments`,
    }));
}

// GitHub — recently-created, high-star AI repos ("new things to hack with").
async function fromGitHub(): Promise<Item[]> {
  const day = new Date(SINCE).toISOString().slice(0, 10);
  const topics = "topic:llm+OR+topic:ai-agents+OR+topic:llm-agent+OR+topic:generative-ai";
  const url = `https://api.github.com/search/repositories?q=(${topics})+created:>${day}+stars:>15&sort=stars&order=desc&per_page=20`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const data = await getJson<{ items?: GhRepo[] }>(url, headers);
  if (!data?.items) return [];
  return data.items.map((r): Item => ({
    source: "GitHub",
    category: "tool",
    title: r.full_name,
    url: r.html_url,
    summary: clip(decode(r.description ?? ""), 200),
    score: r.stargazers_count ?? 0,
    published: r.pushed_at,
    meta: `★${(r.stargazers_count ?? 0).toLocaleString()} · ${r.language ?? ""}`.trim(),
  }));
}

// Lab / practitioner blogs.
async function fromFeeds(): Promise<Item[]> {
  const groups = await Promise.all(
    FEEDS.map(async (f): Promise<Item[]> => {
      const xml = await getText(f.url);
      if (!xml) return [];
      return parseFeed(xml)
        .filter((e) => !e.date || Date.parse(e.date) >= SINCE)
        .map((e): Item => ({
          source: f.name,
          category: "release",
          title: e.title,
          url: e.link,
          summary: clip(e.desc, 220),
          published: e.date ? new Date(e.date).toISOString() : undefined,
          meta: f.name,
        }));
    }),
  );
  return groups.flat();
}

// Reddit — OAuth2 when REDDIT_CLIENT_ID/SECRET are set (required from CI datacenter IPs, which
// 403 the public *.json). Best-effort; never fatal.
async function fromReddit(): Promise<Item[]> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  let base = "https://www.reddit.com";
  let auth: Record<string, string> = { "user-agent": UA };
  if (id && secret) {
    try {
      const tok = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": UA,
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(15_000),
      });
      if (tok.ok) {
        const j = (await tok.json()) as { access_token?: string };
        auth = { authorization: `Bearer ${j.access_token}`, "user-agent": UA };
        base = "https://oauth.reddit.com";
      }
    } catch (e) {
      log(`reddit oauth -> ${(e as Error).message}`);
    }
  }
  const out: Item[] = [];
  for (const s of ["LocalLLaMA", "MachineLearning"]) {
    const data = await getJson<{ data?: { children?: RedditChild[] } }>(`${base}/r/${s}/top.json?t=week&limit=50`, auth);
    for (const c of data?.data?.children ?? []) {
      const p = c.data;
      if (!p?.title || (p.created_utc ?? 0) * 1000 < SINCE) continue;
      out.push({
        source: `r/${s}`,
        category: "discussion",
        title: decode(p.title),
        url: `https://reddit.com${p.permalink}`,
        score: p.ups ?? 0,
        meta: `▲${p.ups} · ${p.num_comments} comments`,
        published: new Date((p.created_utc ?? 0) * 1000).toISOString(),
      });
    }
  }
  return out;
}

// ── Collect → dedupe → rank ──────────────────────────────────────────────────
const normUrl = (u: string): string => u.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
// HF Daily Papers are keyed by arXiv id, so the same paper from both sources collapses into one item
// (the HF one wins: it carries the upvote score).
const dedupeKey = (u: string): string => {
  const id = u.match(/(?:arxiv\.org\/abs|huggingface\.co\/papers)\/(\d{4}\.\d{4,5})/i)?.[1];
  return id ? `arxiv:${id}` : normUrl(u);
};

async function collect(): Promise<Item[]> {
  const groups = await Promise.all([
    fromHFDailyPapers(),
    fromArxiv(),
    fromHFModels(),
    fromOpenRouter(),
    fromHN(),
    fromGitHub(),
    fromFeeds(),
    fromReddit(),
  ]);
  const byUrl = new Map<string, Item>();
  for (const it of groups.flat()) {
    const k = dedupeKey(it.url);
    const prev = byUrl.get(k);
    if (!prev || (it.score ?? 0) > (prev.score ?? 0)) byUrl.set(k, it);
  }
  return [...byUrl.values()];
}

function section(items: Item[], cat: Category): Item[] {
  return items
    .filter((i) => i.category === cat)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || Date.parse(b.published ?? "0") - Date.parse(a.published ?? "0"))
    .slice(0, CAPS[cat]);
}

// The brief (French, LLM-written) is the payload. Below it we render only a slim "Pour approfondir"
// list of the items genuinely worth a click — papers and discussions. Bare HF-trending model IDs
// (weights with no described changelog) and random GitHub repos are deliberately NOT listed: they
// are low-signal noise. They still reach the LLM as context so it can surface a genuine flagship
// release inside the brief's "Sorties qui comptent" section, but they never appear as a raw link.
const APPENDIX: { cat: Category; label: string; cap: number }[] = [
  { cat: "paper", label: "🔬 Papiers", cap: 8 },
  { cat: "discussion", label: "💬 Discussions", cap: 6 },
];

// ── Optional Claude editor's brief (via Claude Code on the user's subscription) ──
// The brief runs through the Claude Code CLI (`claude -p`), so it is counted against the Claude
// Pro/Max subscription instead of being billed through the API. In CI, auth is the long-lived
// CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`; locally, the logged-in `claude` session.
// ANTHROPIC_API_KEY is stripped from the child env: the CLI would otherwise prefer it and bill the API.
interface ClaudeResult {
  result?: string;
  structured_output?: unknown;
  is_error?: boolean;
  stop_reason?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}
function runClaude(prompt: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(
      "claude",
      [
        "-p",
        "--model", MODEL,
        "--tools", "", // pure text generation: no file, shell or web tools
        "--strict-mcp-config", // and no MCP servers
        "--no-session-persistence",
        "--output-format", "json",
        "--json-schema", JSON.stringify(BRIEF_SCHEMA), // validated JSON lands in `structured_output`
        "--system-prompt", "Tu es un éditeur de veille technique. Réponds uniquement avec le brief demandé, au format JSON imposé.",
      ],
      { env, cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(prompt); // ~60k tokens: stdin, not argv
  });
}
async function llmBrief(items: Item[]): Promise<Brief | null> {
  log(`LLM brief: model=${MODEL} — calling Claude Code (subscription)…`);
  // Every item gets a short id (i12) that Claude cites instead of writing URLs; resolveBrief() maps the
  // ids back to real links. The full arXiv window is ~1 500–2 500 papers: send those as bare titles
  // (≈25 tokens each) so the model can still spot the important ones; everything else keeps meta + summary.
  const withIds = assignIds(items);
  const ids = new Map(withIds.map(({ id, item }) => [id, item]));
  const arxivOnly = withIds.filter(({ item }) => item.source === "arXiv");
  const arxivTitles = arxivOnly.map(({ id, item }) => `- ${id} ${item.title}`).join("\n");
  const digest = withIds
    .filter(({ item }) => item.source !== "arXiv")
    .map(
      ({ id, item: i }) =>
        `- ${id} [${i.category}] ${i.source}: ${i.title}${i.meta ? ` (${i.meta})` : ""}${i.summary ? ` — ${clip(i.summary, 180)}` : ""}`,
    )
    .join("\n");
  const prompt = `Tu es l'éditeur d'une veille IA/tech publiée le lundi et le jeudi pour une équipe produit francophone.
Voici les items bruts des ${LOOKBACK_H} dernières heures (arXiv, HF Daily Papers, modèles tendance Hugging Face, OpenRouter, Hacker News, GitHub, blogs de labos). Chaque item commence par son identifiant (ex. i12).

Écris un brief substantiel mais synthétique EN FRANÇAIS, au format JSON imposé. Objectif : je dois COMPRENDRE ce qui s'est passé sur toute la période sans cliquer sur un seul lien. Donne le SAVOIR — le résultat, la thèse, ce que ça change — pas une liste de titres.

Chaque news a :
- "title" : un titre court en français clair (reformulé, jamais le titre traduit mot à mot) ;
- "text" : CE QU'ON APPREND, 1 à 3 phrases (le résultat concret ou l'idée-clé, pas juste le sujet) ;
- "sources" : 1 à 3 identifiants d'items bruts qui appuient la news (ex. ["i12", "i40"]) — uniquement des identifiants présents ci-dessous, n'invente jamais d'URL ;
- "notions" : 2 à 4 notions clés à creuser (termes courts, techniques, qu'on peut taper dans Google : "speculative decoding", "Mixture of Experts", "RLHF"…).

Sections :
1. "essentiel" — 5 à 8 news. Ce qui compte vraiment.
2. "papiers" — 3 à 6 au maximum, sur le résultat concret ("montre que…", "propose…", "obtient X sur Y"). Ignore le tout-venant de l'arXiv.
3. "sorties" — UNIQUEMENT les vraies sorties majeures : un modèle phare dont les capacités sont DÉCRITES, ou un outil réellement utile. IGNORE le bruit : un simple identifiant de modèle "tendance" sur Hugging Face, un compteur de likes/téléchargements, un quantize GGUF, un dépôt GitHub récent sans changement décrit ne comptent PAS. S'il n'y a rien de majeur, renvoie une liste vide — n'invente rien, ne remplis pas.

Règles : sceptique et concret, zéro hype. Si deux items sont la même histoire, fusionne-les en une news (avec leurs deux identifiants). Réponds intégralement en français.

ITEMS BRUTS :
${digest}

TOUS LES NOUVEAUX PAPIERS ARXIV DE LA PÉRIODE (${arxivOnly.length}, titres seuls — repère les rares qui comptent, ignore le reste) :
${arxivTitles}`;
  try {
    const { code, stdout, stderr } = await runClaude(prompt);
    let j: ClaudeResult = {};
    try {
      j = JSON.parse(stdout) as ClaudeResult;
    } catch {
      log(`LLM brief skipped -> claude exited ${code}: ${clip((stderr || stdout).trim(), 300)}`);
      return null;
    }
    if (j.is_error || code !== 0) {
      log(`LLM brief skipped -> claude exited ${code}: ${clip(j.result ?? stderr.trim(), 300)}`);
      return null;
    }
    // With --json-schema the answer arrives as a tool call, so stop_reason is "tool_use" on success.
    if (j.stop_reason && !["end_turn", "tool_use"].includes(j.stop_reason)) log(`LLM brief: stop_reason=${j.stop_reason}`);
    // Usage against the subscription; the $ figure is the API list-price equivalent, not a charge.
    const u = j.usage ?? {};
    const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    log(
      `LLM usage: ${input.toLocaleString("en-US")} input + ${(u.output_tokens ?? 0).toLocaleString("en-US")} output tokens` +
        ` (≈$${(j.total_cost_usd ?? 0).toFixed(3)} at API list price, not billed)`,
    );
    let raw = j.structured_output;
    if (raw === undefined) {
      try {
        raw = JSON.parse((j.result ?? "").replace(/^\s*```(?:json)?|```\s*$/g, ""));
      } catch {
        log(`LLM brief skipped -> no structured output: ${clip(j.result ?? "", 300)}`);
        return null;
      }
    }
    const brief = resolveBrief(raw, ids);
    if (!brief) log("LLM brief skipped -> structured output was empty");
    return brief;
  } catch (e) {
    log(`LLM brief skipped -> ${(e as Error).message}`); // e.g. ENOENT: Claude Code not installed
    return null;
  }
}

// ── Veille document + site files ─────────────────────────────────────────────
function buildVeille(items: Item[], brief: Brief | null, date: string): Veille {
  return {
    version: 1,
    date,
    generatedAt: new Date(NOW).toISOString(),
    lookbackHours: LOOKBACK_H,
    itemCount: items.length,
    model: MODEL,
    brief,
    approfondir: APPENDIX.map((a) => ({
      label: a.label,
      items: section(items, a.cat)
        .slice(0, a.cap)
        .map((it) => ({ title: it.title, url: it.url, source: it.source, meta: it.meta })),
    })).filter((g) => g.items.length),
  };
}

// Writes site/veilles/<date>.json (a same-day rerun replaces it) and rebuilds index.json from every veille.
function writeVeille(v: Veille): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${v.date}.json`), `${JSON.stringify(v, null, 2)}\n`);
  const all = readdirSync(OUT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(OUT_DIR, f), "utf8")) as Veille);
  writeFileSync(join(OUT_DIR, "index.json"), `${JSON.stringify(buildIndex(all), null, 2)}\n`);
  log(`wrote ${join(OUT_DIR, `${v.date}.json`)} (+ index.json, ${all.length} veille(s))`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const dateStr = new Date(NOW).toISOString().slice(0, 10);
log(`collecting (last ${LOOKBACK_H}h)…`);
const items = await collect();
log(`collected ${items.length} unique items`);
const brief = await llmBrief(items);
log(brief ? `LLM brief: on (${brief.essentiel.length + brief.papiers.length + brief.sorties.length} news)` : "LLM brief: off (see reason above)");
const veille = buildVeille(items, brief, dateStr);
if (WRITE_JSON) writeVeille(veille); // before Discord: a failed post must not lose the veille
await postDigestToDiscord(renderMarkdown(veille, SITE_URL)); // throws on a failed post → non-zero exit, red run
