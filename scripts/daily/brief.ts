// scripts/daily/brief.ts — the structured veille: what Claude returns, what the site reads, what Discord renders.
//
// One veille = one JSON document (site/veilles/YYYY-MM-DD.json). Claude never writes URLs: every raw item
// sent to it carries a short id (i12), Claude cites ids, and resolveBrief() maps them back to the real
// links — so a source link can be missing, but never invented.

export type Category = "paper" | "release" | "tool" | "discussion";
export interface Item {
  source: string;
  category: Category;
  title: string;
  url: string;
  summary?: string;
  score?: number;
  meta?: string;
  published?: string;
  discussionUrl?: string; // e.g. the HN thread when `url` is the article it links to
}

export interface SourceLink {
  title: string;
  url: string;
  source: string;
}
export interface News {
  cat?: string; // short French label (Sécurité, Modèles…); absent on veilles before 2026-10-22
  title: string;
  lead?: string; // one-sentence hook shown first; absent on older veilles (the site splits `text`)
  text: string; // with `lead`: the details that follow it; without: the whole news
  sources: SourceLink[];
  notions: string[];
}
export interface Brief {
  essentiel: News[];
  papiers: News[];
  sorties: News[]; // empty = "Rien de majeur sur la période."
}
export interface LinkRow {
  title: string;
  url: string;
  source: string;
  meta?: string;
}
export interface Veille {
  version: 1;
  date: string; // YYYY-MM-DD (UTC run date)
  generatedAt: string;
  lookbackHours: number;
  itemCount: number;
  model: string;
  brief: Brief | null; // null when Claude Code was unavailable or failed
  approfondir: { label: string; items: LinkRow[] }[];
}
export interface VeilleIndex {
  version: 1;
  veilles: {
    date: string;
    headline: string;
    counts: { essentiel: number; papiers: number; sorties: number };
    itemCount: number;
  }[];
}

export const SECTIONS: { key: keyof Brief; title: string }[] = [
  { key: "essentiel", title: "☕ L'essentiel" },
  { key: "papiers", title: "🔬 Papiers à connaître" },
  { key: "sorties", title: "🚀 Sorties qui comptent" },
];
export const NOTHING_MAJOR = "Rien de majeur sur la période.";

// ── What Claude answers (validated by `claude -p --json-schema`) ───────────────
interface RawNews {
  cat: string;
  title: string;
  lead: string;
  text: string;
  sources: string[];
  notions: string[];
}
export type RawBrief = Record<keyof Brief, RawNews[]>;

const rawNews = {
  type: "object",
  properties: {
    cat: { type: "string", description: "Catégorie en 1 ou 2 mots (Sécurité, Modèles, Infra, Recherche, Outils, Business, Régulation…)" },
    title: { type: "string", description: "Titre court reformulé en français (pas le titre traduit mot à mot)" },
    lead: { type: "string", description: "Accroche : une seule phrase, le fait principal" },
    text: { type: "string", description: "La suite : détails, contexte, ce que ça change. 1 à 2 phrases, sans répéter l'accroche." },
    sources: { type: "array", items: { type: "string" }, description: "Identifiants des items bruts cités (ex. i12), 1 à 3" },
    notions: { type: "array", items: { type: "string" }, description: "2 à 4 notions clés à creuser, termes courts" },
  },
  required: ["cat", "title", "lead", "text", "sources", "notions"],
  additionalProperties: false,
};
export const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    essentiel: { type: "array", items: rawNews },
    papiers: { type: "array", items: rawNews },
    sorties: { type: "array", items: rawNews },
  },
  required: ["essentiel", "papiers", "sorties"],
  additionalProperties: false,
};

/** Short ids for the prompt: non-arXiv items first (they carry meta + summary), arXiv titles last. */
export function assignIds(items: Item[]): { id: string; item: Item }[] {
  const ordered = [...items.filter((i) => i.source !== "arXiv"), ...items.filter((i) => i.source === "arXiv")];
  return ordered.map((item, n) => ({ id: `i${n + 1}`, item }));
}

/** A link's label must name where it leads: an aggregator item (HN) pointing at an article shows the article's site. */
export function linkLabel(it: Pick<Item, "source" | "url" | "discussionUrl">): string {
  if (!it.discussionUrl) return it.source;
  try {
    return new URL(it.url).hostname.replace(/^www\./, "");
  } catch {
    return it.source;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Raw Claude output → stored brief: ids become links, unknown ids are dropped, notions capped at 4. */
export function resolveBrief(raw: unknown, ids: Map<string, Item>): Brief | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<keyof Brief, unknown>>;
  const section = (v: unknown): News[] =>
    (Array.isArray(v) ? v : [])
      .map((n): News | null => {
        const o = (n ?? {}) as Partial<Record<keyof RawNews, unknown>>;
        const title = str(o.title);
        const lead = str(o.lead);
        const text = str(o.text);
        if (!title && !lead && !text) return null;
        const cat = str(o.cat).slice(0, 24);
        const seen = new Set<string>();
        const sources: SourceLink[] = [];
        const add = (link: SourceLink): void => {
          if (seen.has(link.url)) return;
          seen.add(link.url);
          sources.push(link);
        };
        for (const id of Array.isArray(o.sources) ? o.sources : []) {
          const it = ids.get(str(id).replace(/^\[|\]$/g, ""));
          if (!it) continue;
          add({ title: it.title, url: it.url, source: linkLabel(it) });
          if (it.discussionUrl) add({ title: it.title, url: it.discussionUrl, source: `${it.source} (discussion)` });
        }
        const notions = [...new Set((Array.isArray(o.notions) ? o.notions : []).map(str).filter(Boolean))].slice(0, 4);
        return {
          ...(cat ? { cat } : {}),
          title: title || lead || text,
          ...(lead ? { lead } : {}),
          text,
          sources,
          notions,
        };
      })
      .filter((n): n is News => n !== null);
  const brief: Brief = { essentiel: section(r.essentiel), papiers: section(r.papiers), sorties: section(r.sorties) };
  return brief.essentiel.length + brief.papiers.length + brief.sorties.length ? brief : null;
}

export function buildIndex(veilles: Veille[]): VeilleIndex {
  return {
    version: 1,
    veilles: veilles
      .map((v) => ({
        date: v.date,
        headline: v.brief?.essentiel[0]?.title ?? "Brief indisponible — liens seulement",
        counts: {
          essentiel: v.brief?.essentiel.length ?? 0,
          papiers: v.brief?.papiers.length ?? 0,
          sorties: v.brief?.sorties.length ?? 0,
        },
        itemCount: v.itemCount,
      }))
      .sort((a, b) => b.date.localeCompare(a.date)),
  };
}

// ── Discord rendering (same content as the site, minus the notions) ───────────
const mdLink = (label: string, url: string): string => `[${label.replace(/[[\]]/g, "")}](${url})`;

export function renderMarkdown(v: Veille, siteUrl?: string): string {
  let md = `# 🛰️ AI Bugle — ${v.date}\n\n_${v.itemCount} items, ${v.lookbackHours} dernières heures._`;
  if (siteUrl) md += ` ${mdLink("📖 Lire sur le site", `${siteUrl.replace(/\/?$/, "/")}#/${v.date}`)}`;
  md += "\n\n";
  if (v.brief) {
    for (const s of SECTIONS) {
      md += `## ${s.title}\n\n`;
      const rows = v.brief[s.key];
      if (!rows.length) {
        md += `${NOTHING_MAJOR}\n\n`;
        continue;
      }
      for (const n of rows) {
        const links = n.sources.map((l) => mdLink(l.source, l.url)).join(", ");
        const body = [n.lead, n.text].filter(Boolean).join(" ");
        md += `- **${n.title}** — ${body}${links ? ` (${links})` : ""}\n`;
      }
      md += "\n";
    }
    md += "---\n\n";
  } else {
    // Say it plainly instead of silently degrading to a link dump.
    md += "_Brief IA indisponible (Claude Code non configuré ou en erreur) — voir les liens ci-dessous._\n\n";
  }
  md += "## 📎 Pour approfondir\n\n";
  for (const g of v.approfondir) {
    if (!g.items.length) continue;
    md += `*${g.label}*\n`;
    for (const it of g.items) md += `- **${mdLink(it.title, it.url)}** — ${it.source}${it.meta ? ` · ${it.meta}` : ""}\n`;
    md += "\n";
  }
  return md;
}
