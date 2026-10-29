#!/usr/bin/env node
// Render: report.json to the customer report pair (docs/CUSTOMER_REPORT.md).
//   site.html          the full web page (scripts/report/site.html with the data)
//   email.html         the email summary: tables and inline styles only, merge
//                      fields left in ({{first_name}}, {{account}}, ...)
//   email-preview.html the same email with a <style> block and the merge fields
//                      filled, for a browser preview that blocks style attributes
//   timeline.png       the timeline chart, which email clients cannot draw
//   ev/                the walkthrough clips and stills the page links to
//
//   node scripts/report/render.mjs --report report.json --out out --site-url <url> [--merge '{"first_name":"Sam"}']
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = join(HERE, "../../node_modules/lucide-static/icons");

export function icons(names) {
  const out = {};
  for (const n of new Set(names)) {
    const f = join(ICONS, `${n}.svg`);
    if (existsSync(f)) out[n] = readFileSync(f, "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, "").replace(/\s+/g, " ").trim();
  }
  return out;
}

export function site(report, siteUrl) {
  const names = [...report.items.map((i) => i.icon), ...report.stats.map((s) => s.icon), ...report.ongoing.map((c) => c.icon), "rocket", "circle-play", "list", "coffee", "bug", "sparkles", "shield-check", "external-link", "maximize-2", "check", "git-pull-request", "user-check", "flask-conical", "hammer", "sparkle", "wrench", "moon", "sun", "tent"];
  const data = { ...report, icons: icons(names), links: { ...report.links, site: siteUrl } };
  return readFileSync(join(HERE, "site.html"), "utf8")
    .replace("__TITLE__", esc(report.title))
    .replace("__REPORT__", () => JSON.stringify(data).replace(/</g, "\\u003c"));
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Flow Meridian colours (server/theme/themes.js). Email clients ignore CSS
// variables, so the email names each colour once here.
const C = { bg: "#f6f3ef", paper: "#ffffff", brd: "#e0dbd1", text: "#1d3444", strong: "#13242f", dim: "#4d6575", mute: "#526a7a",
  accentBg: "#faefdd", accentBrd: "#d4b07a", primary: "#1d3444", onPrimary: "#f8dfb9", support: "#6d4aa8" };
const BODY = "'Plus Jakarta Sans',Arial,Helvetica,sans-serif", DISPLAY = "'Playfair Display',Georgia,'Times New Roman',serif";
const S = {
  body: `margin:0;padding:0;background:${C.bg};color:${C.text};font:15px/1.5 ${BODY}`,
  pre: "display:none;max-height:0;overflow:hidden;opacity:0",
  outer: `background:${C.bg};padding:24px 12px`,
  card: `width:100%;max-width:600px;background:${C.paper};border:1px solid ${C.brd}`,
  head: `padding:24px 28px 0;font:400 24px/1 ${DISPLAY};color:${C.strong}`,
  kind: `font:600 11px ${BODY};letter-spacing:2px;text-transform:uppercase;color:${C.mute}`,
  period: `padding:8px 28px 0;font:400 19px/1.2 ${DISPLAY};color:${C.strong}`,
  pad: "padding:20px 28px 0",
  hi: `margin:0;font-size:15px;color:${C.dim}`,
  lede: `margin:8px 0 0;font:400 28px/1.2 ${DISPLAY};color:${C.strong}`,
  lbl: `margin:0 0 10px;font:600 11px ${BODY};letter-spacing:2px;text-transform:uppercase;color:${C.mute}`,
  stat: `width:33%;padding:12px 14px;border:1px solid ${C.brd};vertical-align:top`,
  statl: `display:block;font:600 11px ${BODY};letter-spacing:1.5px;text-transform:uppercase;color:${C.dim};text-decoration:none`,
  statn: `display:block;margin-top:6px;font:400 30px/1 ${DISPLAY};color:${C.strong};text-decoration:none`,
  statw: `display:block;margin-top:6px;font-size:12.5px;color:${C.mute};text-decoration:none`,
  img: `display:block;width:100%;max-width:544px;height:auto;border:1px solid ${C.brd}`,
  row: `padding:10px 0;border-bottom:1px solid ${C.brd}`,
  hlt: `font-weight:700;font-size:15px;color:${C.strong};text-decoration:none`,
  major: `display:inline-block;margin-left:6px;padding:1px 6px;font:700 10px ${BODY};letter-spacing:1.5px;color:${C.onPrimary};background:${C.primary}`,
  sup: `display:inline-block;margin-left:6px;padding:1px 6px;font:700 10px ${BODY};letter-spacing:1.5px;color:#ffffff;background:${C.support}`,
  pname: `font-weight:600;font-size:14px;color:${C.strong};text-decoration:none`,
  pst: `font-size:12.5px;color:${C.mute};text-align:right;white-space:nowrap`,
  bar: `height:6px;line-height:6px;font-size:0;background:${C.brd}`,
  fill: `height:6px;line-height:6px;font-size:0;background:${C.primary}`,
  plan: `padding:14px;background:${C.primary};color:${C.onPrimary};font-weight:700;text-align:center`,
  btnc: `padding:28px 28px 8px`,
  btn: `display:inline-block;padding:12px 24px;background:${C.primary};color:${C.onPrimary};font:700 14px ${BODY};text-decoration:none`,
  foot: `padding:20px 28px 24px;font-size:12px;line-height:1.6;color:${C.mute}`,
  flink: `color:${C.mute}`,
  gap: "padding-top:6px",
  mt: "margin-top:12px"
};

// One email, two ways to carry its styles: inline (to send) or classes (to preview).
export function email(report, { siteUrl, timeline = "timeline.png", inline = true, merge = {} }) {
  const a = (k) => (inline ? `style="${S[k]}"` : `class="${k}"`);
  const m = (k) => (k in merge ? esc(merge[k]) : `{{${k}}}`);
  const by = Object.fromEntries(report.items.map((i) => [i.id, i]));
  const link = (hash) => esc(`${siteUrl}#${hash}`);
  const thisWeek = report.items.filter((i) => i.day === "wtd").length, last = report.items.filter((i) => !i.next).length - thisWeek;
  const stats = report.stats.map((s) => `<td ${a("stat")}><a href="${link(s.go)}" ${a("statl")}>${esc(s.label)}</a><a href="${link(s.go)}" ${a("statn")}>${esc(s.value)}</a><a href="${link(s.go)}" ${a("statw")}>${esc(s.note)}</a></td>`);
  const hl = report.highlights.map((id) => by[id]).map((i) => `<tr><td ${a("row")}><a href="${link(i.id)}" ${a("hlt")}>${esc(i.title)}</a>${i.major ? `<span ${a("major")}>MAJOR</span>` : ""}${i.support ? `<span ${a("sup")}>SUPPORT</span>` : ""}</td></tr>`).join("");
  const prog = report.ahead.progress.map((p) => {
    const i = by[p.id], w = Math.max(0, Math.min(100, p.pct));
    const bar = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${w ? `<td width="${w}%" ${a("fill")}>&nbsp;</td>` : ""}${w < 100 ? `<td ${a("bar")}>&nbsp;</td>` : ""}</tr></table>`;
    return `<tr><td ${a("row")}><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td><a href="${link(p.id)}" ${a("pname")}>${esc(i.title)}</a>${i.major ? `<span ${a("major")}>MAJOR</span>` : ""}</td><td ${a("pst")}>${esc(p.stage)} · ${w}%</td></tr><tr><td colspan="2" ${a("gap")}>${bar}</td></tr></table></td></tr>`;
  }).join("");
  const css = inline ? "" : `<style>${Object.entries(S).map(([k, v]) => `.${k}{${v}}`).join("")}</style>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(report.title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&amp;family=Playfair+Display:wght@400&amp;display=swap">${css}</head>
<body ${a("body")}>
<div ${a("pre")}>${esc(report.lede)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ${a("outer")}><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" ${a("card")}>
<tr><td ${a("head")}>${esc(report.product)} <span ${a("kind")}>&nbsp;·&nbsp;${esc(report.kind)}</span></td></tr>
<tr><td ${a("period")}>${esc(report.period.label)}</td></tr>
<tr><td ${a("pad")}><p ${a("hi")}>Hi ${m("first_name")},</p><h1 ${a("lede")}>${esc(report.lede)}</h1></td></tr>
<tr><td ${a("pad")}><p ${a("lbl")}>In numbers</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${stats.join("")}</tr></table></td></tr>
<tr><td ${a("pad")}><p ${a("lbl")}>Timeline</p><a href="${link("d-updates")}"><img src="${esc(timeline)}" width="544" alt="Timeline: ${last} updates last week, ${thisWeek} this week. Open the page to see each one." ${a("img")}></a></td></tr>
<tr><td ${a("pad")}><p ${a("lbl")}>Highlights</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${hl}</table></td></tr>
<tr><td ${a("pad")}><p ${a("lbl")}>Week ahead</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${prog}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ${a("mt")}><tr><td ${a("plan")}>${esc(report.ahead.planned.label)} · ${esc(report.ahead.planned.note)}</td></tr></table></td></tr>
<tr><td align="center" ${a("btnc")}><a href="${esc(siteUrl)}" ${a("btn")}>See all updates</a></td></tr>
<tr><td ${a("foot")}>You get this email as an admin of ${m("account")} on ${esc(report.product)}.<br><a href="${m("preferences_url")}" ${a("flink")}>Email choices</a> · <a href="${m("unsubscribe_url")}" ${a("flink")}>Unsubscribe</a><br>Arc Forge · ${m("sender_address")}</td></tr>
</table></td></tr></table>
</body></html>
`;
  return html;
}

async function timelinePng(sitePath, outPath) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  await page.goto(`file://${sitePath}`);
  await page.evaluate(() => document.body.setAttribute("data-mode", "summary"));
  await page.locator("#hero").screenshot({ path: outPath });
  await browser.close();
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).join("\u0000").split(/\u0000?--/).filter(Boolean).map((a) => { const [k, ...v] = a.split("\u0000"); return [k, v.join(" ")]; }));
  const report = JSON.parse(readFileSync(args.report || "report.json", "utf8")), out = args.out || "out", siteUrl = args["site-url"] || "site.html";
  mkdirSync(out, { recursive: true });
  for (const i of report.items) if (i.evidence?.src) cpSync(i.evidence.src, join(out, "ev", i.evidence.src.split("/").pop()), { recursive: true });
  writeFileSync(join(out, "site.html"), site(report, siteUrl));
  writeFileSync(join(out, "email.html"), email(report, { siteUrl }));
  writeFileSync(join(out, "email-preview.html"), email(report, { siteUrl, inline: false, merge: JSON.parse(args.merge || "{}") }));
  await timelinePng(resolve(out, "site.html"), join(out, "timeline.png"));
  console.log(`report: wrote ${out}/site.html, email.html, email-preview.html, timeline.png`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
