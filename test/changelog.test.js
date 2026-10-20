import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  baseTag,
  checkChangelog,
  checkSection,
  compareVersions,
  main,
  parseSubject,
  pullRequestsIn,
  pullUrl,
  releaseNotes,
  renderIndex,
  renderSection,
} from "../scripts/release/changelog.mjs";

const root = join(import.meta.dirname, "..");
const link = (number) => `[#${number}](${pullUrl(number)})`;

function section(version, { highlights = [], changes = [], fixes = [], record = [] } = {}) {
  const lines = [`## ${version}`, ""];
  if (highlights.length) lines.push("### Highlights", "", ...highlights, "");
  if (changes.length) lines.push("### Changes", "", ...changes, "");
  if (fixes.length) lines.push("### Fixes", "", ...fixes, "");
  lines.push("### Complete contribution record", "", `This record covers the complete v0..v1 history: ${record.length} pull request${record.length === 1 ? "" : "s"}.`, "", ...record, "");
  return lines.join("\n");
}

test("the repository's changelog follows the rules", () => {
  const { versions } = checkChangelog(root);
  assert.ok(versions.includes("2026.10.31"));
});

test("a squash subject gives the pull request, its type and its section", () => {
  assert.deepEqual(parseSubject("fix(xero): match jobs once invoices are copied (#99)"), {
    number: 99, title: "fix(xero): match jobs once invoices are copied", type: "fix", breaking: false,
    description: "match jobs once invoices are copied", editorial: true, section: "Fixes",
  });
  assert.equal(parseSubject("improve: settings rows (#80)").section, "Changes");
  for (const internal of ["docs: how to release (#23)", "chore: release 2026.10.19 (#41)", "refactor: split the port (#9)", "test: cover sends (#8)"]) {
    assert.equal(parseSubject(internal).editorial, false, internal);
  }
  assert.equal(parseSubject("chore!: drop Node 22 (#7)").editorial, true);
  assert.equal(parseSubject("chore: start Flow with a new history").number, null);
});

test("direct commits get no row, and a pull request reverted in the range drops out", () => {
  const prs = pullRequestsIn([
    { sha: "a", subject: "chore: start Flow with a new history" },
    { sha: "b", subject: "feat: job board (#10)" },
    { sha: "c", subject: "fix: sign-in loop (#11)" },
    { sha: "d", subject: 'Revert "fix: sign-in loop (#11)" (#12)' },
  ]);
  assert.deepEqual(prs.map((pr) => pr.number), [10]);
});

test("versions sort newest first, with a stable release before its betas", () => {
  const sorted = ["2026.10.9", "2026.10.32-beta.1", "2026.10.32", "2026.10.31", "2026.11.1"].sort((a, b) => compareVersions(b, a));
  assert.deepEqual(sorted, ["2026.11.1", "2026.10.32", "2026.10.32-beta.1", "2026.10.31", "2026.10.9"]);
  assert.match(renderIndex(["2026.10.9", "2026.10.31"]), /- \[Unreleased\]\(CHANGELOG\/Unreleased\.md\)\n- \[2026\.10\.31\]\(CHANGELOG\/2026\.10\.31\.md\)\n- \[2026\.10\.9\]/);
});

test("a stable release starts from the previous stable release, a beta from the previous release", () => {
  const tags = ["v2026.10.30", "v2026.10.31", "v2026.10.32-beta.1", "v2026.10.32-beta.2", "v2026.10.33", "not-a-tag"];
  assert.equal(baseTag({ version: "2026.10.32", tags }), "v2026.10.31");
  assert.equal(baseTag({ version: "2026.10.32-beta.2", tags }), "v2026.10.32-beta.1");
  assert.equal(baseTag({ version: "2026.10.32-beta.1", tags }), "v2026.10.31");
  assert.equal(baseTag({ version: "2026.10.32", tags, contains: (tag) => tag !== "v2026.10.31" }), "v2026.10.30");
  assert.equal(baseTag({ version: "2026.10.30", tags }), null);
});

test("a drafted section passes the check", () => {
  const prs = pullRequestsIn([
    { sha: "a", subject: "feat: job board (#10)" },
    { sha: "b", subject: "fix: sign-in loop (#11)" },
    { sha: "c", subject: "docs: how to release (#12)" },
  ]);
  const text = renderSection({ version: "2026.10.40", range: "v2026.10.39..v2026.10.40", prs });
  assert.match(text, /### Changes\n\n- Job board\. \[#10\]/);
  assert.match(text, /### Fixes\n\n- Sign-in loop\. \[#11\]/);
  assert.match(text, /- \*\*PR #12\*\* docs: how to release/);
  assert.doesNotMatch(text.slice(0, text.indexOf("### Complete")), /#12/);
  assert.deepEqual(checkSection("2026.10.40.md", text), [10, 11, 12]);
});

test("the check refuses a section that breaks the rules", () => {
  const record = ["- **PR #10** feat: job board", "- **PR #12** docs: how to release"];
  const ok = { highlights: [`- Job board. ${link(10)}`], changes: [`- Job board. ${link(10)}`], record };
  assert.deepEqual(checkSection("2026.10.40.md", section("2026.10.40", ok)), [10, 12]);
  const refused = [
    [{ ...ok, changes: [`- How to release. ${link(12)}`] }, /belongs only in the record/],
    [{ ...ok, changes: [`- Something else. ${link(13)}`] }, /not in the record/],
    [{ ...ok, changes: ["- Job board, no link."] }, /links its pull request/],
    [{ ...ok, highlights: [] }, /at least one highlight/],
    [{ ...ok, highlights: Array(9).fill(`- Job board. ${link(10)}`) }, /at most 8 highlights/],
    [{ ...ok, record: [...record, "- **PR #10** feat: job board"] }, /in the record twice/],
  ];
  for (const [parts, reason] of refused) assert.throws(() => checkSection("2026.10.40.md", section("2026.10.40", parts)), reason);
  assert.throws(() => checkSection("2026.10.40.md", section("2026.10.41", ok)), /first line must be "## 2026.10.40"/);
  assert.throws(() => checkSection("2026.10.40.md", section("2026.10.40", ok).replace("2 pull requests", "3 pull requests")), /says how many/);
  assert.throws(() => checkSection("2026.10.40.md", section("2026.10.40", ok).replace("### Highlights", "### Notes")), /is not one of/);
  assert.throws(() => checkSection("2026.10.40.md", `## 2026.10.40\n\n### Changes\n\n- A. ${link(10)}\n\n### Highlights\n\n- A. ${link(10)}\n`), /out of order/);
  assert.throws(() => checkSection("Unreleased.md", section("Unreleased", ok)), /Unreleased has no record/);
  // A beta of a small hotfix needs no highlight.
  assert.deepEqual(checkSection("2026.10.40-beta.1.md", section("2026.10.40-beta.1", { ...ok, highlights: [] })), [10, 12]);
});

test("release notes keep the whole section, or the prose and a link when GitHub would refuse it", () => {
  const short = section("2026.10.40", { highlights: [`- Job board. ${link(10)}`], changes: [`- Job board. ${link(10)}`], record: ["- **PR #10** feat: job board"] });
  assert.equal(releaseNotes(short, "2026.10.40"), short);
  const long = short.replace("- **PR #10** feat: job board", `- **PR #10** feat: ${"x".repeat(130_000)}`);
  const notes = releaseNotes(long, "2026.10.40");
  assert.ok(notes.length < 2000);
  assert.match(notes, /### Highlights/);
  assert.match(notes, /blob\/v2026\.10\.40\/CHANGELOG\/2026\.10\.40\.md#complete-contribution-record/);
});

test("draft, write and verify work from a git history", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-changelog-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  const commit = (subject) => run("commit", "-q", "--allow-empty", "-m", subject);
  commit("chore: start (#1)");
  run("tag", "v2026.10.1");
  commit("feat: job board (#2)");
  commit("fix: sign-in loop (#3)");
  commit("chore: release 2026.10.2 (#4)");
  run("tag", "v2026.10.2");
  mkdirSync(join(dir, "CHANGELOG"));
  writeFileSync(join(dir, "CHANGELOG", "Unreleased.md"), "## Unreleased\n");

  const draft = main(["draft", "--version", "2026.10.2"], dir);
  assert.match(draft, /This record covers the complete v2026\.10\.1\.\.v2026\.10\.2 history: 3 pull requests\./);
  writeFileSync(join(dir, "draft.md"), draft);
  main(["write", "--version", "2026.10.2", "--file", join(dir, "draft.md")], dir);
  assert.equal(readFileSync(join(dir, "CHANGELOG", "2026.10.2.md"), "utf8"), draft);
  assert.match(main(["check"], dir), /follow the rules/);
  assert.match(main(["verify", "--version", "2026.10.2"], dir), /lists the 3 pull requests/);
  assert.equal(main(["read", "--version", "2026.10.2"], dir), draft);

  writeFileSync(join(dir, "CHANGELOG", "2026.10.2.md"), draft.replace(/- \*\*PR #3\*\*.*\n/, "").replace(/.*\[#3\].*\n/g, "").replace("3 pull requests", "2 pull requests"));
  assert.throws(() => main(["verify", "--version", "2026.10.2"], dir), /missing #3/);
  writeFileSync(join(dir, "CHANGELOG", "2026.10.9.md"), draft.replace("## 2026.10.2", "## 2026.10.9"));
  assert.throws(() => main(["check"], dir), /CHANGELOG.md is not the index/);
});
