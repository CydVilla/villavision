#!/usr/bin/env node
// Prepares a movie file for streaming: npm run add -- "/path/to/Movie.mkv" ["Title"]
// Makes an adaptive HLS stream (full quality + a light 480p version for slow
// connections) and pulls out any text subtitles. The original is not modified.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}
const MEDIA = path.resolve(process.env.MEDIA_DIR || path.join(ROOT, 'media'));

if (spawnSync('ffmpeg', ['-version']).error) {
  console.error('ffmpeg was not found. Install it first (macOS: brew install ffmpeg, Windows: winget install ffmpeg, Linux: sudo apt install ffmpeg).');
  process.exit(1);
}
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [input, titleArg] = args.filter((a) => !a.startsWith('--'));
if (!input || !fs.existsSync(input)) {
  console.error('Usage: npm run add -- "/path/to/Movie.mkv" ["Title"] [--software] [--audio=N]');
  process.exit(1);
}
// Apple's hardware encoder is fast; everywhere else (or with --software) use x264.
const hasVT = process.platform === 'darwin' && execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString().includes('h264_videotoolbox');
const software = flags.has('--software') || !hasVT;
const audioIdx = Number([...flags].find((f) => f.startsWith('--audio='))?.split('=')[1] || 0);

const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input], { maxBuffer: 1 << 26 }).toString());
const video = probe.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
const audios = probe.streams.filter((s) => s.codec_type === 'audio');
const subs = probe.streams.filter((s) => s.codec_type === 'subtitle');
if (!video) { console.error('No video stream found in that file.'); process.exit(1); }
const duration = Number(probe.format.duration);
const title = titleArg || path.basename(input, path.extname(input)).replace(/[._]+/g, ' ').trim();
const id = (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'movie') + '-' + crypto.randomBytes(3).toString('hex');
const out = path.join(MEDIA, id);
fs.mkdirSync(out, { recursive: true });

if (audios.length > 1) {
  console.log('Audio tracks (pick another with --audio=N):');
  audios.forEach((a, i) => console.log(`  ${i === audioIdx ? '*' : ' '} ${i}: ${a.tags?.language || 'und'} ${a.tags?.title || ''} (${a.codec_name}, ${a.channels}ch)`));
}

const topH = Math.min(video.height, 1080);
const rates = (h) => (h >= 1000 ? [5000, 6000] : h >= 700 ? [3000, 3600] : h >= 500 ? [1200, 1500] : [800, 1000]);
const ladder = [topH, ...(topH > 540 ? [480] : [])];
const hasAudio = audios.length > 0;

const fc = `[0:v:${probe.streams.filter((s) => s.codec_type === 'video').indexOf(video)}]format=yuv420p,split=${ladder.length}${ladder.map((_, i) => `[s${i}]`).join('')};` +
  ladder.map((h, i) => `[s${i}]scale=-2:${h - (h % 2)}[v${i}]`).join(';');
const ff = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-i', input, '-filter_complex', fc];
ladder.forEach((h, i) => {
  const [b, max] = rates(h);
  ff.push('-map', `[v${i}]`);
  if (hasAudio) ff.push('-map', `0:a:${audioIdx}`);
  ff.push(`-b:v:${i}`, `${b}k`, `-maxrate:v:${i}`, `${max}k`, `-bufsize:v:${i}`, `${max * 2}k`);
});
ff.push('-c:v', software ? 'libx264' : 'h264_videotoolbox');
if (software) ff.push('-preset', 'veryfast');
ff.push('-profile:v', 'high', '-force_key_frames', 'expr:gte(t,n_forced*4)');
if (hasAudio) ff.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
ff.push('-sn', '-dn', '-map_chapters', '-1', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
  '-hls_segment_filename', path.join(out, 'v%v', 'seg_%05d.ts'), '-master_pl_name', 'master.m3u8',
  '-var_stream_map', ladder.map((_, i) => (hasAudio ? `v:${i},a:${i}` : `v:${i}`)).join(' '), path.join(out, 'v%v', 'index.m3u8'));

console.log(`Preparing "${title}" (${Math.round(duration / 60)} min, ${video.width}x${video.height}) -> ${ladder.map((h) => h + 'p').join(' + ')}${software ? ' [software encoder]' : ''}`);
await new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', ff, { stdio: ['ignore', 'pipe', 'inherit'] });
  let last = -1;
  p.stdout.on('data', (d) => {
    const m = /out_time_(?:us|ms)=(\d+)/.exec(d.toString());
    if (!m) return;
    const pct = Math.min(100, Math.floor((Number(m[1]) / 1e6 / duration) * 100));
    if (pct !== last) { last = pct; process.stdout.write(`\r  ${pct}%   `); }
  });
  p.on('error', reject);
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
}).catch((e) => { console.error('\n' + e.message); fs.rmSync(out, { recursive: true, force: true }); process.exit(1); });
process.stdout.write('\r  100%\n');

// Subtitles: embedded text tracks, plus .srt/.vtt files sitting next to the movie.
const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const subOut = [];
const toVtt = (ffArgs, file) => { try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...ffArgs, '-c:s', 'webvtt', path.join(out, file)]); return fs.statSync(path.join(out, file)).size > 10; } catch { return false; } };
subs.forEach((s, i) => {
  if (!TEXT_SUBS.has(s.codec_name)) return;
  const lang = s.tags?.language || 'und';
  if (toVtt(['-i', input, '-map', `0:s:${i}`], `sub_${i}.vtt`)) subOut.push({ file: `sub_${i}.vtt`, lang, label: s.tags?.title || lang.toUpperCase() });
});
const base = path.basename(input, path.extname(input));
for (const f of fs.readdirSync(path.dirname(path.resolve(input)))) {
  const m = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\.([A-Za-z-]{2,8}))?\\.(srt|vtt)$').exec(f);
  if (!m) continue;
  const file = `side_${subOut.length}.vtt`;
  if (toVtt(['-i', path.join(path.dirname(path.resolve(input)), f)], file)) subOut.push({ file, lang: m[1] || 'und', label: (m[1] || 'Subtitles').toUpperCase() });
}
const skipped = subs.filter((s) => !TEXT_SUBS.has(s.codec_name)).length;
if (skipped) console.log(`  Note: ${skipped} picture-based subtitle track(s) (e.g. Blu-ray/DVD style) can't be converted and were skipped.`);

fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ id, title, duration, width: video.width, height: topH, subs: subOut, createdAt: Date.now() }, null, 2));
console.log(`Done. "${title}" is in your library${subOut.length ? ` with ${subOut.length} subtitle track(s)` : ''}. Open your host page to start a theatre.`);
