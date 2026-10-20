// scripts/release/release-stable.mjs: the one-command stable release, with
// `gh` and `npm` replaced by a fake that answers from a table.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadState, parseArgs, PHASES, ReleaseRefusal, runReleaseStable } from "../scripts/release/release-stable.mjs";

const CUT = "c".repeat(40);
const HEAD = "d".repeat(40);
const REPO = "arcforgelabs/flow";

function options(extra = []) {
  return { ...parseArgs(["2026.10.40", ...extra]), stateDir: mkdtempSync(join(tmpdir(), "flow-release-stable-")) };
}

// A fake GitHub and npm. `world` changes as dispatched workflows "run".
function fake(world) {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args].join(" "));
    const path = args[1] ?? "";
    if (command === "npm") {
      if (args[1] === `@arcforgelabs/flow@2026.10.40`) return world.npm ? "2026.10.40\n" : fail();
      if (args[2] === "dist-tags.beta") return `${world.beta}\n`;
    }
    if (args[0] === "api") {
      if (path === "user") return JSON.stringify({ login: "agent" });
      if (path === `repos/${REPO}/branches/release%2F2026.10.40`) return world.branch ? JSON.stringify({ commit: { sha: HEAD } }) : fail();
      if (path.startsWith(`repos/${REPO}/actions/workflows/flow-full-release-validation.yml/runs?branch=main`)) return JSON.stringify({ workflow_runs: [{ head_sha: CUT }] });
      if (path.startsWith(`repos/${REPO}/actions/workflows/flow-full-release-validation.yml/runs?head_sha=${HEAD}`)) {
        return JSON.stringify({ workflow_runs: [{ id: 7, head_branch: "release/2026.10.40", status: "completed", conclusion: world.validation ?? "success", html_url: "v" }] });
      }
      if (path.startsWith(`repos/${REPO}/contents/CHANGELOG/2026.10.40.md?ref=notes`)) return "{}";
      if (path.startsWith(`repos/${REPO}/contents/CHANGELOG/2026.10.40.md?ref=main`)) return world.closedOut ? "{}" : fail();
      const runs = /actions\/workflows\/([\w.-]+)\/runs\?/.exec(path);
      if (runs) return JSON.stringify({ workflow_runs: world.runs[runs[1]] ?? [] });
      if (path === `repos/${REPO}/git/ref/tags/v2026.10.40`) return world.tagged ? "{}" : fail();
      if (path === `repos/${REPO}/releases/latest`) return JSON.stringify({ tag_name: "v2026.10.40" });
      if (path.startsWith(`repos/${REPO}/releases?`)) return JSON.stringify([{ id: 5, tag_name: "v2026.10.40", draft: false, prerelease: false }]);
      if (path.startsWith(`repos/${REPO}/pulls?head=arcforgelabs%3Arelease%2F2026.10.40-main-closeout`)) return JSON.stringify(world.pr ? [world.pr] : []);
      if (path.startsWith(`repos/${REPO}/commits/${"e".repeat(40)}/check-runs`)) {
        return JSON.stringify({ check_runs: ["test", "gitleaks"].map((name, id) => ({ id, name, app: { id: 15368 }, status: "completed", conclusion: "success" })) });
      }
    }
    if (args[0] === "api" && args[1] === "-X" && args[2] === "PUT") return "{}";
    const dispatched = /actions\/workflows\/([\w.-]+)\/dispatches$/.exec(args[3] ?? "");
    if (args[0] === "api" && dispatched) {
      const file = dispatched[1];
      world.runs[file] = [{ id: calls.length, actor: { login: "agent" }, status: "completed", conclusion: "success", display_title: file, html_url: file }];
      if (file === "flow-release-branch.yml") world.branch = true;
      if (file === "flow-release-prepare.yml") {
        world.tagged = true;
        world.npm = true;
        world.runs["flow-release-publish.yml"] = [{ id: 90, status: "completed", conclusion: "success", display_title: "flow v2026.10.40", html_url: "p" }];
        world.runs["flow-npm-release.yml"] = [{ id: 91, status: "completed", conclusion: "success", display_title: "flow npm v2026.10.40", html_url: "n" }];
      }
      return "";
    }
    throw new Error(`unexpected: ${command} ${args.join(" ")}`);
  };
  function fail() {
    const error = new Error("404");
    error.stderr = "HTTP 404";
    throw error;
  }
  return { exec, calls };
}

const quiet = { sleep: () => {}, log: () => {} };

test("the options name one stable version and full commit hashes", () => {
  assert.equal(parseArgs(["--help"]), null);
  assert.equal(parseArgs(["2026.10.40", "--from", "publish"]).from, "publish");
  assert.throws(() => parseArgs(["2026.10.40-beta.1"]), /not a calendar version/);
  assert.throws(() => parseArgs([]), /one stable version/);
  assert.throws(() => parseArgs(["2026.10.40", "--from", "macos"]), /Unknown phase macos/);
  assert.throws(() => parseArgs(["2026.10.40", "--cut-sha", "abc"]), /full lowercase commit hash/);
  assert.throws(() => parseArgs(["2026.10.40", "--notes-ref"]), /needs a value/);
  assert.throws(() => parseArgs(["2026.10.40", "--yes"]), /Unknown option --yes/);
  assert.equal(parseArgs(["2026.10.40"]).hold, false);
  assert.equal(parseArgs(["2026.10.40", "--hold"]).hold, true);
  assert.deepEqual(PHASES, ["cut", "validate", "publish", "flip-github", "sync-beta", "closeout"]);
});

test("the cut needs the notes, and prints how to write them at the newest validated main commit", () => {
  const world = { runs: {}, beta: "2026.10.39" };
  const { exec, calls } = fake(world);
  const opts = options();
  assert.throws(() => runReleaseStable(opts, { exec, ...quiet }), (error) => {
    assert.ok(error instanceof ReleaseRefusal);
    assert.match(error.message, new RegExp(`Write the 2026.10.40 notes at the cut ${CUT}`));
    assert.ok(error.next.some((line) => line.includes(`changelog.mjs draft --version 2026.10.40 --target ${CUT}`)));
    assert.ok(error.next.at(-1).includes("--notes-ref"));
    return true;
  });
  assert.deepEqual(calls.filter((call) => call.includes("/dispatches")), []);
  assert.equal(loadState(opts).cut.cutSha, CUT);
});

test("with --hold, the cut waits for the operator to confirm the newest validated main commit", () => {
  const world = { runs: {}, beta: "2026.10.39" };
  const { exec } = fake(world);
  const opts = options(["--hold"]);
  let refusal;
  try {
    runReleaseStable(opts, { exec, ...quiet });
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal instanceof ReleaseRefusal);
  assert.match(refusal.message, new RegExp(`Confirm the cut ${CUT}`));
  assert.ok(refusal.next.some((line) => line.includes(`changelog.mjs draft --version 2026.10.40 --target ${CUT}`)));
  assert.ok(refusal.next.at(-1).includes("--hold") && refusal.next.at(-1).includes(`--confirm-cut-sha ${CUT}`));
  const state = loadState(opts);
  assert.equal(state.phases.cut.status, "refused");
  assert.equal(state.cut.cutSha, CUT);
});

test("with the notes named, it runs every phase once with no stop, and a rerun does nothing again", () => {
  const world = { runs: {}, beta: "2026.10.40-beta.2", pr: { number: 12, html_url: "https://github.com/arcforgelabs/flow/pull/12", head: { sha: "e".repeat(40) } } };
  const { exec, calls } = fake(world);
  const opts = options(["--notes-ref", "notes"]);
  const state = runReleaseStable(opts, { exec, ...quiet });
  for (const phase of PHASES) assert.equal(state.phases[phase].status, "completed", phase);
  const dispatched = calls.filter((call) => call.includes("/dispatches"));
  const start = (file) => `gh api -X POST repos/${REPO}/actions/workflows/${file}/dispatches -f ref=main`;
  assert.deepEqual(dispatched, [
    `${start("flow-release-branch.yml")} -f inputs[operation]=cut -f inputs[version]=2026.10.40 -f inputs[commits]=${CUT} -f inputs[notes_ref]=notes`,
    `${start("flow-release-prepare.yml")} -f inputs[channel]=stable -f inputs[branch]=release/2026.10.40 -f inputs[commit]=${HEAD}`,
    `${start("flow-release-promote.yml")} -f inputs[tag]=v2026.10.40`,
  ]);
  assert.ok(calls.includes(`gh api -X PUT repos/${REPO}/pulls/12/merge -f merge_method=squash`));
  const again = fake(world);
  runReleaseStable(opts, { exec: again.exec, ...quiet });
  assert.deepEqual(again.calls.filter((call) => call.includes("/dispatches") || call.includes("/merge")), []);
});

test("with --hold, publication waits for approval; a failed validation stops the release", () => {
  const world = { runs: {}, beta: "2026.10.39", branch: true };
  const opts = options(["--hold"]);
  assert.throws(() => runReleaseStable(opts, { exec: fake(world).exec, ...quiet }), /Approve publishing v2026.10.40/);
  const failing = { ...world, validation: "failure" };
  assert.throws(() => runReleaseStable(options(), { exec: fake(failing).exec, ...quiet }), /Flow Full Release Validation of release\/2026.10.40 ended failure/);
});

test("a dry run prints the commands that change anything and runs none of them", () => {
  const world = { runs: {}, beta: "2026.10.39" };
  const { exec, calls } = fake(world);
  const printed = [];
  const original = console.log;
  console.log = (line) => printed.push(line);
  try {
    runReleaseStable(options(["--confirm-cut-sha", CUT, "--notes-ref", "notes", "--approve-publication", "--dry-run"]), { exec, ...quiet });
  } finally {
    console.log = original;
  }
  assert.deepEqual(calls.filter((call) => call.includes("/dispatches")), []);
  assert.ok(printed.some((line) => line.includes("flow-release-branch.yml/dispatches")));
  assert.ok(printed.some((line) => line.includes("flow-release-prepare.yml/dispatches")));
});
