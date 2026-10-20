// Release jobs build from the tag, never from a commit passed between jobs:
// the checks prove the tag's commit is on its release branch, and each later job checks out
// the tag again and fails if it now points anywhere else. A checkout of a
// job output is code the workflow cannot show was reviewed (CodeQL
// actions/cache-poisoning/poisonable-step).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKFLOWS = resolve(import.meta.dirname, "../.github/workflows");
const releaseWorkflows = readdirSync(WORKFLOWS).filter((name) => /^flow-.*release.*\.yml$/.test(name));

function steps(name) {
  return readFileSync(join(WORKFLOWS, name), "utf8").split(/\n(?=[ \t]+- name: )/).slice(1);
}

function title(step) {
  return step.trim().split("\n")[0];
}

test("no release job checks out a ref taken from another job's output", () => {
  assert.deepEqual(releaseWorkflows.sort(), [
    "flow-full-release-validation.yml",
    "flow-npm-release.yml",
    "flow-release-branch.yml",
    "flow-release-checks.yml",
    "flow-release-closeout.yml",
    "flow-release-prepare.yml",
    "flow-release-promote.yml",
    "flow-release-publish.yml",
  ]);
  for (const name of releaseWorkflows) {
    for (const step of steps(name).filter((s) => /uses: actions\/checkout@/.test(s))) {
      assert.doesNotMatch(step, /^\s*ref:\s*\$\{\{\s*needs\./m, `${name}: "${title(step)}" checks out a job output`);
    }
  }
});

test("a job that checks out the tag after the checks then requires the commit they proved", () => {
  for (const name of releaseWorkflows) {
    const all = steps(name);
    all.forEach((step, index) => {
      if (!/uses: actions\/checkout@/.test(step) || !/ref: refs\/tags\/\$\{\{ inputs\.tag \}\}/.test(step)) return;
      // The resolve job's own checkout is the one that proves the commit.
      if (title(step) === "- name: Check out the tag") return;
      const next = all[index + 1] || "";
      assert.match(next, /RESOLVED: \$\{\{ needs\.\w+\.outputs\.commit \}\}/, `${name}: the step after "${title(step)}" names the proved commit`);
      assert.match(next, /"\$head" != "\$RESOLVED"/, `${name}: the step after "${title(step)}" compares HEAD with it`);
    });
  }
});

test("no release workflow names Field", () => {
  for (const name of releaseWorkflows) {
    assert.doesNotMatch(readFileSync(join(WORKFLOWS, name), "utf8"), /field-|FIELD_|arcforgelabs\/field|"field |Field /, name);
  }
});

const workflow = (name) => readFileSync(join(WORKFLOWS, name), "utf8");

test("every release workflow that changes anything runs only from main", () => {
  for (const name of ["flow-release-branch.yml", "flow-release-prepare.yml", "flow-release-publish.yml", "flow-npm-release.yml", "flow-release-promote.yml", "flow-release-closeout.yml"]) {
    assert.match(workflow(name), /- name: Require the workflow from main\n\s+if: github\.ref != 'refs\/heads\/main'/, name);
  }
});

test("main is validated every 3 hours, and Prepare tags only a commit on a release branch that the validation proved", () => {
  assert.match(workflow("flow-full-release-validation.yml"), /cron: "7 \*\/3 \* \* \*"/);
  const prepare = workflow("flow-release-prepare.yml");
  assert.match(prepare, /is not on \$\{BRANCH\}\. Only commits on a release branch are released\./);
  assert.ok(prepare.indexOf("require-validation.mjs") < prepare.indexOf("- name: Create the signed tag"));
  assert.match(workflow("flow-release-checks.yml"), /Only release-branch commits are released\./);
});

test("release tags are signed when created and verified before anything is checked out", () => {
  const prepare = workflow("flow-release-prepare.yml");
  assert.match(prepare, /git tag --sign "\$TAG"/);
  assert.match(prepare, /git tag --verify "\$TAG"/);
  assert.doesNotMatch(prepare, /git tag --annotate/);
  const checks = steps("flow-release-checks.yml");
  const verify = checks.findIndex((step) => title(step) === "- name: Require a signed release tag");
  const checkout = checks.findIndex((step) => /uses: actions\/checkout@/.test(step));
  assert.ok(verify >= 0 && verify < checkout, "the signature is verified before the first checkout");
  assert.match(checks[verify], /\.verification\.verified/);
});

test("blocker fixes reach a release branch only as -x cherry-picks of main commits", () => {
  const branch = workflow("flow-release-branch.yml");
  assert.match(branch, /git cherry-pick -x "\$commit"/);
  assert.match(branch, /is not on main\. A fix merges to main first, then comes here\./);
  assert.match(branch, /already exists\. A second cut on newer main needs the maintainer's word/);
});

test("a stable release is closed out on main after npm is verified, and the GitHub Release is public only then", () => {
  const npm = workflow("flow-npm-release.yml");
  assert.match(npm, /gh workflow run flow-release-closeout\.yml/);
  assert.match(npm, /--draft=false/);
  assert.match(workflow("flow-release-publish.yml"), /--verify-tag --draft/);
  assert.match(workflow("flow-release-closeout.yml"), /chore\(release\): close out \$\{VERSION\} on main/);
});

test("the release workflows accept correction tags", () => {
  for (const name of ["flow-release-publish.yml", "flow-npm-release.yml", "flow-release-promote.yml"]) {
    assert.match(workflow(name), /vYYYY\.M\.N-C/, name);
  }
});
