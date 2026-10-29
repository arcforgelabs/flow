#!/usr/bin/env node
// Collect: public GitHub records to report.json for the customer report
// (docs/CUSTOMER_REPORT.md). It reads only published releases, pull requests,
// their labels and the "User Impact" section, and open roadmap issues. It never
// reads customer data, Sentry or support tickets, so no person or AI has to.
//
//   node scripts/report/collect.mjs [--config scripts/report/report.yml] [--now <ISO time>] [--out report.json]
//
// Needs GITHUB_TOKEN (the workflow token is enough) and GITHUB_REPOSITORY.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// The calendar date and weekday of an instant in the report's time zone.
export function localDay(iso, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-AU", { timeZone, year: "numeric", month: "numeric", day: "numeric", weekday: "short" })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, key: p.weekday.slice(0, 3).toLowerCase() };
}

// Last week (Monday to Sunday) and this week to date, as local dates.
export function weekOf(nowIso, timeZone) {
  const t = localDay(nowIso, timeZone);
  const today = Date.UTC(t.y, t.m - 1, t.d);
  const back = (DAY_KEYS.indexOf(t.key) + 6) % 7; // days since Monday
  const monday = today - (back + 7) * 864e5;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(monday), to: iso(monday + 6 * 864e5), thisWeek: iso(monday + 7 * 864e5), today: iso(today) };
}

// "- Store a form photo. (#365) Thanks @x." lines under "### Highlights".
export function parseHighlights(body) {
  const part = String(body || "").split(/^### Highlights\s*$/m)[1];
  if (!part) return [];
  return part.split(/^#{2,3} /m)[0].split("\n").map((l) => l.match(/^- (.+?)\s*\(#(\d+)\)/)).filter(Boolean)
    .map((m) => ({ title: m[1].replace(/\.$/, ""), pr: +m[2] }));
}

// The "User Impact" section of a pull request body as plain text: no HTML
// comments, list marks, bold or code marks. Its first sentence is the why line.
export function userImpact(body) {
  const part = String(body || "").replace(/<!--[\s\S]*?-->/g, "").split(/^## User Impact\s*$/m)[1];
  if (!part) return { why: "", what: "" };
  const text = part.split(/^## /m)[0].replace(/^\s*[-*]\s+/gm, "").replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  const first = text.match(/^.+?[.!?](\s|$)/)?.[0].trim() || text;
  return { why: first.length <= 160 ? first : "", what: text };
}

// A short headline from a release note: the words before the first comma,
// semicolon or bracket. "Xero clients become Flow contacts, and ..." -> "Xero clients become Flow contacts".
// Kept whole when the cut leaves fewer than four words or an open quote.
export function headline(title) {
  const head = title.split(/,\s|;\s|\s\(/)[0];
  return head.split(" ").length < 4 || (head.split('"').length - 1) % 2 ? title : head;
}

export function iconFor(title, map) {
  const t = title.toLowerCase();
  for (const [word, icon] of Object.entries(map || {})) if (t.includes(word)) return icon;
  return "sparkles";
}

export function linkedIssues(body) {
  return [...String(body || "").matchAll(/(?:Closes|Fixes|Related:?)\s+#(\d+)/gi)].map((m) => +m[1]);
}

export function stageOf(pr, stages) {
  const [stage, pct] = !pr ? stages.none : pr.draft ? stages.draft : pr.approved ? stages.approved : stages.ready;
  return { stage, pct };
}

function fill(text, counts) { return String(text).replace(/\{(\w+)\}/g, (_, k) => String(counts[k] ?? "")); }
// "[Feature]: RFC: photo capture" -> "Photo capture"; "feat(ui): x" -> "X".
const cleanTitle = (t) => {
  const s = t.replace(/^\[\w+\]:\s*/, "").replace(/^(?:feat|fix|improve|refactor|docs|chore|rfc)(\([^)]*\))?!?:\s*/i, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const short = (iso) => { const [, m, d] = iso.split("-"); return `${+d} ${MONTHS[+m - 1].slice(0, 3)}`; };

// Evidence clips and stills that name a pull request (docs/evidence/*/index.json).
export function evidenceByPr(root) {
  const dir = join(root, "docs/evidence"), out = {};
  if (!existsSync(dir)) return out;
  for (const set of readdirSync(dir)) {
    const f = join(dir, set, "index.json");
    if (!existsSync(f)) continue;
    for (const e of JSON.parse(readFileSync(f, "utf8"))) {
      for (const pr of e.prs || []) out[pr] = { clip: e.clip && `ev/${set}/${e.clip}`, still: e.desktop && `ev/${set}/${e.desktop}`, steps: e.steps || [], src: join("docs/evidence", set) };
    }
  }
  return out;
}

export function build(config, data, nowIso) {
  const tz = config.timezone, w = weekOf(nowIso, tz), L = config.labels;
  const local = (iso) => { const x = localDay(iso, tz); return { date: `${x.y}-${String(x.m).padStart(2, "0")}-${String(x.d).padStart(2, "0")}`, key: x.key }; };
  const has = (pr, label) => (pr?.labels || []).some((l) => l.name === label);
  const items = [], seen = new Set(), dayKeys = new Set();
  for (const rel of data.releases) {
    const at = local(rel.published_at);
    if (at.date < w.from || at.date > w.today) continue;
    const day = at.date >= w.thisWeek ? "wtd" : at.key;
    for (const h of parseHighlights(rel.body)) {
      const pr = data.pulls[h.pr];
      if (seen.has(h.pr) || has(pr, L.hide)) continue;
      seen.add(h.pr); dayKeys.add(day);
      const impact = userImpact(pr?.body), ev = data.evidence[h.pr], title = config.titles?.[h.pr] || headline(h.title);
      items.push({
        id: `pr${h.pr}`, title, icon: iconFor(h.title, config.icons), day, next: false,
        major: has(pr, L.major), support: has(pr, L.support), why: impact.why, what: impact.what || h.title, more: title === h.title ? [] : [`${h.title}.`],
        status: `Live · ${short(at.date)}`, prs: [h.pr], issues: linkedIssues(pr?.body), evidence: ev || null, releasedAt: rel.published_at
      });
    }
  }
  const progress = [];
  for (const issue of data.roadmap) {
    const pr = data.openPulls.find((p) => linkedIssues(p.body).includes(issue.number) || String(p.body || "").includes(`#${issue.number}`));
    const st = stageOf(pr, config.stages), title = config.titles?.[issue.number] || cleanTitle(issue.title);
    const id = `i${issue.number}`;
    items.push({ id, title, icon: iconFor(title, config.icons), day: null, next: true, major: (issue.labels || []).some((l) => l.name === L.major),
      support: false, why: "", what: userImpact(issue.body).what || title, more: [], status: `In progress · ${st.stage}, ${st.pct}% to Ready`,
      prs: pr ? [pr.number] : [], issues: [issue.number], evidence: null });
    progress.push({ id, ...st });
  }
  const live = items.filter((i) => !i.next), thisWeek = live.filter((i) => i.day === "wtd");
  const merged = data.merged.filter((p) => !has(p, L.hide));
  const inWeek = (p, a, b) => { const d = local(p.merged_at).date; return d >= a && d <= b; };
  const security = merged.filter((p) => has(p, L.security)).map((p) => ({ tag: "Fixed", tone: "ok", date: short(local(p.merged_at).date), title: cleanTitle(p.title),
    text: userImpact(p.body).why, links: [{ label: "Change", href: `${data.repoUrl}pull/${p.number}` }], thisWeek: local(p.merged_at).date >= w.thisWeek }));
  const sup = (a, b) => merged.filter((p) => has(p, L.support) && inWeek(p, a, b)).map((p) => ({ tag: "Fixed", tone: "ok", title: cleanTitle(p.title),
    text: userImpact(p.body).why, open: seen.has(p.number) ? `pr${p.number}` : undefined }));
  const groups = [{ label: "Last week", items: sup(w.from, w.to) }, { label: "This week", items: sup(w.thisWeek, w.today) }];
  const support = groups.filter((g) => g.items.length);
  const counts = { items: [live.length - thisWeek.length, thisWeek.length], security: [security.length - security.filter((c) => c.thisWeek).length, security.filter((c) => c.thisWeek).length], support: groups.map((g) => g.items.length) };
  const releases = data.releases.filter((r) => { const d = local(r.published_at).date; return d >= w.from && d <= w.to; }).length;
  const prs = merged.filter((p) => inWeek(p, w.from, w.to)).length;
  const stats = config.stats.map((s) => {
    if (s.count === "none") return { icon: s.icon, label: s.label, go: s.go, value: "No data", note: "Not measured yet", wait: true };
    const [last, now] = counts[s.count];
    return { icon: s.icon, label: s.label, go: s.go, value: String(last), note: `${s.note ? s.note + ", " : ""}+${now} this week` };
  });
  const order = WEEK.filter((k) => dayKeys.has(k));
  const days = order.map((k) => {
    const date = new Date(Date.parse(w.from) + WEEK.indexOf(k) * 864e5).toISOString().slice(0, 10);
    return { key: k, short: k[0].toUpperCase() + k.slice(1), date: short(date), axis: `${k.toUpperCase()} ${+date.slice(8)}` };
  });
  days.push({ key: "wtd", short: "This week", date: `${+w.thisWeek.slice(8)}–${+w.today.slice(8)}`, axis: `${short(w.thisWeek).toUpperCase()} – ${short(w.today).toUpperCase()}` });
  const rank = (i) => (i.major ? 4 : 0) + (i.support ? 2 : 0) + (i.evidence ? 1 : 0);
  const highlights = live.slice().sort((a, b) => rank(b) - rank(a) || String(b.releasedAt).localeCompare(String(a.releasedAt))).slice(0, config.highlights).map((i) => i.id);
  const majorNext = items.filter((i) => i.next && i.major).length;
  const lead = live.find((i) => i.id === highlights[0]);
  const fmt = (iso) => { const [y, m, d] = iso.split("-"); return { y, m: MONTHS[+m - 1], d: +d }; };
  const a = fmt(w.from), b = fmt(w.to);
  return {
    product: config.product, title: config.title,
    period: { label: `Mon ${a.d}${a.m === b.m ? "" : " " + a.m} – Sun ${b.d} ${b.m} ${b.y}`, from: w.from, to: w.to, today: w.today },
    lede: lead ? `${lead.title}.` : `${config.product} kept running.`,
    links: { repo: data.repoUrl },
    stats, days, items: items.map(({ releasedAt, ...i }) => i), highlights,
    ahead: { progress, planned: { label: config.planned, note: majorNext ? `${majorNext} major` : `${progress.length} in progress` } },
    checks: config.checks.map((c) => ({ ...c, result: fill(c.result, { prs, releases }) })),
    security, support, uptime: { ...config.uptime }
  };
}

async function gh(path, token) {
  const res = await fetch(`https://api.github.com/${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).join(" ").split(/\s*--/).filter(Boolean).map((a) => a.split(/\s+/)));
  const config = parse(readFileSync(args.config?.[0] || "scripts/report/report.yml", "utf8"));
  const now = args.now?.[0] || new Date().toISOString();
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("Set GITHUB_REPOSITORY and GITHUB_TOKEN.");
  const w = weekOf(now, config.timezone);
  const releases = (await gh(`repos/${repo}/releases?per_page=50`, token)).filter((r) => !r.draft && !r.prerelease);
  const merged = (await gh(`repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`, token))
    .filter((p) => p.merged_at && p.merged_at >= w.from);
  const pulls = {};
  for (const n of new Set(releases.flatMap((r) => parseHighlights(r.body).map((h) => h.pr)))) {
    pulls[n] = merged.find((p) => p.number === n) || await gh(`repos/${repo}/pulls/${n}`, token).catch(() => null);
  }
  const roadmap = (await gh(`repos/${repo}/issues?state=open&labels=${encodeURIComponent(config.labels.roadmap)}&per_page=50`, token)).filter((i) => !i.pull_request);
  const openPulls = await gh(`repos/${repo}/pulls?state=open&per_page=100`, token);
  for (const p of openPulls) {
    if (p.draft) continue;
    const reviews = await gh(`repos/${repo}/pulls/${p.number}/reviews`, token);
    p.approved = reviews.some((r) => r.state === "APPROVED");
  }
  const report = build(config, { releases, pulls, merged, roadmap, openPulls, evidence: evidenceByPr("."), repoUrl: `https://github.com/${repo}/` }, now);
  writeFileSync(args.out?.[0] || "report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(`report: ${report.items.length} items, ${report.highlights.length} highlights, period ${report.period.label}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
