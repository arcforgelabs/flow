#!/usr/bin/env node
// Starts Flow from an installed @arcforgelabs/flow package (the `flow-server`
// command). A published package's version is its release (2026.10.18 or
// 2026.10.18-beta.2), so GET /health shows it as build.release. A checkout
// starts server/index.js (`npm start`) instead: its package.json holds the
// upcoming version, which is not a release yet.
//
//   flow-server                          start Flow
//   flow-server migrate                  bring DATABASE_URL up to this build
//                                        (Flow's tables and every shipped
//                                        adapter's), then stop
//   flow-server doctor [--live <origin>] [--json]
//                                        check DATABASE_URL against this build,
//                                        and with --live, against the live
//                                        app's GET /health (server/db/doctor.js);
//                                        exit 1 when it is not at this build
import { readFileSync } from 'node:fs';
import { parseReleaseTag } from './release-channel.js';

if (!process.env.FLOW_RELEASE) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const release = parseReleaseTag(version);
  if (release) process.env.FLOW_RELEASE = release.tag;
}
const [command, ...args] = process.argv.slice(2);
if (command === 'migrate' || command === 'doctor') {
  const { runCommand } = await import('./db/commands.js');
  process.exitCode = await runCommand(command, args);
} else if (command) {
  console.error(`flow-server: unknown command '${command}'. Use: flow-server, flow-server migrate, flow-server doctor`);
  process.exitCode = 2;
} else {
  await import('./index.js');
}
