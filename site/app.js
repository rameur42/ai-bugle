// AI Bugle — static reader. Data: veilles/index.json + veilles/YYYY-MM-DD.json (written by scripts/daily/veille.ts).
// Routes: #/ (latest veille), #/YYYY-MM-DD (one veille), #/archives (all veilles). Read/unread and the
// theme choice are kept in this browser only (localStorage).
"use strict";

const app = document.getElementById("app");
const nav = document.getElementById("nav");
const gen = document.getElementById("gen");
const selBtn = document.getElementById("sel-search");

const SECTIONS = [
  { key: "essentiel", nav: "Essentiel" },
  { key: "papiers", nav: "Papiers" },
  { key: "sorties", nav: "Sorties" },
  { key: "approfondir", nav: "Approfondir" },
];
const NOTHING_MAJOR = "Rien de majeur sur la période.";

const google = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);
const pad = (n) => String(n).padStart(2, "0");

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c);
  return el;
}
const ext = (href, cls, label, ...text) => h("a", { class: cls, href, target: "_blank", rel: "noopener", "aria-label": label }, ...text);

// Stroke icons (24×24 paths), built in the SVG namespace.
const ICONS = {
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-3.5-3.5"],
  share: ["M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7", "M16 6l-4-4-4 4", "M12 2v13"],
};
function icon(name) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const d of ICONS[name]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

const utcDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const weekday = (iso) => utcDate(iso).toLocaleDateString("fr-FR", { weekday: "long", timeZone: "UTC" });
const dayMonth = (iso) => cap(utcDate(iso).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }));
const longDate = (iso) => cap(utcDate(iso).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }));
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

// Veilles before 2026-10-22 have no `lead`: the first sentence of `text` plays that role.
function splitNews(n) {
  if (n.lead) return { lead: n.lead, rest: n.text || "" };
  const m = (n.text || "").match(/^(.+?[.!?»])\s+(?=[A-ZÀ-ÖØ-Þ«"])/s);
  return m ? { lead: m[1], rest: n.text.slice(m[0].length) } : { lead: n.text || "", rest: "" };
}

// ── Local state: read/unread, theme ──────────────────────────────────────────
const READ_KEY = "veille-ia:read"; // pre-rename key, kept so read state survives
const THEME_KEY = "ai-bugle:theme";
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

const themeBtn = document.getElementById("theme");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme || (systemDark.matches ? "dark" : "light")) === "dark";
// The installed app's Android status and navigation bars take the page's theme-color: keep a single
// tag, without `media`, that follows the theme actually shown (system or forced with the button).
const themeMeta = document.querySelector('meta[name="theme-color"]');
document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m !== themeMeta && m.remove());
themeMeta.removeAttribute("media");
function syncThemeButton() {
  themeBtn.setAttribute("aria-label", isDark() ? "Passer en mode clair" : "Passer en mode sombre");
  themeMeta.setAttribute("content", isDark() ? "#0b0d10" : "#ffffff");
}
themeBtn.addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  // Back to the system's own choice when it matches, so the site keeps following it.
  const follow = next === (systemDark.matches ? "dark" : "light");
  try {
    if (follow) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch { /* not remembered, still applied */ }
  if (follow) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  syncThemeButton();
});
systemDark.addEventListener("change", syncThemeButton);
syncThemeButton();

// ── Data ─────────────────────────────────────────────────────────────────────
async function getJson(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
let indexPromise = null;
const getIndex = () => (indexPromise ??= getJson("veilles/index.json").catch((e) => { indexPromise = null; throw e; }));

let spy = null;
function render(navItems, ...nodes) {
  spy?.disconnect();
  spy = null;
  nav.replaceChildren(...navItems.flat(Infinity));
  app.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
  gen.textContent = "";
  hideSel(true);
}
const archivesLink = (on) => h("a", { href: "#/archives", class: on ? "on" : null, "aria-current": on ? "page" : null }, "Archives");
function failure(msg) {
  render([archivesLink(false)], h("div", { class: "wrap" }, h("p", { class: "notice" }, msg, " ", h("a", { href: "#/archives" }, "Voir toutes les veilles →"))));
}

// ── Archives ─────────────────────────────────────────────────────────────────
async function showArchives() {
  document.title = "AI Bugle — Archives";
  let index;
  try {
    index = await getIndex();
  } catch {
    return failure("Impossible de charger la liste des veilles (hors ligne ?).");
  }
  const read = readSet();
  const rows = (index.veilles || []).map((v) => {
    const isRead = read.has(v.date);
    const c = v.counts || {};
    return h("li", null,
      h("a", { class: `entry${isRead ? " read" : ""}`, href: `#/${v.date}` },
        h("span", { class: "when" }, h("span", { class: "kicker" }, longDate(v.date)), !isRead && h("span", { class: "badge" }, "Nouveau")),
        h("b", null, v.headline),
        h("span", { class: "counts" },
          [plural(c.essentiel || 0, "sujet", "sujets"), plural(c.papiers || 0, "papier", "papiers"), plural(c.sorties || 0, "sortie", "sorties")].join(" · ")),
      ));
  });
  render(
    [h("a", { href: "#/" }, "Dernière veille"), archivesLink(true)],
    h("div", { class: "wrap archives" },
      h("section", { class: "hero" },
        h("span", { class: "kicker" }, "Archives"),
        h("h1", null, "Toutes les veilles"),
        h("p", { class: "stats" }, "IA & tech, chaque lundi et jeudi. Sélectionnez un passage pour le chercher sur Google.")),
      rows.length
        ? h("ul", { class: "list" }, rows)
        : h("p", { class: "nothing" }, "Aucune veille pour l'instant — la prochaine arrive lundi ou jeudi matin.")),
  );
  window.scrollTo(0, 0);
}

// ── One veille ───────────────────────────────────────────────────────────────
function sourceChips(n) {
  const sources = (n.sources || []).filter((s) => safeUrl(s.url));
  const query = sources[0]?.title || n.title;
  return h("div", { class: "chips" },
    sources.map((s) => ext(s.url, "chip", `Source : ${s.title} (${s.source})`, `${s.source} ↗`)),
    ext(google(query), "chip search", `Rechercher sur Google : ${query}`, icon("search"), "Google"));
}
function notionPills(n) {
  const notions = n.notions || [];
  return notions.length > 0 && h("div", { class: "pills" },
    h("span", { class: "label" }, "À creuser"),
    notions.map((t) => ext(google(t), "pill", `Rechercher « ${t} » sur Google`, t)));
}

async function share(title, url, btn) {
  try {
    if (navigator.share) return await navigator.share({ title, url });
    await navigator.clipboard.writeText(url);
    const label = btn.lastChild;
    label.textContent = "Lien copié";
    setTimeout(() => { label.textContent = "Partager"; }, 1800);
  } catch { /* share sheet dismissed */ }
}

function essentielNews(n, i, pageUrl) {
  const num = pad(i + 1);
  const { lead, rest } = splitNews(n);
  const moreId = `more-${num}`;
  const more = h("div", { class: "more", id: moreId, hidden: i !== 0 },
    rest && h("p", { class: "prose" }, rest),
    sourceChips(n),
    notionPills(n));
  const toggle = h("button", { type: "button", class: "act primary", "aria-expanded": String(i === 0), "aria-controls": moreId }, i === 0 ? "Réduire ↑" : "Lire plus ↓");
  toggle.addEventListener("click", () => {
    const open = more.hidden;
    more.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Réduire ↑" : "Lire plus ↓";
  });
  const shareBtn = h("button", { type: "button", class: "act" }, icon("share"), h("span", null, "Partager"));
  shareBtn.addEventListener("click", () => share(`${n.title} — AI Bugle`, pageUrl, shareBtn));
  return h("article", { class: "news", id: `n-${num}` },
    h("div", { class: "meta" }, h("span", { class: "n" }, num), n.cat && h("span", { class: "cat" }, n.cat)),
    h("h2", null, n.title),
    lead && h("p", { class: "prose" }, lead),
    more,
    h("div", { class: "actions" }, toggle, shareBtn));
}

function paperNews(n) {
  return h("article", { class: "paper" },
    h("h3", null, n.title),
    h("p", { class: "prose" }, [n.lead, n.text].filter(Boolean).join(" ")),
    sourceChips(n),
    notionPills(n));
}

function releaseNews(n) {
  return h("article", { class: "release" },
    h("div", { class: "head" }, n.cat && h("span", { class: "kicker" }, n.cat), h("h3", null, n.title)),
    h("div", { class: "body" },
      h("p", { class: "prose" }, [n.lead, n.text].filter(Boolean).join(" ")),
      sourceChips(n),
      notionPills(n)));
}

// "▲99 · Authors" (HF papers) or "2322pts · 886 comments" (HN) → a score column and the rest.
function linkRow(it) {
  const parts = (it.meta || "").split(" · ");
  let score = "";
  if (/^▲\d+$/.test(parts[0])) score = parts.shift();
  else if (/^\d+\s*pts?$/.test(parts[0])) score = parts.shift().replace(/\s*pts?$/, "");
  const rest = parts.map((p) => p.replace(/^(\d+) comments?$/, (_, c) => plural(Number(c), "commentaire", "commentaires")));
  return h("a", { class: "row", href: it.url, target: "_blank", rel: "noopener" },
    h("span", { class: "score" }, score),
    h("span", { class: "t" }, h("b", null, it.title), h("span", null, [it.source, ...rest].filter(Boolean).join(" · "))));
}

const words = (s) => (s || "").split(/\s+/).filter(Boolean).length;

async function showVeille(date) {
  let v;
  try {
    v = await getJson(`veilles/${date}.json`);
  } catch {
    return failure(`Veille du ${date} introuvable.`);
  }
  markRead(date);
  document.title = `AI Bugle — ${longDate(date)}`;
  const pageUrl = `${location.origin}${location.pathname}#/${date}`;
  const b = v.brief;
  const all = b ? [...b.essentiel, ...b.papiers, ...b.sorties] : [];
  const minutes = Math.max(1, Math.round(all.reduce((t, n) => t + words(n.title) + words(n.lead) + words(n.text), 0) / 200));
  const stats = [`${v.itemCount} items analysés sur ${v.lookbackHours} h`, b && plural(b.essentiel.length, "sujet", "sujets"), b && `lecture ≈ ${minutes} min`];

  const navButtons = SECTIONS.filter((s) => b || s.key === "approfondir").map((s) =>
    h("button", { type: "button", "data-sec": s.key, onclick: () => document.getElementById(s.key)?.scrollIntoView({ behavior: "smooth" }) }, s.nav));

  const empty = h("p", { class: "nothing" }, NOTHING_MAJOR);
  const groups = (v.approfondir || []).filter((g) => g.items?.length);
  render(
    [navButtons, archivesLink(false)],
    h("div", { class: "wrap page" },
      b && b.essentiel.length > 0 && h("aside", { class: "side", "aria-label": "Dans cette édition" },
        h("span", { class: "kicker" }, "Dans cette édition"),
        b.essentiel.map((n, i) => h("a", { href: `#n-${pad(i + 1)}`, onclick: (e) => { e.preventDefault(); document.getElementById(`n-${pad(i + 1)}`)?.scrollIntoView({ behavior: "smooth" }); } },
          h("span", { class: "num" }, pad(i + 1)), h("span", null, n.title)))),
      h("main", { class: "main" },
        h("section", { class: "hero" },
          h("span", { class: "kicker" }, `Veille du ${weekday(date)} · ${date.slice(0, 4)}`),
          h("h1", null, dayMonth(date)),
          h("p", { class: "stats" }, stats.filter(Boolean).join(" · "))),
        b
          ? [
              h("div", { id: "essentiel", class: "essentiel" }, b.essentiel.length ? b.essentiel.map((n, i) => essentielNews(n, i, pageUrl)) : empty.cloneNode(true)),
              h("section", { id: "papiers", class: "sec" }, h("h2", null, "Papiers à connaître"), b.papiers.length ? b.papiers.map(paperNews) : empty.cloneNode(true)),
              h("section", { id: "sorties", class: "sec" }, h("h2", null, "Sorties qui comptent"), b.sorties.length ? b.sorties.map(releaseNews) : empty.cloneNode(true)),
            ]
          : h("p", { class: "notice" }, "Brief IA indisponible pour cette veille — voir les liens ci-dessous."),
        h("section", { id: "approfondir", class: "sec" },
          h("h2", null, "Pour approfondir"),
          groups.length
            ? groups.map((g) => [
                h("h3", { class: "group" }, g.label.replace(/^[^\p{L}\p{N}]+/u, "")),
                g.items.filter((it) => safeUrl(it.url)).map(linkRow),
              ])
            : empty.cloneNode(true)))),
  );
  gen.textContent = `Généré le ${new Date(v.generatedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }).replace(" ", " à ")} · ${v.model}`;
  window.scrollTo(0, 0);

  // Bold the nav entry of the section being read.
  if ("IntersectionObserver" in window) {
    const mark = (key) => navButtons.forEach((btn) => btn.classList.toggle("on", btn.dataset.sec === key));
    mark(navButtons[0]?.dataset.sec);
    spy = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) mark(e.target.id);
    }, { rootMargin: "-30% 0px -60% 0px" });
    for (const s of SECTIONS) {
      const el = document.getElementById(s.key);
      if (el) spy.observe(el);
    }
  }
}

async function showLatest() {
  try {
    const index = await getIndex();
    const latest = index.veilles?.[0]?.date;
    if (latest) return showVeille(latest);
  } catch {
    return failure("Impossible de charger la dernière veille (hors ligne ?).");
  }
  render([archivesLink(false)], h("div", { class: "wrap" }, h("p", { class: "nothing" }, "Aucune veille pour l'instant — la prochaine arrive lundi ou jeudi matin.")));
}

// ── Router ───────────────────────────────────────────────────────────────────
function route() {
  const hash = location.hash;
  const m = hash.match(/^#\/(\d{4}-\d{2}-\d{2})$/);
  if (m) showVeille(m[1]);
  else if (hash === "#/archives") showArchives();
  else if (!hash || hash === "#/" || hash === "#") showLatest();
  // Other hashes (#n-03…) are in-page anchors: leave the current view alone.
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
  // Stay clear of the phone's bottom menu bar.
  const bottom = getComputedStyle(nav).position === "fixed" ? nav.getBoundingClientRect().top : window.innerHeight;
  let top = r.bottom + gap;
  if (top + bh > bottom - 8) top = Math.max(8, r.top - bh - gap);
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
