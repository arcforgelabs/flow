// Manual synthetic proof for #428. Run from the repository after npm ci.
// node <this-file> <pinned-report-root> <proof-output-dir> [<repository-root>]
import { readFile, writeFile, mkdir, cp, symlink, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const [pinnedArg, outputArg, repoArg = process.cwd()] = process.argv.slice(2);
if (!pinnedArg || !outputArg) throw Error('Supply a pinned report root and a proof output directory.');
const pinned = resolve(pinnedArg), output = resolve(outputArg), repo = resolve(repoArg);
if ([pinned, output].some(p => p === repo || p.startsWith(repo + '/'))) throw Error('Use proof paths outside the repository.');
const require = createRequire(join(repo, 'package.json'));
const express = require('express'), { chromium } = require('@playwright/test');
const sha = 'f8e8431548b9f5730e495434bba6d2680e61e9bd';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(output, { recursive: true });
for (const file of ['scripts/report/render.mjs', 'scripts/report/site.html']) {
  const source = execFileSync('git', ['show', `${sha}:${file}`], { cwd: repo });
  const target = join(pinned, file); await mkdir(dirname(target), { recursive: true });
  if (await access(target).then(() => true, () => false)) {
    if (hash(await readFile(target)) !== hash(source)) throw Error('Existing pinned source differs. Use a fresh proof root.');
  } else await writeFile(target, source);
}
if (!await access(join(pinned, 'node_modules')).then(() => true, () => false)) await symlink(join(repo, 'node_modules'), join(pinned, 'node_modules'));
const names = ['xero-paid', 'reconcile-gap', 'xero-missing-client'];
const titles = ['Payments', 'Reconciliation', 'Create client'];
for (const name of names) {
  const target = join(pinned, 'docs/evidence/report-2026-10', name);
  await cp(join(repo, 'docs/evidence/report-2026-10', name), target, { recursive: true });
  await cp(join(repo, 'docs/evidence/report-2026-10/narration-review', `${name}.mp4`), join(target, 'narrated.mp4'));
}
const report = { title: 'Synthetic delivery proof', product: 'Flow', kind: 'Synthetic proof', lede: 'Synthetic walkthrough delivery check.',
  period: { from: '2026-10-28', today: '2026-10-28', label: '28 October 2026' }, days: [{ key: 'wed', axis: 'Wed' }], stats: [],
  ongoing: [{ key: 'security', icon: 'shield-check', name: 'Checks', result: 'Synthetic', does: 'Synthetic test only.', when: 'Today' }],
  ahead: { progress: [], planned: { label: 'Planned releases', note: 'Synthetic test only' } }, security: [], support: [],
  links: { repo: 'https://github.com/arcforgelabs/flow/' }, highlights: names,
  items: names.map((name, i) => ({ id: name, title: titles[i], icon: 'circle-play', day: 'wed', date: '2026-10-28', kind: 'new', status: 'Synthetic proof', prs: [],
    evidence: { clip: `ev/report-2026-10/${name}/narrated.mp4`, still: `ev/report-2026-10/${name}/desktop.jpg`, src: 'docs/evidence/report-2026-10', steps: ['Inspect this synthetic recording.'] } })) };
await writeFile(join(pinned, 'report.json'), JSON.stringify(report, null, 2));
execFileSync(process.execPath, ['scripts/report/render.mjs', '--report', 'report.json', '--out', 'out', '--site-url', 'http://127.0.0.1/site.html'], { cwd: pinned, stdio: 'inherit' });
const app = express(); app.use(express.static(join(pinned, 'out')));
const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const browser = await chromium.launch({ headless: true, executablePath: process.env.FLOW_BROWSER_EXECUTABLE || '/usr/bin/google-chrome' });
const proof = { reportSource: sha, client: await browser.version(), surface: 'Unchanged pinned report renderer and template, localhost Express static, synthetic report input and preserved synthetic narrated MP4 assets.',
  userDevice: 'NOT_ENOUGH_INFO', userAttachmentClient: 'NOT_ENOUGH_INFO', checks: [] };
try {
  for (const [label, viewport, isMobile] of [['desktop', { width: 1280, height: 800 }, false], ['phone-emulation', { width: 390, height: 800 }, true]]) {
    const context = await browser.newContext({ viewport, isMobile, hasTouch: isMobile, acceptDownloads: true });
    const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('https://fonts.googleapis.com/**', r => r.abort());
    const cdp = await context.newCDPSession(page);
    // Native media controls live in the browser's own shadow tree. Locate them by their observed accessible names.
    const clickNative = async (role, name) => {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      const node = nodes.find(n => n.role?.value === role && n.name?.value === name);
      if (!node) throw Error(`Native control absent: ${name}`);
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendDOMNodeId });
      const q = model.content; await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
    };
    for (const name of names) {
      await page.goto(`http://127.0.0.1:${server.address().port}/site.html?case=${name}#${name}`);
      const video = page.locator('video'); await video.waitFor(); await video.evaluate(v => v.play());
      await page.waitForFunction(() => document.querySelector('video')?.currentTime > 1);
      await page.waitForFunction(() => document.querySelector('video')?.ended, {}, { timeout: 35000 });
      const media = await video.evaluate(v => ({ duration: v.duration, currentTime: v.currentTime, ended: v.ended, error: v.error?.code ?? null, width: v.videoWidth, height: v.videoHeight, frames: v.webkitDecodedFrameCount, audioBytes: v.webkitAudioDecodedByteCount }));
      const box = await video.boundingBox(); await page.mouse.move(box.x + box.width - 18, box.y + box.height - 26);
      await clickNative('button', 'show more media controls'); await page.waitForTimeout(200);
      await page.screenshot({ path: join(output, `${name}-${label}.png`) });
      const pending = page.waitForEvent('download'); await clickNative('menuitem', 'download media');
      const download = await pending, saved = join(output, `${name}-${label}.mp4`); await download.saveAs(saved);
      const bytes = await readFile(saved), source = await readFile(join(pinned, 'docs/evidence/report-2026-10', name, 'narrated.mp4'));
      proof.checks.push({ name, label, viewport, isMobile, media, errors: [...errors], download: { control: 'Native Chrome media menu > Download', failure: await download.failure(), bytes: bytes.length, sha256: hash(bytes), sourceSha256: hash(source), identical: hash(bytes) === hash(source) } });
      await writeFile(join(output, 'report-delivery.json'), JSON.stringify(proof, null, 2));
    }
    await context.close();
  }
} catch (error) { proof.error = error.message; throw error; }
finally { await writeFile(join(output, 'report-delivery.json'), JSON.stringify(proof, null, 2)); await browser.close(); await new Promise(r => server.close(r)); }
if (proof.checks.length !== 6 || proof.checks.some(c => !c.media.ended || c.media.error || !c.media.audioBytes || c.errors.length || c.download.failure || !c.download.identical)) throw Error('A report delivery check failed.');
console.log('Passed: all three synthetic videos played to the end and downloaded with matching hashes at both viewports.');
