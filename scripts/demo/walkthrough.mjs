#!/usr/bin/env node
// Screen recording of the synthetic Flow harness. No live integration credentials.
import { readFile, mkdir, mkdtemp, writeFile, rename, rm, access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { startFlow } from '../../test/mobile/server.js';
import { clerkBrowserStub } from '../../test/support/clerk.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/demo/walkthrough.mjs <shots.json> <out>');
const shots = JSON.parse(await readFile(input, 'utf8'));
if (!/^[a-z0-9-]+$/.test(shots.seed) || !shots.start?.startsWith('/') || shots.start.startsWith('//')) throw new Error('Use a named synthetic seed and a local start path.');
const actions = new Set(['hover', 'click', 'type', 'press', 'scroll', 'wait']);
if (!Array.isArray(shots.steps) || !shots.steps.length || shots.steps.some(s => !actions.has(s.do))) throw new Error('Unknown or empty shot list.');
const out = resolve(output);
for (const suffix of ['.mp4', '.webm', '.json', '-frames']) {
  if (await access(out + suffix).then(() => true, () => false)) throw new Error('Output exists; choose a new take name.');
}
await mkdir(dirname(out), { recursive: true });
const temp = await mkdtemp(join(dirname(out), '.take-'));
let flow, browser, xvfb, recording;
const completed = [];
const processDone = child => new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Recording process exited ${code}`)));
});
async function ffmpeg(args) {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
  await processDone(child);
}
try {
  xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const display = await Promise.race([
    once(xvfb.stdout, 'data').then(([data]) => `:${String(data).trim()}`),
    once(xvfb, 'error').then(([e]) => { throw e; }),
    pause(10000).then(() => { throw new Error('Xvfb did not start'); }),
  ]);
  flow = await startFlow({ env: {} }); // shipped Xero/Seazona adapters stay off
  const { default: seed } = await import(`./seeds/${shots.seed}.mjs`);
  await seed(flow);
  browser = await chromium.launch({ headless: false, env: { ...process.env, DISPLAY: display }, args: ['--window-size=1280,800', '--window-position=0,0', '--kiosk'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const [project, token] = Object.entries(flow.tokens)[0];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === flow.url) return route.continue();
    if (url.origin === 'https://clerk.example.test') return route.fulfill({ contentType: 'text/javascript', body: url.pathname.endsWith('clerk.browser.js') ? clerkBrowserStub({ token, email: `owner-${project}@example.test`, name: 'Synthetic owner' }) : '' });
    return route.abort();
  });
  await context.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      const cursor = document.createElement('div');
      cursor.id = 'walkthrough-cursor';
      cursor.style.cssText = 'position:fixed;left:80px;top:80px;width:14px;height:14px;border:2px solid white;border-radius:50%;background:black;z-index:2147483647;pointer-events:none;box-shadow:0 0 2px black';
      document.documentElement.append(cursor);
      addEventListener('mousemove', e => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px`; });
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(flow.url + shots.start);
  await page.waitForLoadState('networkidle');
  await page.mouse.move(80, 80);
  recording = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-video_size', '1280x800', '-framerate', '30', '-draw_mouse', '0', '-i', display, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(temp, 'clip.mp4')], { stdio: ['pipe', 'ignore', 'inherit'] });
  const recorded = processDone(recording);
  recorded.catch(() => {});
  await pause(500);
  const started = performance.now();
  let position = { x: 80, y: 80 };
  for (const step of shots.steps) {
    const start = (performance.now() - started) / 1000 + 0.5;
    let target;
    if (step.target) {
      target = page.locator(step.target);
      await target.waitFor({ state: 'visible' });
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      const next = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      for (let n = 1; n <= 20; n++) {
        const ease = (1 - Math.cos(Math.PI * n / 20)) / 2;
        await page.mouse.move(position.x + (next.x - position.x) * ease, position.y + (next.y - position.y) * ease);
        await pause(20);
      }
      position = next;
      await pause(400);
    }
    if (step.do === 'click') { if (!target) throw new Error('click needs target'); await page.mouse.click(position.x, position.y); }
    if (step.do === 'type') {
      if (!target) throw new Error('type needs target');
      await page.mouse.click(position.x, position.y);
      // Search can redraw and lose focus after each key. Reacquire, then append.
      for (const character of step.text) {
        await target.press('End');
        await target.pressSequentially(character, { delay: 50 });
      }
    }
    if (step.do === 'press') await page.keyboard.press(step.key);
    if (step.do === 'scroll') await page.mouse.wheel(0, step.dy ?? 400);
    if (step.do === 'wait') await pause(Math.min(1500, Math.max(0, step.ms ?? 1000)));
    if (step.expect) await page.locator(step.expect).waitFor({ state: 'visible' });
    if (step.expectHidden) await page.locator(step.expectHidden).waitFor({ state: 'hidden' });
    await pause(Math.min(1500, Math.max(1000, step.hold ?? 1200)));
    if (context.pages().length !== 1) throw new Error('A take must use one tab');
    completed.push({ ...step, start, end: (performance.now() - started) / 1000 + 0.5 });
  }
  const duration = (performance.now() - started) / 1000 + 0.5;
  if (duration < 15 || duration > 45) throw new Error(`Take duration ${duration.toFixed(1)}s is outside 15–45s; adjust the shot list.`);
  recording.stdin.write('q');
  await recorded;
  recording = null;
  await ffmpeg(['-i', join(temp, 'clip.mp4'), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '35', join(temp, 'clip.webm')]);
  await mkdir(join(temp, 'frames'));
  for (const [index, step] of completed.entries()) await ffmpeg(['-ss', String(Math.max(0, step.end - 0.1)), '-i', join(temp, 'clip.mp4'), '-frames:v', '1', join(temp, 'frames', `${String(index + 1).padStart(2, '0')}.png`)]);
  await writeFile(join(temp, 'timing.json'), JSON.stringify({ title: shots.title, synthetic: true, viewport: { width: 1280, height: 800 }, duration, steps: completed }, null, 2));
  for (const [source, suffix] of [['clip.mp4', '.mp4'], ['clip.webm', '.webm'], ['timing.json', '.json'], ['frames', '-frames']]) await rename(join(temp, source), out + suffix);
  console.log('Saved synthetic take, timings and frames.');
} catch (error) {
  console.error(`Take discarded: ${error.message}`);
  process.exitCode = 1;
} finally {
  recording?.kill('SIGKILL');
  await browser?.close();
  await flow?.close();
  xvfb?.kill();
  await rm(temp, { recursive: true, force: true });
}
