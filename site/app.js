// AI Bugle — static reader. Data: veilles/index.json + veilles/YYYY-MM-DD.json (written by scripts/daily/veille.ts).
// Routes: #/ (list) and #/YYYY-MM-DD (one veille). Read/unread is kept in this browser only (localStorage).
"use strict";

const app = document.getElementById("app");
const selBtn = document.getElementById("sel-search");

const SECTIONS = [
  { key: "essentiel", title: "☕ L'essentiel", nav: "L'essentiel" },
  { key: "papiers", title: "🔬 Papiers à connaître", nav: "Papiers" },
  { key: "sorties", title: "🚀 Sorties qui comptent", nav: "Sorties" },
];

const google = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c);
  return el;
}
const ext = (href, cls, label, text) => h("a", { class: cls, href, target: "_blank", rel: "noopener", "aria-label": label }, text);

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("fr-FR", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

// ── Read / unread (local only) ───────────────────────────────────────────────
const READ_KEY = "veille-ia:read"; // pre-rename key, kept so read state survives
function readSet() {
  try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || "[]")); } catch { return new Set(); }
}
function markRead(date) {
  try {
    const s = readSet();
    s.add(date);
    localStorage.setItem(READ_KEY, JSON.stringify([...s]));
  } catch { /* storage disabled: reading still works */ }
}

async function getJson(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

function render(...nodes) {
  app.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
  hideSel(true);
}
function failure(msg) {
  render(h("p", { class: "notice" }, msg, " ", h("a", { href: "#/" }, "Retour à la liste")));
}

// ── Home ─────────────────────────────────────────────────────────────────────
async function showHome() {
  document.title = "AI Bugle";
  let index;
  try {
    index = await getJson("veilles/index.json");
  } catch {
    return failure("Impossible de charger la liste des veilles (hors ligne ?).");
  }
  const read = readSet();
  const rows = (index.veilles || []).map((v) => {
    const isRead = read.has(v.date);
    const c = v.counts || {};
    return h("li", null,
      h("a", { class: `entry${isRead ? " read" : ""}`, href: `#/${v.date}` },
        h("div", { class: "when" }, formatDate(v.date), !isRead && h("span", { class: "badge" }, "Nouveau")),
        h("div", { class: "headline" }, v.headline),
        h("div", { class: "counts" },
          [plural(c.essentiel || 0, "essentiel", "essentiels"), plural(c.papiers || 0, "papier", "papiers"), plural(c.sorties || 0, "sortie", "sorties")].join(" · ")),
      ));
  });
  render(
    h("h1", null, "Les veilles"),
    h("p", { class: "sub" }, "IA & tech, chaque lundi et jeudi. Sélectionnez un passage pour le chercher sur Google."),
    rows.length
      ? h("ul", { class: "list" }, rows)
      : h("p", { class: "empty muted" }, "Aucune veille pour l'instant — la prochaine arrive lundi ou jeudi matin."),
  );
}

// ── One veille ───────────────────────────────────────────────────────────────
function newsCard(n) {
  const sources = (n.sources || []).filter((s) => safeUrl(s.url));
  const query = sources[0]?.title || n.title;
  return h("article", { class: "news" },
    h("h3", null, n.title),
    n.text && h("p", null, n.text),
    h("div", { class: "row" },
      ext(google(query), "google", `Rechercher sur Google : ${query}`, "🔎 Google"),
      sources.map((s) => ext(s.url, "src", `Source : ${s.title} (${s.source})`, h("span", null, `↗ ${s.source}`))),
    ),
    (n.notions || []).length > 0 && h("div", { class: "row" },
      n.notions.map((t) => ext(google(t), "pill", `Rechercher « ${t} » sur Google`, t))),
  );
}

async function showVeille(date) {
  let v;
  try {
    v = await getJson(`veilles/${date}.json`);
  } catch {
    return failure(`Veille du ${date} introuvable.`);
  }
  markRead(date);
  document.title = `AI Bugle — ${formatDate(date)}`;
  const brief = v.brief;
  const nav = [...(brief ? SECTIONS : []), { key: "approfondir", nav: "Approfondir" }];
  const sections = brief
    ? SECTIONS.map((s) => h("section", { id: s.key },
        h("h2", null, s.title),
        brief[s.key].length ? brief[s.key].map(newsCard) : h("p", { class: "nothing" }, "Rien de majeur sur la période.")))
    : [h("p", { class: "notice" }, "Brief IA indisponible pour cette veille — voir les liens ci-dessous.")];
  render(
    h("a", { class: "back", href: "#/" }, "← Toutes les veilles"),
    h("h1", null, formatDate(date)),
    h("p", { class: "sub" }, `${v.itemCount} items analysés sur ${v.lookbackHours} h.`),
    h("nav", { class: "toc", "aria-label": "Sections" },
      nav.map((s) => h("button", { type: "button", onclick: () => document.getElementById(s.key)?.scrollIntoView({ behavior: "smooth" }) }, s.nav))),
    sections,
    h("section", { id: "approfondir" },
      h("h2", null, "📎 Pour approfondir"),
      (v.approfondir || []).map((g) => [
        h("h4", null, g.label),
        h("ul", { class: "links" }, g.items.filter((it) => safeUrl(it.url)).map((it) =>
          h("li", null, ext(it.url, null, null, it.title), h("div", { class: "meta" }, [it.source, it.meta].filter(Boolean).join(" · "))))),
      ])),
    h("p", { class: "foot" }, `Généré le ${new Date(v.generatedAt).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" })} · ${v.model}`),
  );
  window.scrollTo(0, 0);
}

// ── Router ───────────────────────────────────────────────────────────────────
function route() {
  const m = location.hash.match(/^#\/(\d{4}-\d{2}-\d{2})$/);
  if (m) showVeille(m[1]);
  else showHome();
}
window.addEventListener("hashchange", route);
route();

// ── Selection → floating "Rechercher sur Google" ─────────────────────────────
// Works with mouse and touch: it follows `selectionchange`, sits below the selection (above when there
// is no room) and lingers briefly after the selection collapses, because on touch screens tapping the
// button can clear the selection before the tap lands.
const coarse = window.matchMedia("(pointer: coarse)").matches;
let hideTimer = 0;
let frame = 0;

function hideSel(now) {
  clearTimeout(hideTimer);
  if (now) selBtn.hidden = true;
  else hideTimer = setTimeout(() => { selBtn.hidden = true; }, coarse ? 600 : 150);
}

function placeSel() {
  frame = 0;
  const sel = window.getSelection();
  const text = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, " ").trim() : "";
  if (text.length < 2 || !sel.rangeCount || selBtn.contains(sel.anchorNode)) return hideSel(false);
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  if (!r.width && !r.height) return hideSel(false);
  clearTimeout(hideTimer);
  const q = text.slice(0, 200);
  selBtn.href = google(q);
  selBtn.setAttribute("aria-label", `Rechercher sur Google : ${q}`);
  selBtn.hidden = false;
  const bw = selBtn.offsetWidth;
  const bh = selBtn.offsetHeight;
  const gap = coarse ? 30 : 10; // clear the touch selection handles
  let top = r.bottom + gap;
  if (top + bh > window.innerHeight - 8) top = Math.max(8, r.top - bh - gap);
  const left = Math.min(Math.max(8, r.left + r.width / 2 - bw / 2), window.innerWidth - bw - 8);
  selBtn.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}
const schedule = () => { if (!frame) frame = requestAnimationFrame(placeSel); };

document.addEventListener("selectionchange", schedule);
window.addEventListener("scroll", () => { if (!selBtn.hidden) schedule(); }, { passive: true });
window.addEventListener("resize", () => { if (!selBtn.hidden) schedule(); });
selBtn.addEventListener("pointerdown", () => clearTimeout(hideTimer));
selBtn.addEventListener("click", () => setTimeout(() => hideSel(true), 300));

// ── Offline / installable ────────────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
