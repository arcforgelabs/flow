// Check the three synthetic evidence rows. Run from the repo root.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const started = performance.now();
const ids = ['r28', 'r35', 'r38'];
const index = JSON.parse(await readFile(new URL('index.json', root), 'utf8'));
assert.equal(new Set(index.map(row => row.id)).size, index.length);
const files = {};
for (const id of ids) {
  const row = index.find(row => row.id === id);
  assert.ok(row?.steps.length);
  for (const kind of ['clip', 'desktop', 'phone']) {
    assert.equal(row[kind], `${id}/${kind === 'clip' ? 'clip.webm' : kind + '.jpg'}`);
    const path = fileURLToPath(new URL(row[kind], root));
    const bytes = await readFile(path);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration,size:stream=width,height,codec_name', '-of', 'json', path], { encoding: 'utf8' }));
    const stream = probe.streams[0];
    assert.deepEqual([stream.width, stream.height], kind === 'phone' ? [390, 844] : [1280, 800]);
    assert.ok(bytes.length <= (kind === 'clip' ? 3_000_000 : 250_000));
    if (kind === 'clip') {
      assert.equal(stream.codec_name, 'vp9');
      assert.ok(Number(probe.format.duration) >= 10 && Number(probe.format.duration) <= 30);
      execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-']);
    } else assert.equal(stream.codec_name, 'mjpeg');
    files[row[kind]] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...stream,
      ...(kind === 'clip' ? { duration: Number(probe.format.duration), fullDecode: true } : {}) };
  }
}
const server = createServer(async (req, res) => {
  const key = req.url.slice(1);
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><title>Synthetic evidence playback</title><video muted></video>');
  }
  if (!files[key]) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', key.endsWith('.webm') ? 'video/webm' : 'image/jpeg');
  res.end(await readFile(new URL(key, root)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for (const id of ids) {
    const playback = await page.evaluate(async id => {
      const video = document.querySelector('video');
      video.src = `/${id}/clip.webm`;
      video.playbackRate = 4;
      const ended = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Playback did not end')), 30000);
        video.onended = () => { clearTimeout(timeout); resolve(); };
        video.onerror = () => { clearTimeout(timeout); reject(new Error('Video decode failed')); };
      });
      await video.play();
      await ended;
      return { ended: video.ended, width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames };
    }, id);
    assert.ok(playback.ended && playback.frames > 0);
    assert.deepEqual([playback.width, playback.height], [1280, 800]);
    files[`${id}/clip.webm`].chromiumPlayback = playback;
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
await writeFile(new URL('r35/validation.json', root), JSON.stringify({
  sourceCommit: 'a21b14acc9123f4e12b391df362b8b9f7c3f8909', synthetic: true,
  checkedAt: new Date().toISOString(), command: 'node docs/evidence/report-2026-10/r35/verify.mjs',
  workers: 1, wallSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
  checkedFiles: Object.keys(files).length, files,
}, null, 2) + '\n');
console.log('PASS: 3 indexed clips, 6 screenshots, full decoding and Chromium playback.');
