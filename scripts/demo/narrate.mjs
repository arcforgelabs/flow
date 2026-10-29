#!/usr/bin/env node
// Generate timed speech and mux it into an existing synthetic walkthrough.
import { readFile, writeFile, mkdir, mkdtemp, rm, access, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile);
const [timingFile, scriptFile, output] = process.argv.slice(2);
if (!timingFile || !scriptFile || !output) throw new Error('Usage: node scripts/demo/narrate.mjs <take.json> <script.json> <out>');
const profile = JSON.parse(await readFile(new URL('./narration/voice.json', import.meta.url), 'utf8'));
const token = process.env[profile.tokenVariable];
if (!token) throw new Error(`Configure ${profile.tokenVariable} in the cloud environment before generating speech.`);
const timing = JSON.parse(await readFile(timingFile, 'utf8'));
const script = JSON.parse(await readFile(scriptFile, 'utf8'));
if (!timing.synthetic) throw new Error('This workflow accepts synthetic walkthroughs only.');
const source = /[/\\]timing\.json$/.test(timingFile)
  ? join(dirname(resolve(timingFile)), 'clip')
  : resolve(timingFile).replace(/\.json$/, '');
const out = resolve(output);
for (const suffix of ['.mp4', '.webm', '.wav', '.narration.json']) {
  if (await access(out + suffix).then(() => true, () => false)) throw new Error('Output exists; use a new narration take name.');
}
// Validate every cue before spending an API request.
let previousEnd = 0;
const cues = script.cues.map(cue => {
  const first = timing.steps[cue.step - 1], last = timing.steps[(cue.through ?? cue.step) - 1];
  if (!first || !last || last.end <= first.start || first.start < previousEnd || !cue.text?.trim()) throw new Error('Narration cues must name valid, ordered, non-overlapping step ranges.');
  previousEnd = last.end;
  return { ...cue, start: first.start, limit: last.end };
});
if (!cues.length) throw new Error('Supply at least one narration cue.');
await mkdir(dirname(out), { recursive: true });
const temp = await mkdtemp(join(dirname(out), '.narration-'));
try {
  const inputs = ['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono'];
  const filters = [], tracks = ['[0:a]'];
  for (const [i, cue] of cues.entries()) {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: profile.model, voice: profile.voice, instructions: profile.instructions, speed: profile.speed, input: cue.text, response_format: 'wav' }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Speech API returned ${response.status}. Check the key's text-to-speech permission, project access and quota.`);
    const audio = Buffer.from(await response.arrayBuffer());
    const path = join(temp, `cue-${i}.wav`);
    await writeFile(path, audio);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path]);
    const duration = Number(JSON.parse(stdout).format.duration);
    if (!Number.isFinite(duration) || duration <= 0 || cue.start + duration > cue.limit - 0.1) throw new Error(`Cue ${i + 1} does not fit its step range. Shorten its script or lengthen the shot hold; speech is never clipped or sped up.`);
    cue.end = cue.start + duration;
    cue.audioSha256 = createHash('sha256').update(audio).digest('hex');
    inputs.push('-i', path);
    filters.push(`[${i + 1}:a]adelay=${Math.round(cue.start * 1000)}:all=1[cue${i}]`);
    tracks.push(`[cue${i}]`);
  }
  filters.push(`${tracks.join('')}amix=inputs=${tracks.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[mix]`);
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filters.join(';'), '-map', '[mix]', '-t', String(timing.duration), '-c:a', 'pcm_s16le', join(temp, 'narration.wav')]);
  for (const [ext, codec] of [['mp4', 'aac'], ['webm', 'libopus']]) {
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', source + '.' + ext, '-i', join(temp, 'narration.wav'), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', codec, '-t', String(timing.duration), ...(ext === 'mp4' ? ['-movflags', '+faststart'] : []), join(temp, 'clip.' + ext)]);
  }
  await writeFile(join(temp, 'manifest.json'), JSON.stringify({ disclosure: profile.disclosure, profile, timingSha256: createHash('sha256').update(await readFile(timingFile)).digest('hex'), cues }, null, 2));
  for (const [file, suffix] of [['clip.mp4', '.mp4'], ['clip.webm', '.webm'], ['narration.wav', '.wav'], ['manifest.json', '.narration.json']]) await rename(join(temp, file), out + suffix);
  console.log('Saved narrated videos, audio and voice-profile manifest.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
