#!/usr/bin/env node
// Every dependency in package-lock.json must come from the public npm
// registry with an integrity hash. A git, file or http URL, or a missing
// hash, fails this check and names the package. The root entry is the
// project itself, so it has no resolved URL.
//
// Dependency review lists a new dependency with no licence and does not fail
// the job. --unlicensed reads that report from DEPENDENCY_REVIEW_LICENCES
// (JSON) and fails with the package name. An empty report means the pull
// request added no dependency.
//
//   node scripts/check-npm-lock.js [package-lock.json]
//   node scripts/check-npm-lock.js --unlicensed
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const NPM_REGISTRY = "https://registry.npmjs.org/";
const INTEGRITY = /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

export function dependencyName(path, entry) {
  if (typeof entry?.name === "string" && entry.name !== "") return entry.name;
  const marker = "node_modules/";
  const at = path.lastIndexOf(marker);
  return at >= 0 ? path.slice(at + marker.length) : path;
}

export function lockfileProblems(lock) {
  const packages = lock?.packages;
  if (packages == null || typeof packages !== "object" || Array.isArray(packages)) {
    return ["package-lock.json has no packages"];
  }
  const problems = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (path === "") continue;
    const name = dependencyName(path, entry);
    const resolved = entry?.resolved;
    if (typeof resolved !== "string" || !resolved.startsWith(NPM_REGISTRY)) {
      problems.push(`${name}: resolved URL is not ${NPM_REGISTRY}`);
    }
    const hashes = typeof entry?.integrity === "string" ? entry.integrity.trim().split(/\s+/).filter(Boolean) : [];
    if (hashes.length === 0 || hashes.some((hash) => !INTEGRITY.test(hash))) {
      problems.push(`${name}: missing integrity hash`);
    }
  }
  return problems;
}

export function unlicensedDependencyProblems(report) {
  if (report == null || report === "") return [];
  let data;
  try {
    data = typeof report === "string" ? JSON.parse(report) : report;
  } catch {
    return ["dependency review licence report is not JSON"];
  }
  if (!Array.isArray(data?.unlicensed)) return ["dependency review licence report has no unlicensed list"];
  return data.unlicensed.map((change) => {
    const name = typeof change?.name === "string" && change.name !== "" ? change.name : "unknown";
    const version = typeof change?.version === "string" && change.version !== "" ? `@${change.version}` : "";
    return `${name}${version}: no licence`;
  });
}

function report(problems) {
  for (const problem of problems) console.error(problem);
  return problems.length === 0 ? 0 : 1;
}

export function main(argv, env) {
  if (argv.includes("--unlicensed")) return report(unlicensedDependencyProblems(env.DEPENDENCY_REVIEW_LICENCES ?? ""));
  const file = resolve(argv.find((arg) => !arg.startsWith("-")) || "package-lock.json");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`could not read ${file}`);
    return 1;
  }
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    console.error(`${file} is not JSON`);
    return 1;
  }
  return report(lockfileProblems(lock));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exit(main(process.argv.slice(2), process.env));
}
