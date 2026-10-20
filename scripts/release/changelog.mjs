#!/usr/bin/env node
// The changelog: one file per release in CHANGELOG/, and CHANGELOG.md, an
// index of them that this script writes. The layout follows
// openclaw/openclaw's split changelog. Pull requests never edit these files;
// the release cut writes a release's file from the pull requests merged since
// the previous release (CONTRIBUTING.md, .agents/skills/flow-changelog-update).
//
//   node scripts/release/changelog.mjs draft --version <v> [--base <tag>] [--target <ref>] [--output <file>]
//     A first section for <v> from git history: Changes and Fixes from
//     feat, improve and fix pull requests, Highlights seeded from them, and the
//     complete record of every pull request in the range. Edit the prose, then
//     `write` it.
//   node scripts/release/changelog.mjs write --version <v> --file <section.md>
//     Saves the section as CHANGELOG/<v>.md and writes the index again.
//   node scripts/release/changelog.mjs read --version <v>
//     The section, as saved.
//   node scripts/release/changelog.mjs notes --version <v>
//     The GitHub Release body for <v>: the section, or, when it is too long
//     for GitHub, the prose and a link to the record.
//   node scripts/release/changelog.mjs verify --version <v> [--base <tag>] [--target <ref>]
//     Whether the section's record lists exactly the pull requests in the range.
//     Flow Release Prepare runs it before it tags a stable release.
//   node scripts/release/changelog.mjs index
//     Writes CHANGELOG.md again from the files in CHANGELOG/.
//   node scripts/release/changelog.mjs check
//     Whether the index and every file follow the rules below (npm test runs it).
//
// Each exits 1 with a reason on stderr.
//
// A release's range: a stable release covers every pull request since the
// previous stable release; a beta covers those since the previous release of
// either channel. Only `feat`, `improve` and `fix` pull requests (and any type
// marked breaking with `!`) appear in the prose; `docs`, `chore`, `refactor`,
// `test`, `ci`, `build` and `style` appear only in the record.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareBase, parseTag } from "./release.mjs";

export const REPOSITORY = "arcforgelabs/flow";
export const INDEX_MARKER = "<!-- flow:split-changelog -->";
export const UNRELEASED = "Unreleased";
// GitHub refuses a release body longer than this.
export const GITHUB_BODY_LIMIT = 125_000;

const PROSE = ["Highlights", "Changes", "Fixes"];
const RECORD = "Complete contribution record";
const HIGHLIGHTS_MAX = 8;
const EDITORIAL_TYPES = new Set(["feat", "improve", "fix"]);
const TITLE = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s*(?<description>.+)$/;
const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/;
const PR_LINK = new RegExp(`\\[#(\\d+)\\]\\(https://github\\.com/${REPOSITORY.replace("/", "\\/")}/pull/(\\d+)\\)`, "g");
const RECORD_ROW = /^- \*\*PR #(\d+)\*\* (.+)$/;

export class ChangelogError extends Error {}

export function pullUrl(number) {
  return `https://github.com/${REPOSITORY}/pull/${number}`;
}

// A changelog version: a release version without the "v" of its tag.
export function parseVersion(version) {
  try {
    return parseTag(`v${version}`);
  } catch {
    throw new ChangelogError(`"${version}" is not a release version (YYYY.M.N or YYYY.M.N-beta.B)`);
  }
}

// Newest first; a stable release comes before its own betas.
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  const beta = (release) => release.beta ?? Number.MAX_SAFE_INTEGER;
  return compareBase(x.base, y.base) || beta(x) - beta(y);
}

// A merged pull request's squash subject, `type(scope)!: description (#N)`.
export function parseSubject(subject) {
  const pr = PR_SUFFIX.exec(subject);
  const title = subject.replace(PR_SUFFIX, "").trim();
  const match = TITLE.exec(title);
  const type = match?.groups.type ?? null;
  const breaking = Boolean(match?.groups.breaking);
  return {
    number: pr ? Number(pr[1]) : null,
    title,
    type,
    scope: match?.groups.scope ?? null,
    breaking,
    description: match ? match.groups.description.trim() : title,
    editorial: Boolean(type && (EDITORIAL_TYPES.has(type) || breaking)),
    section: type === "fix" ? "Fixes" : "Changes",
  };
}

function sentence(text) {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

export function entry(pr) {
  return `- ${sentence(pr.description)} [#${pr.number}](${pullUrl(pr.number)})`;
}

// Pull requests in a list of commits ({ sha, subject }), oldest first. A
// commit with no "(#N)" is a direct commit and has no row. A revert of a pull
// request in the same range removes both. A `docs(changelog):` pull request
// carries the notes themselves, so it has no row: it could not list itself.
export function pullRequestsIn(commits) {
  const prs = [];
  const reverted = new Set();
  for (const commit of commits) {
    const revert = /^Revert "(.+)"/.exec(commit.subject);
    if (revert) reverted.add(revert[1].trim());
  }
  for (const commit of commits) {
    if (reverted.has(commit.subject.trim())) continue;
    if (/^Revert "/.test(commit.subject) && commits.some((other) => other.subject.trim() === /^Revert "(.+)"/.exec(commit.subject)[1].trim())) continue;
    const pr = parseSubject(commit.subject);
    if (pr.type === "docs" && pr.scope === "changelog") continue;
    if (pr.number !== null && !prs.some((other) => other.number === pr.number)) prs.push({ ...pr, sha: commit.sha });
  }
  return prs;
}

export function renderSection({ version, range, prs, highlights }) {
  const prose = prs.filter((pr) => pr.editorial);
  const seeded = highlights ?? [...prose.filter((pr) => pr.section === "Changes"), ...prose.filter((pr) => pr.section === "Fixes")].slice(0, 5);
  const lines = [`## ${version}`, ""];
  const add = (heading, items) => {
    if (items.length === 0) return;
    lines.push(`### ${heading}`, "", ...items.map(entry), "");
  };
  add("Highlights", seeded);
  add("Changes", prose.filter((pr) => pr.section === "Changes"));
  add("Fixes", prose.filter((pr) => pr.section === "Fixes"));
  const count = `${prs.length} pull request${prs.length === 1 ? "" : "s"}`;
  lines.push(`### ${RECORD}`, "", `This record covers the complete ${range} history: ${count}.`, "");
  lines.push(...prs.map((pr) => `- **PR #${pr.number}** ${pr.title}`), "");
  return `${lines.join("\n").trimEnd()}\n`;
}

// A section's parts: its heading, each ### block's bullets, and its record.
export function parseSection(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const heading = /^## (.+)$/.exec(lines[0] ?? "")?.[1];
  const blocks = [];
  for (const line of lines.slice(1)) {
    const block = /^### (.+)$/.exec(line);
    if (block) blocks.push({ heading: block[1], lines: [] });
    else if (/^##? /.test(line)) throw new ChangelogError(`a section has one "## " heading; found "${line}"`);
    else if (blocks.length > 0) blocks.at(-1).lines.push(line);
    else if (line.trim() !== "") throw new ChangelogError(`text before the first "### " heading: "${line}"`);
  }
  return { heading, blocks };
}

function bullets(block) {
  return block.lines.filter((line) => line.startsWith("- "));
}

// The rules one file in CHANGELOG/ follows. Returns its record's PR numbers.
export function checkSection(name, text) {
  const version = name.replace(/\.md$/, "");
  const unreleased = version === UNRELEASED;
  const release = unreleased ? null : parseVersion(version);
  const { heading, blocks } = parseSection(text);
  const fail = (reason) => {
    throw new ChangelogError(`CHANGELOG/${name}: ${reason}`);
  };
  if (heading !== version) fail(`the first line must be "## ${version}"`);
  const order = [...PROSE, RECORD];
  let last = -1;
  for (const block of blocks) {
    const at = order.indexOf(block.heading);
    if (at < 0) fail(`"### ${block.heading}" is not one of ${order.map((h) => `"${h}"`).join(", ")}`);
    if (at <= last) fail(`"### ${block.heading}" is out of order or repeated (order: ${order.join(", ")})`);
    last = at;
    for (const line of block.lines) {
      if (line.trim() !== "" && !line.startsWith("- ") && !line.startsWith("  ") && block.heading !== RECORD) {
        fail(`"### ${block.heading}" holds only bullets; found "${line}"`);
      }
    }
  }
  const find = (headingName) => blocks.find((block) => block.heading === headingName);
  const record = find(RECORD);
  if (unreleased) {
    if (record) fail("Unreleased has no record; the release cut writes one");
    return [];
  }
  if (!record) fail(`a release ends with "### ${RECORD}"`);
  const rows = new Map();
  for (const line of bullets(record)) {
    const row = RECORD_ROW.exec(line);
    if (!row) fail(`a record row is "- **PR #N** <title>"; found "${line}"`);
    const number = Number(row[1]);
    if (rows.has(number)) fail(`PR #${number} is in the record twice`);
    rows.set(number, parseSubject(row[2]));
  }
  const total = /: (\d+) pull requests?\.$/m.exec(record.lines.join("\n"));
  if (!total || Number(total[1]) !== rows.size) fail(`the record says how many pull requests it lists, and it lists ${rows.size}`);
  const highlights = find("Highlights");
  const count = highlights ? bullets(highlights).length : 0;
  const prose = find("Changes") || find("Fixes");
  if (count > HIGHLIGHTS_MAX) fail(`at most ${HIGHLIGHTS_MAX} highlights; found ${count}`);
  if (release.channel === "stable" && prose && count === 0) fail("a stable release with changes or fixes has at least one highlight");
  for (const headingName of PROSE) {
    const block = find(headingName);
    if (!block) continue;
    for (const line of bullets(block)) {
      const links = [...line.matchAll(PR_LINK)];
      if (links.length === 0) fail(`each "### ${headingName}" bullet links its pull request: "${line}"`);
      for (const [, text, target] of links) {
        const number = Number(target);
        if (text !== target) fail(`"[#${text}]" links to pull ${target}`);
        if (!rows.has(number)) fail(`PR #${number} is in "### ${headingName}" but not in the record`);
        if (!rows.get(number).editorial) fail(`PR #${number} (${rows.get(number).type ?? "no type"}) belongs only in the record, not in "### ${headingName}"`);
      }
    }
  }
  return [...rows.keys()];
}

export function renderIndex(versions) {
  const sorted = [...versions].sort((a, b) => compareVersions(b, a));
  const row = (name) => `- [${name}](CHANGELOG/${name}.md)`;
  return [
    "# Changelog",
    "",
    INDEX_MARKER,
    "",
    "Each release has its own file in `CHANGELOG/`, newest first below. The",
    "release cut writes it from the pull requests merged since the previous",
    "release; pull requests do not edit these files (`CONTRIBUTING.md`).",
    "`scripts/release/changelog.mjs` writes this index.",
    "",
    row(UNRELEASED),
    ...sorted.map(row),
    "",
  ].join("\n");
}

export function listVersions(root) {
  const dir = join(root, "CHANGELOG");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== `${UNRELEASED}.md`)
    .map((name) => name.replace(/\.md$/, ""));
}

export function checkChangelog(root) {
  const dir = join(root, "CHANGELOG");
  const names = existsSync(dir) ? readdirSync(dir) : [];
  if (!names.includes(`${UNRELEASED}.md`)) throw new ChangelogError(`CHANGELOG/${UNRELEASED}.md is missing`);
  const versions = [];
  for (const name of names) {
    if (!name.endsWith(".md")) throw new ChangelogError(`CHANGELOG/${name}: only .md files belong here`);
    checkSection(name, readFileSync(join(dir, name), "utf8"));
    if (name !== `${UNRELEASED}.md`) versions.push(name.replace(/\.md$/, ""));
  }
  const index = existsSync(join(root, "CHANGELOG.md")) ? readFileSync(join(root, "CHANGELOG.md"), "utf8") : "";
  if (index !== renderIndex(versions)) {
    throw new ChangelogError("CHANGELOG.md is not the index of CHANGELOG/. Run: node scripts/release/changelog.mjs index");
  }
  return { versions: versions.sort((a, b) => compareVersions(b, a)) };
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function isAncestor(root, ancestor, ref) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, ref], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The previous release a version's notes start from: the newest older stable
// tag for a stable release, the newest older tag of either channel for a beta,
// and in each case one that the target contains.
export function baseTag({ version, tags, contains = () => true }) {
  const release = parseVersion(version);
  const older = [];
  for (const tag of tags) {
    let parsed;
    try {
      parsed = parseTag(tag.trim());
    } catch {
      continue;
    }
    if (release.channel === "stable" && parsed.channel !== "stable") continue;
    if (compareVersions(parsed.version, release.version) >= 0) continue;
    older.push(parsed);
  }
  older.sort((a, b) => compareVersions(b.version, a.version));
  return older.find((tag) => contains(tag.tag))?.tag ?? null;
}

export function historyRange(root, { version, base, target }) {
  if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new ChangelogError("this clone is shallow, so its history is cut short. Run: git fetch --unshallow --tags origin");
  }
  const tag = `v${parseVersion(version).version}`;
  const to = target ?? (git(root, ["tag", "--list", tag]).trim() ? tag : "HEAD");
  const tags = git(root, ["tag", "--list", "v20*"]).split("\n").filter(Boolean);
  const from = base ?? baseTag({ version, tags, contains: (candidate) => isAncestor(root, candidate, to) });
  const log = git(root, ["log", "--first-parent", "--reverse", "--format=%H%x1f%s%x1e", from ? `${from}..${to}` : to]);
  const commits = log
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject] = record.split("\x1f");
      return { sha, subject };
    });
  const label = (ref) => (ref === "HEAD" ? git(root, ["rev-parse", "HEAD"]).trim() : ref);
  return { from, to, range: from ? `${from}..${label(to)}` : `${label(to)} (from the first commit)`, prs: pullRequestsIn(commits) };
}

export function readSection(root, version) {
  const file = join(root, "CHANGELOG", `${version}.md`);
  if (!existsSync(file)) throw new ChangelogError(`CHANGELOG/${version}.md does not exist. The release cut writes it (.agents/skills/flow-changelog-update).`);
  return readFileSync(file, "utf8");
}

export function releaseNotes(text, version) {
  if (text.length <= GITHUB_BODY_LIMIT && Buffer.byteLength(text) <= GITHUB_BODY_LIMIT) return text;
  const prose = text.slice(0, text.indexOf(`### ${RECORD}`)).trimEnd();
  const link = `https://github.com/${REPOSITORY}/blob/v${version}/CHANGELOG/${version}.md#complete-contribution-record`;
  return `${prose}\n\n### ${RECORD}\n\nThe record is too long for this page: [CHANGELOG/${version}.md](${link}).\n`;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new ChangelogError(`${name} is required`);
  return value;
}

function writeIndex(root) {
  writeFileSync(join(root, "CHANGELOG.md"), renderIndex(listVersions(root)));
}

export function main(argv, root = resolve(import.meta.dirname, "../..")) {
  const [command, ...args] = argv;
  if (command === "draft") {
    const version = parseVersion(required(args, "--version")).version;
    const { range, prs } = historyRange(root, { version, base: option(args, "--base"), target: option(args, "--target") });
    return renderSection({ version, range, prs });
  }
  if (command === "write") {
    const version = parseVersion(required(args, "--version")).version;
    const text = readFileSync(required(args, "--file"), "utf8");
    checkSection(`${version}.md`, text);
    mkdirSync(join(root, "CHANGELOG"), { recursive: true });
    writeFileSync(join(root, "CHANGELOG", `${version}.md`), text);
    writeIndex(root);
    return `CHANGELOG/${version}.md\n`;
  }
  if (command === "read") return readSection(root, parseVersion(required(args, "--version")).version);
  if (command === "notes") {
    const version = parseVersion(required(args, "--version")).version;
    return releaseNotes(readSection(root, version), version);
  }
  if (command === "verify") {
    const version = parseVersion(required(args, "--version")).version;
    const listed = checkSection(`${version}.md`, readSection(root, version));
    const { range, prs } = historyRange(root, { version, base: option(args, "--base"), target: option(args, "--target") });
    const expected = prs.map((pr) => pr.number);
    const missing = expected.filter((number) => !listed.includes(number));
    const extra = listed.filter((number) => !expected.includes(number));
    if (missing.length || extra.length) {
      throw new ChangelogError(
        `CHANGELOG/${version}.md does not match ${range}: missing ${missing.map((n) => `#${n}`).join(", ") || "none"}; not in range ${extra.map((n) => `#${n}`).join(", ") || "none"}`,
      );
    }
    return `CHANGELOG/${version}.md lists the ${expected.length} pull requests in ${range}\n`;
  }
  if (command === "index") {
    writeIndex(root);
    return "CHANGELOG.md\n";
  }
  if (command === "check") {
    const { versions } = checkChangelog(root);
    return `CHANGELOG.md and ${versions.length + 1} files in CHANGELOG/ follow the rules\n`;
  }
  throw new ChangelogError("usage: changelog.mjs draft|write|read|notes|verify|index|check (see the header of this file)");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const out = main(process.argv.slice(2));
    const file = process.argv[2] === "draft" ? option(process.argv, "--output") : undefined;
    if (file) writeFileSync(file, out);
    else process.stdout.write(out);
  } catch (error) {
    console.error(error instanceof ChangelogError ? error.message : error);
    process.exit(1);
  }
}
