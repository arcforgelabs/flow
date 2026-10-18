#!/usr/bin/env node
// Starts Flow from an installed @arcforgelabs/flow package (the `flow-server`
// command). A published package's version is its release (2026.10.18 or
// 2026.10.18-beta.2), so GET /health shows it as build.release. A checkout
// starts server/index.js (`npm start`) instead: its package.json holds the
// upcoming version, which is not a release yet.
import { readFileSync } from 'node:fs';
import { parseReleaseTag } from './release-channel.js';

if (!process.env.FLOW_RELEASE) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const release = parseReleaseTag(version);
  if (release) process.env.FLOW_RELEASE = release.tag;
}
await import('./index.js');
