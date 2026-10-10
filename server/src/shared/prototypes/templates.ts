// Importing modules
import type { PrototypeContent } from "../../agents/prototype.agent.js";
import { PROJECT_TYPES } from "../../agents/requirements.agent.js";

export type TemplateId = (typeof PROJECT_TYPES)[number];

// every generated string passes through here; nothing the model writes is ever markup
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]!);

// palette values are re-checked here even though the schema validated them
const colour = (c: string, fallback: string) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback);

function shell(c: PrototypeContent, body: string, extraCss = "") {
    const p = colour(c.palette.primary, "#0f3d2e");
    const a = colour(c.palette.accent, "#c8f169");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(c.brandName)} · demo</title>
<style>
:root{--p:${p};--a:${a};--ink:#14201b;--mute:#5d6b64;--line:#e3e8e4;--bg:#f7f9f7}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:var(--bg)}
a{color:inherit}h1,h2,h3{line-height:1.15;margin:0 0 .4em}h1{font-size:clamp(2rem,5vw,3.6rem);letter-spacing:-.02em}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}.btn{display:inline-block;background:var(--p);color:#fff;padding:.8em 1.3em;border-radius:999px;text-decoration:none;font-weight:600}
.btn.alt{background:var(--a);color:var(--ink)}.muted{color:var(--mute)}.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px}.tag{font:12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--mute)}
table{width:100%;border-collapse:collapse;background:#fff}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:14px}
.demo-note{position:fixed;right:12px;bottom:12px;background:var(--ink);color:#fff;font:12px ui-monospace,monospace;padding:6px 10px;border-radius:8px}
${extraCss}
</style></head><body>
${body}
<div class="demo-note">Demo · sample data only</div>
</body></html>`;
}

const items = (s: PrototypeContent["sections"][number]) =>
    s.items.map((i) => `<div class="card"><h3>${esc(i.title)}</h3><p class="muted">${esc(i.text)}</p></div>`).join("");

const sectionBlocks = (c: PrototypeContent) => c.sections.map((s, n) => `
<section class="wrap" id="s${n}" style="padding:56px 20px"><span class="tag">0${n + 1}</span><h2>${esc(s.heading)}</h2>
<p class="muted" style="max-width:60ch">${esc(s.body)}</p><div class="grid">${items(s)}</div></section>`).join("");

const metricCards = (c: PrototypeContent) => c.metrics.map((m) => `<div class="card"><span class="tag">${esc(m.label)}</span><div style="font-size:2rem;font-weight:700">${esc(m.value)}</div></div>`).join("");

const dataTable = (c: PrototypeContent) => c.table.columns.length ? `<table><thead><tr>${c.table.columns.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
<tbody>${c.table.rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";

const nav = (c: PrototypeContent) => `<header style="border-bottom:1px solid var(--line);background:#fff"><div class="wrap" style="display:flex;gap:20px;align-items:center;height:64px">
<b>${esc(c.brandName)}</b><nav style="display:flex;gap:16px;margin-left:auto" class="muted">${c.sections.map((s, n) => `<a href="#s${n}">${esc(s.heading)}</a>`).join("")}</nav></div></header>`;

const hero = (c: PrototypeContent) => `<section class="wrap" style="padding:72px 20px 40px"><span class="tag">${esc(c.tagline)}</span>
<h1>${esc(c.headline)}</h1><p class="muted" style="font-size:1.15rem;max-width:56ch">${esc(c.subheadline)}</p>
<p><a class="btn" href="#s0">${esc(c.primaryCta)}</a></p></section>`;

// the approved templates: fixed markup, no scripts, no external resources
export const TEMPLATES: Record<TemplateId, { name: string; brief: string; render: (c: PrototypeContent) => string }> = {
    landing_page: {
        name: "Landing page",
        brief: "a single-page landing page: hero, feature sections, a closing call to action.",
        render: (c) => shell(c, `${hero(c)}${sectionBlocks(c)}
<section class="wrap" style="padding:56px 20px"><div class="card" style="background:var(--p);color:#fff;text-align:center;padding:48px">
<h2>${esc(c.headline)}</h2><a class="btn alt" href="#s0">${esc(c.primaryCta)}</a></div></section>`),
    },
    business_website: {
        name: "Business website",
        brief: "a small business website: navigation, hero, service sections, proof metrics and a contact block.",
        render: (c) => shell(c, `${nav(c)}${hero(c)}<section class="wrap"><div class="grid">${metricCards(c)}</div></section>${sectionBlocks(c)}
<section class="wrap" style="padding:56px 20px"><div class="card"><h2>Contact</h2><p class="muted">The contact form is disabled in this demo.</p>
<a class="btn" href="#s0">${esc(c.primaryCta)}</a></div></section>`),
    },
    dashboard: {
        name: "SaaS dashboard",
        brief: "an analytics dashboard: sidebar, KPI cards, a data table and feature panels, with synthetic data.",
        render: (c) => shell(c, `<div class="app"><aside><b>${esc(c.brandName)}</b>${c.sections.map((s, n) => `<a href="#s${n}">${esc(s.heading)}</a>`).join("")}</aside>
<main><h1 style="font-size:1.8rem">${esc(c.headline)}</h1><p class="muted">${esc(c.subheadline)}</p>
<div class="grid">${metricCards(c)}</div><div style="margin:20px 0" class="bars">${c.metrics.map((_, i) => `<i style="height:${30 + ((i * 37) % 60)}%"></i>`).join("")}</div>
${dataTable(c)}${c.sections.map((s, n) => `<section id="s${n}" style="margin-top:28px"><h2>${esc(s.heading)}</h2><p class="muted">${esc(s.body)}</p><div class="grid">${items(s)}</div></section>`).join("")}</main></div>`,
        `.app{display:grid;grid-template-columns:220px 1fr;min-height:100vh}aside{background:var(--p);color:#fff;padding:20px;display:flex;flex-direction:column;gap:10px}
aside a{text-decoration:none;opacity:.8}main{padding:28px;min-width:0}.bars{display:flex;gap:10px;align-items:flex-end;height:140px;background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px}
.bars i{flex:1;background:var(--a);border-radius:6px 6px 0 0}@media(max-width:720px){.app{grid-template-columns:1fr}}`),
    },
    web_app_demo: {
        name: "Web app demo",
        brief: "a clickable web app: top bar, tabbed screens (one per section) and a records table, with synthetic data.",
        render: (c) => shell(c, `${nav(c)}<main class="wrap" style="padding:32px 20px"><h1 style="font-size:2rem">${esc(c.headline)}</h1>
<p class="muted">${esc(c.subheadline)}</p><div class="tabs">${c.sections.map((s, n) => `<a href="#s${n}">${esc(s.heading)}</a>`).join("")}</div>
${c.sections.map((s, n) => `<section class="screen" id="s${n}"><h2>${esc(s.heading)}</h2><p class="muted">${esc(s.body)}</p><div class="grid">${items(s)}</div></section>`).join("")}
<div style="margin-top:24px">${dataTable(c)}</div></main>`,
        `.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.tabs a{border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 14px;text-decoration:none}
.screen{display:none}.screen:first-of-type,.screen:target{display:block}main:has(.screen:target) .screen:not(:target){display:none}`),
    },
};

export const isTemplate = (id: string): id is TemplateId => Object.hasOwn(TEMPLATES, id);
