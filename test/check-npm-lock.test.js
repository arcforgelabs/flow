// scripts/check-npm-lock.js: package-lock.json dependencies come from the
// public npm registry with an integrity hash, and a new dependency with no
// licence fails the supply-chain check.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NPM_REGISTRY, dependencyName, lockfileProblems, unlicensedDependencyProblems } from "../scripts/check-npm-lock.js";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts/check-npm-lock.js");
const HASH = `sha512-${"A".repeat(86)}==`;

const registry = (name, extra = {}) => ({
  name,
  version: "1.0.0",
  resolved: `${NPM_REGISTRY}${name}/-/${name}-1.0.0.tgz`,
  integrity: HASH,
  ...extra,
});

function problemsFor(packages) {
  return lockfileProblems({ lockfileVersion: 3, packages: { "": { name: "app" }, ...packages } });
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("the repository lock file passes", () => {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  assert.deepEqual(lockfileProblems(lock), []);
  const result = run([join(ROOT, "package-lock.json")]);
  assert.equal(result.status, 0, result.stderr);
});

test("a dependency name comes from the lock entry, then the path", () => {
  assert.equal(dependencyName("node_modules/@scope/pkg", { name: "@scope/pkg" }), "@scope/pkg");
  assert.equal(dependencyName("node_modules/a/node_modules/b", {}), "b");
});

test("a git, file or http URL fails with the package name", () => {
  const cases = [
    ["git-dep", "git+https://github.com/example/git-dep.git"],
    ["file-dep", "file:../file-dep"],
    ["http-dep", "http://registry.npmjs.org/http-dep/-/http-dep-1.0.0.tgz"],
    ["other-host", "https://registry.yarnpkg.com/other-host/-/other-host-1.0.0.tgz"],
  ];
  for (const [name, resolved] of cases) {
    const problems = problemsFor({ [`node_modules/${name}`]: registry(name, { resolved }) });
    assert.deepEqual(problems, [`${name}: resolved URL is not ${NPM_REGISTRY}`], name);
  }
});

test("a missing integrity hash fails with the package name", () => {
  const problems = problemsFor({
    "node_modules/bare": registry("bare", { integrity: undefined }),
    "node_modules/weak": registry("weak", { integrity: "none" }),
  });
  assert.deepEqual(problems, ["bare: missing integrity hash", "weak: missing integrity hash"]);
});

test("a linked package is not a registry dependency", () => {
  const problems = problemsFor({ "node_modules/local": { name: "local", link: true } });
  assert.ok(problems.some((problem) => problem.startsWith("local:")));
});

test("the root package needs no resolved URL", () => {
  assert.deepEqual(lockfileProblems({ packages: { "": { name: "app", version: "1.0.0" } } }), []);
});

test("a lock file with no packages map fails", () => {
  assert.deepEqual(lockfileProblems({}), ["package-lock.json has no packages"]);
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const file = join(dir, "package-lock.json");
  writeFileSync(file, "{");
  const result = run([file]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not JSON/);
});

test("a new dependency with no licence fails with its name", () => {
  const report = { unlicensed: [{ name: "left-pad", version: "1.2.3" }], unresolved: [], forbidden: [] };
  assert.deepEqual(unlicensedDependencyProblems(report), ["left-pad@1.2.3: no licence"]);
  const result = run(["--unlicensed"], { DEPENDENCY_REVIEW_LICENCES: JSON.stringify(report) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /left-pad@1\.2\.3: no licence/);
});

test("no new dependency, and an empty unlicensed list, pass", () => {
  assert.deepEqual(unlicensedDependencyProblems(""), []);
  assert.deepEqual(unlicensedDependencyProblems({ unlicensed: [] }), []);
  const empty = run(["--unlicensed"], { DEPENDENCY_REVIEW_LICENCES: "" });
  assert.equal(empty.status, 0, empty.stderr);
  const none = run(["--unlicensed"], { DEPENDENCY_REVIEW_LICENCES: JSON.stringify({ unlicensed: [], unresolved: [], forbidden: [] }) });
  assert.equal(none.status, 0, none.stderr);
});

test("a licence report that is not the action's shape fails", () => {
  assert.deepEqual(unlicensedDependencyProblems("nope"), ["dependency review licence report is not JSON"]);
  assert.deepEqual(unlicensedDependencyProblems({}), ["dependency review licence report has no unlicensed list"]);
});

test("the supply-chain workflow pins its actions and fails closed", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/supply-chain.yml"), "utf8");
  assert.match(workflow, /^name: Supply Chain\n/m);
  assert.match(workflow, /permissions:\n {2}contents: read\n/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm audit signatures/);
  assert.match(workflow, /fail-on-severity: high/);
  assert.match(workflow, /fail-on-scopes: runtime, development, unknown/);
  assert.match(workflow, /check-npm-lock\.js --unlicensed/);
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
  assert.ok(uses.length >= 3);
  for (const use of uses) assert.match(use, /@[0-9a-f]{40}$/, use);
  assert.doesNotMatch(workflow, /pull-requests: write/);
});

test("dependabot waits before proposing a just-published version", () => {
  const config = readFileSync(join(ROOT, ".github/dependabot.yml"), "utf8");
  const blocks = config.split(/\n {2}- package-ecosystem:/).slice(1);
  assert.equal(blocks.length, 2);
  for (const block of blocks) assert.match(block, /default-days: 3/);
  // semver-*-days is for semver package ecosystems; Dependabot rejects the
  // whole file when github-actions has it.
  const [npm, actions] = blocks;
  assert.match(npm, /^ npm\b/);
  assert.match(npm, /semver-major-days: 7/);
  assert.match(actions, /^ github-actions\b/);
  assert.doesNotMatch(actions, /semver-\w+-days/);
});
