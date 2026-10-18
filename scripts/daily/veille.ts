/**
 * Monday/Thursday AI/tech "veille technique" digest → Discord.
 *
 * Pulls the latest research + model releases + tools + discussion from automation-friendly
 * sources (arXiv, Hugging Face Daily Papers/models, OpenRouter, Hacker News, GitHub, lab RSS),
 * dedupes + ranks them, optionally has Claude write an editor's brief, and posts the result to a
 * Discord channel. Runs on a GitHub Actions cron (`.github/workflows/ai-veille.yml`).
 *
 * Zero runtime deps (Bun native fetch). Nothing is required to produce a useful digest;
 * ANTHROPIC_API_KEY upgrades it from "ranked links" to "editor's brief", and
 * VEILLE_DISCORD_WEBHOOK_URL routes it to Discord (otherwise it prints to stdout).
 *
 *   bun scripts/daily/veille.ts
 */
import { postDigestToDiscord } from "./discord";

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

// ── Types ────────────────────────────────────────────────────────────────────
type Category = "paper" | "release" | "tool" | "discussion";
interface Item {
  source: string;
  category: Category;
  title: string;
  url: string;
  summary?: string;
  score?: number;
  meta?: string;
  published?: string;
}

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

// ── Optional Claude editor's brief ───────────────────────────────────────────
interface AnthropicResp {
  content?: { text?: string }[];
  stop_reason?: string;
}
async function llmBrief(items: Item[]): Promise<string | null> {
  // `.trim()` defends against a trailing newline in the secret (a classic `echo "$k" | gh secret set`
  // footgun) that would otherwise make the x-api-key header invalid.
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    log("LLM brief: ANTHROPIC_API_KEY is empty/unset in env — skipping");
    return null;
  }
  log(`LLM brief: key present (len=${key.length}), model=${MODEL} — calling Anthropic…`);
  // The full arXiv window is ~1 500–2 500 papers: send those as bare titles (≈25 tokens each) so the
  // model can still spot the important ones; everything else keeps its meta + summary.
  const arxivOnly = items.filter((i) => i.source === "arXiv");
  const arxivTitles = arxivOnly.map((i) => `- ${i.title}`).join("\n");
  const digest = items
    .filter((i) => i.source !== "arXiv")
    .map(
      (i) =>
        `- [${i.category}] ${i.source}: ${i.title}${i.meta ? ` (${i.meta})` : ""}${i.summary ? ` — ${clip(i.summary, 180)}` : ""}`,
    )
    .join("\n");
  const prompt = `Tu es l'éditeur d'une veille IA/tech publiée le lundi et le jeudi pour une équipe produit francophone.
Voici les items bruts des ${LOOKBACK_H} dernières heures (arXiv, HF Daily Papers, modèles tendance Hugging Face, OpenRouter, Hacker News, GitHub, blogs de labos).

Écris un brief substantiel mais synthétique EN FRANÇAIS, en Markdown. Objectif : je dois COMPRENDRE ce qui s'est passé sur toute la période sans cliquer sur un seul lien. Donne le SAVOIR — le résultat, la thèse, ce que ça change — pas une liste de titres.

1. "## ☕ L'essentiel" — 5 à 8 puces. Ce qui compte vraiment. Chaque puce énonce CE QU'ON APPREND (le résultat concret ou l'idée-clé), jamais juste le sujet ou le titre traduit.
2. "## 🔬 Papiers à connaître" — 3 à 6 au maximum. Une ligne chacun, sur le résultat concret ("montre que…", "propose…", "obtient X sur Y"). Ignore le tout-venant de l'arXiv.
3. "## 🚀 Sorties qui comptent" — UNIQUEMENT les vraies sorties majeures : un modèle phare dont les capacités sont DÉCRITES, ou un outil réellement utile. IGNORE le bruit : un simple identifiant de modèle "tendance" sur Hugging Face, un compteur de likes/téléchargements, un quantize GGUF, un dépôt GitHub récent sans changement décrit ne comptent PAS. S'il n'y a rien de majeur, écris exactement "Rien de majeur sur la période." — n'invente rien, ne remplis pas.

Règles : sceptique et concret, zéro hype, pas de traduction mot-à-mot des titres (reformule en français clair). Si deux items sont la même histoire, fusionne-les. Réponds intégralement en français.

ITEMS BRUTS :
${digest}

TOUS LES NOUVEAUX PAPIERS ARXIV DE LA PÉRIODE (${arxivOnly.length}, titres seuls — repère les rares qui comptent, ignore le reste) :
${arxivTitles}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      // Thinking off: Claude Sonnet 5.5 (the default model) runs adaptive thinking when `thinking` is
      // omitted, which can eat the max_tokens budget and return 200 with 0 chars of visible text.
      // `{type: "disabled"}` is a 400 on Sonnet 5.5; `between_tools` is its thinking-off mode
      // (valid at the default effort `high` or below). Other models (VEILLE_MODEL) may need
      // `{type: "disabled"}` instead — check the model's thinking rules before switching.
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: "between_tools" },
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!r.ok) {
      log(`LLM brief skipped -> HTTP ${r.status}: ${clip(await r.text(), 300)}`);
      return null;
    }
    const j = (await r.json()) as AnthropicResp;
    if (j.stop_reason === "refusal" || j.stop_reason === "max_tokens") log(`LLM brief: stop_reason=${j.stop_reason}`);
    const text = (j.content?.map((c) => c.text ?? "").join("") ?? "").trim();
    log(`LLM brief: HTTP 200, ${text.length} chars returned`);
    return text || null;
  } catch (e) {
    log(`LLM brief skipped -> ${(e as Error).message}`);
    return null;
  }
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderMarkdown(items: Item[], brief: string | null, dateStr: string): string {
  let md = `# 🛰️ Veille IA/Tech — ${dateStr}\n\n_${items.length} items, ${LOOKBACK_H} dernières heures._\n\n`;
  // The French brief is the body. If it is missing (ANTHROPIC_API_KEY absent/empty), say so plainly
  // instead of silently degrading to a link dump — the slim appendix below is the fallback content.
  md += brief
    ? `${brief}\n\n---\n\n`
    : "_Brief IA indisponible (ANTHROPIC_API_KEY absent) — voir les liens ci-dessous._\n\n";
  md += "## 📎 Pour approfondir\n\n";
  for (const a of APPENDIX) {
    const rows = section(items, a.cat).slice(0, a.cap);
    if (!rows.length) continue;
    md += `*${a.label}*\n`;
    for (const it of rows) md += `- **[${it.title}](${it.url})** — ${it.source}${it.meta ? ` · ${it.meta}` : ""}\n`;
    md += "\n";
  }
  return md;
}

// ── Main ─────────────────────────────────────────────────────────────────────
const dateStr = new Date().toISOString().slice(0, 10);
log(`collecting (last ${LOOKBACK_H}h)…`);
const items = await collect();
log(`collected ${items.length} unique items`);
const brief = await llmBrief(items);
log(brief ? `LLM brief: on (${brief.length} chars)` : "LLM brief: off (see reason above)");
const md = renderMarkdown(items, brief, dateStr);
await postDigestToDiscord(md); // throws on a failed post → non-zero exit, red run
