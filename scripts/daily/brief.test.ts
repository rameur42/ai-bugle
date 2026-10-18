// node --test scripts/daily/  (or: bun test scripts/daily/)
import assert from "node:assert/strict";
import { test } from "node:test";
import { assignIds, buildIndex, type Item, renderMarkdown, resolveBrief, type Veille } from "./brief.ts";
import { chunk } from "./discord.ts";

const items: Item[] = [
  { source: "arXiv", category: "paper", title: "Paper A", url: "https://arxiv.org/abs/2610.00001" },
  { source: "Hacker News", category: "discussion", title: "HN story", url: "https://example.com/hn" },
  { source: "OpenAI", category: "release", title: "Model X", url: "https://openai.com/x" },
];

test("assignIds puts non-arXiv items first", () => {
  const ids = assignIds(items);
  assert.deepEqual(
    ids.map((x) => [x.id, x.item.source]),
    [["i1", "Hacker News"], ["i2", "OpenAI"], ["i3", "arXiv"]],
  );
});

test("resolveBrief maps ids to links, drops unknown ids and duplicates, caps notions", () => {
  const ids = new Map(assignIds(items).map(({ id, item }) => [id, item]));
  const brief = resolveBrief(
    {
      essentiel: [
        { title: " Titre ", text: "Texte", sources: ["i2", "i99", "[i2]", "i3"], notions: ["a", "b", "a", "c", "d", "e"] },
        { title: "", text: "", sources: [], notions: [] },
      ],
      papiers: [{ title: "P", text: "T", sources: ["i3"], notions: ["x", "y"] }],
      sorties: [],
    },
    ids,
  );
  assert.ok(brief);
  assert.equal(brief.essentiel.length, 1);
  assert.equal(brief.essentiel[0].title, "Titre");
  assert.deepEqual(
    brief.essentiel[0].sources.map((s) => s.url),
    ["https://openai.com/x", "https://arxiv.org/abs/2610.00001"],
  );
  assert.deepEqual(brief.essentiel[0].notions, ["a", "b", "c", "d"]);
  assert.deepEqual(brief.sorties, []);
});

test("an HN item links the article under its own site name, plus the HN thread", () => {
  const hn: Item = {
    source: "Hacker News",
    category: "discussion",
    title: "Story",
    url: "https://www.example.org/post",
    discussionUrl: "https://news.ycombinator.com/item?id=42",
  };
  const brief = resolveBrief({ essentiel: [{ title: "T", text: "x", sources: ["i1"], notions: [] }], papiers: [], sorties: [] }, new Map([["i1", hn]]));
  assert.deepEqual(
    brief?.essentiel[0].sources.map((s) => [s.source, s.url]),
    [["example.org", "https://www.example.org/post"], ["Hacker News (discussion)", "https://news.ycombinator.com/item?id=42"]],
  );
});

test("resolveBrief rejects garbage and empty briefs", () => {
  assert.equal(resolveBrief(null, new Map()), null);
  assert.equal(resolveBrief("nope", new Map()), null);
  assert.equal(resolveBrief({ essentiel: [], papiers: [], sorties: [] }, new Map()), null);
});

const veille = (date: string, withBrief = true): Veille => ({
  version: 1,
  date,
  generatedAt: `${date}T06:20:00.000Z`,
  lookbackHours: 102,
  itemCount: 42,
  model: "claude-sonnet-5-5",
  brief: withBrief
    ? {
        essentiel: [
          { title: "Une news", text: "Ce qu'on apprend.", notions: ["RLHF"], sources: [{ title: "HN story", url: "https://example.com/hn", source: "Hacker News" }] },
        ],
        papiers: [],
        sorties: [],
      }
    : null,
  approfondir: [{ label: "🔬 Papiers", items: [{ title: "Paper [A]", url: "https://arxiv.org/abs/2610.00001", source: "arXiv", meta: "X et al." }] }],
});

test("buildIndex sorts newest first and summarises", () => {
  const idx = buildIndex([veille("2026-10-16"), veille("2026-10-20", false)]);
  assert.deepEqual(idx.veilles.map((v) => v.date), ["2026-10-20", "2026-10-16"]);
  assert.equal(idx.veilles[1].headline, "Une news");
  assert.deepEqual(idx.veilles[1].counts, { essentiel: 1, papiers: 0, sorties: 0 });
  assert.match(idx.veilles[0].headline, /indisponible/);
});

test("renderMarkdown keeps the sections, links and the empty-section line", () => {
  const md = renderMarkdown(veille("2026-10-20"), "https://rameur42.github.io/ai-bugle");
  assert.match(md, /\[📖 Lire sur le site\]\(https:\/\/rameur42\.github\.io\/ai-bugle\/#\/2026-10-20\)/);
  assert.match(md, /## ☕ L'essentiel\n\n- \*\*Une news\*\* — Ce qu'on apprend\. \(\[Hacker News\]\(https:\/\/example\.com\/hn\)\)/);
  assert.match(md, /## 🚀 Sorties qui comptent\n\nRien de majeur sur la période\./);
  assert.match(md, /\*\*\[Paper A\]\(https:\/\/arxiv\.org\/abs\/2610\.00001\)\*\* — arXiv · X et al\./);
  assert.doesNotMatch(md, /RLHF/); // notions are site-only
});

test("renderMarkdown without a brief says so", () => {
  const md = renderMarkdown(veille("2026-10-20", false));
  assert.match(md, /Brief IA indisponible/);
  assert.doesNotMatch(md, /Lire sur le site/);
});

test("a long veille still chunks under Discord's 2000-char limit", () => {
  const v = veille("2026-10-20");
  v.brief!.essentiel = Array.from({ length: 8 }, (_, n) => ({
    title: `News ${n}`,
    text: "x".repeat(400),
    notions: [],
    sources: [{ title: "t", url: `https://example.com/${n}`, source: "HN" }],
  }));
  const parts = chunk(renderMarkdown(v));
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 2000);
});
