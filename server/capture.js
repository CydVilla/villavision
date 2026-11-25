// Villavisión's own screen capture, OBS-style: the host computer records a
// screen or a single window (and optionally sound) and writes a short rolling
// live stream that the theatre plays on the big screen. No browser picker.
//
// macOS: a small helper built from native/vv-capture.swift uses
//   ScreenCaptureKit, which can capture one window and the computer's sound.
//   Without the helper (no Swift compiler) ffmpeg captures whole screens.
// Windows: ffmpeg gdigrab (desktop, or one window by title).
// Linux: ffmpeg x11grab (whole X11 display).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PLAYLIST = 'live.m3u8';
export const LIVE_FILE = /^(live\.m3u8|v\d\.m3u8|s\d_\d{1,9}\.ts)$/;
const SEGMENT_SECONDS = 2;
const FPS = 30;
const HELPER_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native', 'vv-capture.swift');

const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ ok: !error, missing: error?.code === 'ENOENT', text: `${stdout || ''}\n${stderr || ''}`, stdout: stdout || '' });
  });
});

// ---------- the macOS helper ----------
// helper.state: 'off' (not macOS), 'building', 'ready', 'no_swift', 'failed'.
const helper = { state: 'off', path: null };

// Compiles the helper in the background, once per version of its source.
export function prepareHelper(dataDir) {
  if (process.platform !== 'darwin' || helper.state !== 'off') return;
  helper.state = 'building';
  const bin = path.join(dataDir, 'bin');
  const stamp = crypto.createHash('sha256').update(fs.readFileSync(HELPER_SOURCE)).digest('hex').slice(0, 16);
  const out = path.join(bin, `vv-capture-${stamp}`);
  if (fs.existsSync(out)) { helper.path = out; helper.state = 'ready'; return; }
  fs.mkdirSync(bin, { recursive: true });
  for (const old of fs.readdirSync(bin)) if (old.startsWith('vv-capture')) fs.rmSync(path.join(bin, old), { force: true });
  const tmp = `${out}.tmp`;
  execFile('swiftc', ['-O', '-swift-version', '5', HELPER_SOURCE, '-o', tmp], { timeout: 300000 }, (error, _out, stderr) => {
    if (error) {
      helper.state = error.code === 'ENOENT' || /xcode-select|no developer tools/i.test(String(stderr)) ? 'no_swift' : 'failed';
      if (helper.state === 'failed') console.warn('  ! Could not build the window capture helper:\n' + String(stderr).split('\n').slice(0, 6).join('\n'));
      return;
    }
    fs.renameSync(tmp, out);
    helper.path = out;
    helper.state = 'ready';
  });
}

// ---------- what can be captured ----------
const even = (n) => Math.max(16, Math.floor(n / 2) * 2);
export function fitSize(width, height, maxW = 1920, maxH = 1080) {
  const k = Math.min(1, maxW / width, maxH / height);
  return [even(width * k), even(height * k)];
}
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// { supported, screens, windows, audio, note }. Every item has an `id` to hand
// back to startCapture and a `label` to show. `note` explains a limitation.
export async function listSources(platform = process.platform) {
  const none = { supported: false, screens: [], windows: [], audio: [], note: null };
  if (platform === 'darwin') {
    const devices = parseAvfoundation((await run('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''])).text);
    const mics = devices.audio.map((a) => ({ id: `mic:${a.id}`, label: a.label }));
    if (helper.state === 'ready') {
      const r = await run(helper.path, ['list']);
      if (!r.ok) return { ...none, note: /permission/i.test(r.text) ? 'no_permission' : 'failed' };
      return { ...parseHelperList(r.stdout), audio: [{ id: 'system', label: null }, ...mics], note: null };
    }
    return { supported: devices.screens.length > 0, screens: devices.screens, windows: [], audio: mics, note: helper.state };
  }
  if (platform === 'win32') {
    const dshow = await run('ffmpeg', ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy']);
    if (dshow.missing) return none;
    const titles = await run('powershell', ['-NoProfile', '-Command', 'Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }']);
    const windows = titles.ok ? [...new Set(titles.stdout.split(/\r?\n/).map((t) => t.trim()).filter(Boolean))].map((t) => ({ id: `title:${t}`, label: short(t, 70) })) : [];
    return { supported: true, screens: [{ id: 'desktop', label: null }], windows, audio: parseDshowAudio(dshow.text).map((a) => ({ id: `mic:${a.id}`, label: a.label })), note: null };
  }
  const display = process.env.DISPLAY;
  if (!display || !/^[\w.:-]+$/.test(display) || (await run('ffmpeg', ['-version'])).missing) return none;
  return { supported: true, screens: [{ id: `x11:${display}`, label: null }], windows: [], audio: [{ id: 'mic:default', label: null }], note: null };
}

export function parseHelperList(json) {
  let data;
  try { data = JSON.parse(json); } catch { return { supported: false, screens: [], windows: [] }; }
  const screens = (data.displays || []).map((d, i) => ({ id: `display:${d.id}`, label: null, n: i + 1, width: d.width, height: d.height }));
  // A window with no title is only worth listing when it covers a screen:
  // that is an app showing something full screen (a browser playing a video
  // full screen does it in a second, untitled window). The rest are panels.
  const covers = (w) => screens.some((d) => w.width >= d.width * 0.95 && w.height >= d.height * 0.85);
  const name = (w) => (w.title ? (w.app && w.app !== w.title ? `${w.app} — ${w.title}` : w.title) : `${w.app || '?'} — ⛶ full screen`);
  const windows = (data.windows || []).filter((w) => w.title || covers(w))
    .map((w) => ({ id: `window:${w.id}`, label: short(name(w), 70), width: w.width, height: w.height }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { supported: screens.length > 0, screens, windows };
}

export function parseAvfoundation(text) {
  const out = { screens: [], audio: [] };
  let section = null;
  for (const line of String(text || '').split('\n')) {
    if (/AVFoundation video devices/.test(line)) section = 'video';
    else if (/AVFoundation audio devices/.test(line)) section = 'audio';
    const m = /\[(\d+)\]\s+(.+?)\s*$/.exec(line.replace(/^\[[^\]]*\]\s*/, ''));
    if (!m || !section) continue;
    if (section === 'video') { if (/^Capture screen/i.test(m[2])) out.screens.push({ id: `screen:${m[1]}`, label: null, n: out.screens.length + 1 }); }
    else out.audio.push({ id: m[1], label: m[2] });
  }
  return out;
}

export function parseDshowAudio(text) {
  const audio = [];
  for (const line of String(text || '').split('\n')) {
    const m = /"([^"]+)"\s+\(audio\)/.exec(line);
    if (m) audio.push({ id: m[1], label: m[1] });
  }
  return audio;
}

// ---------- the commands for one capture ----------
// The stream is made at up to three sizes at once, so each viewer's player can
// pick the best one their connection keeps up with and change as it varies.
// Returns [{ height, kbps }], sharpest first. Bitrate follows the picture size.
export function ladder(width, height) {
  const kbps = (w, h) => Math.round(Math.min(8000, Math.max(900, (w * h * FPS * 0.11) / 1000)) / 100) * 100;
  const steps = [{ height, kbps: kbps(width, height) }];
  for (const h of [720, 480]) if (h <= height * 0.75) steps.push({ height: h, kbps: kbps((width / height) * h, h) });
  return steps;
}

// `source` and `audio` are an item and an id from listSources(). Returns
// { helper: [args] | null, ffmpeg: [args], variants }; with a helper, ffmpeg
// reads raw pictures from it on stdin and (for computer sound) samples on
// descriptor 3.
export function capturePlan({ platform = process.platform, source, audio = null, dir }) {
  const [kind, value] = [source.id.slice(0, source.id.indexOf(':')), source.id.slice(source.id.indexOf(':') + 1)];
  const mic = audio?.startsWith('mic:') ? audio.slice(4) : null;
  const q = ['-thread_queue_size', '1024'];
  let helperArgs = null, input, prepare = `fps=${FPS},scale=-2:'min(1080,ih)',format=yuv420p`;
  let steps = [{ height: 1080, kbps: 6000 }]; // size not known in advance: one stream
  let sound = audio != null ? '1:a' : null; // which input carries the sound

  if (kind === 'display' || kind === 'window') {
    const [w, h] = fitSize(source.width, source.height);
    helperArgs = ['capture', kind, value, String(w), String(h), String(FPS), ...(audio === 'system' ? ['audio'] : [])];
    input = ['-f', 'rawvideo', '-pix_fmt', 'nv12', '-video_size', `${w}x${h}`, '-framerate', String(FPS), '-use_wallclock_as_timestamps', '1', '-thread_queue_size', '16', '-i', 'pipe:0'];
    // (A short queue for pictures: when the computer is too busy to keep up, the
    // helper skips pictures instead of the stream falling ever further behind.)
    // Sound is an unbroken run of samples, so it keeps time by counting them.
    if (audio === 'system') input.push('-f', 'f32le', '-ar', '48000', '-ac', '2', ...q, '-i', 'pipe:3');
    else if (mic !== null) input.push('-f', 'avfoundation', ...q, '-i', `:${mic}`);
    // The helper's pictures are already in the form the Mac's encoder takes,
    // so nothing is converted: that keeps the capture light on a busy computer.
    prepare = `fps=${FPS}`;
    steps = ladder(w, h);
  } else if (platform === 'darwin') {
    input = ['-nostdin', '-f', 'avfoundation', ...q, '-framerate', String(FPS), '-capture_cursor', '1', '-i', `${value}:${mic ?? 'none'}`];
    if (mic !== null) sound = '0:a';
  } else if (platform === 'win32') {
    input = ['-nostdin', '-f', 'gdigrab', ...q, '-framerate', String(FPS), '-draw_mouse', '1', '-i', kind === 'title' ? `title=${value}` : 'desktop'];
    if (mic !== null) input.push('-f', 'dshow', ...q, '-i', `audio=${mic}`);
    prepare = `fps=${FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,scale=-2:'min(1080,ih)',format=yuv420p`;
  } else {
    input = ['-nostdin', '-f', 'x11grab', ...q, '-framerate', String(FPS), '-draw_mouse', '1', '-i', value];
    if (mic !== null) input.push('-f', 'pulse', ...q, '-i', 'default');
  }
  const n = steps.length;
  const graph = `[0:v]${prepare},split=${n}${steps.map((_, i) => `[p${i}]`).join('')};`
    + steps.map((s, i) => `[p${i}]${i ? `scale=-2:${s.height}:flags=bicubic` : 'null'}[v${i}]`).join(';');
  const maps = steps.flatMap((_, i) => ['-map', `[v${i}]`, ...(sound ? ['-map', sound] : [])]);
  const rates = steps.flatMap((s, i) => [`-b:v:${i}`, `${s.kbps}k`, `-maxrate:v:${i}`, `${Math.round(s.kbps * 1.25)}k`, `-bufsize:v:${i}`, `${s.kbps * 2}k`]);
  const gop = String(FPS * SEGMENT_SECONDS);
  const video = platform === 'darwin'
    ? ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-profile:v', 'high']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'];
  return {
    helper: helperArgs,
    variants: n,
    ffmpeg: [
      '-hide_banner', '-loglevel', 'error', ...input,
      '-filter_complex', graph, ...maps,
      ...video, ...rates, '-g', gop, '-keyint_min', gop, '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      ...(sound ? ['-af', 'aresample=async=1', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000'] : []),
      '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_list_size', '8',
      '-hls_flags', 'delete_segments+program_date_time+independent_segments+temp_file',
      '-master_pl_name', PLAYLIST, '-var_stream_map', steps.map((_, i) => (sound ? `v:${i},a:${i}` : `v:${i}`)).join(' '),
      '-hls_segment_filename', path.join(dir, 's%v_%05d.ts'), path.join(dir, 'v%v.m3u8'),
    ],
  };
}

// Starts capturing. Resolves with { stop() } once the stream is watchable, or
// rejects with a short reason. `onEnd` runs once when the capture stops for
// any reason after that (stopped, crashed, window closed, display unplugged).
export function startCapture({ dir, source, audio, onEnd }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const plan = capturePlan({ source, audio, dir });
  let log = '', done = false, ready = false, poll = null, giveUp = null;
  const note = (d) => { log = (log + d).slice(-2000); };

  let grab = null, ffmpeg;
  if (plan.helper) {
    // helper stdout -> ffmpeg stdin (pictures), helper fd 3 -> ffmpeg fd 3 (sound)
    grab = spawn(helper.path, plan.helper, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    grab.stderr.on('data', note);
    ffmpeg = spawn('ffmpeg', plan.ffmpeg, { stdio: [grab.stdout, 'ignore', 'pipe', grab.stdio[3]] });
    grab.stdout.destroy(); // ffmpeg holds these ends now
    grab.stdio[3].destroy();
  } else {
    ffmpeg = spawn('ffmpeg', plan.ffmpeg, { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  ffmpeg.stderr.on('data', note);
  const procs = [grab, ffmpeg].filter(Boolean);
  const alive = (p) => p.exitCode === null && p.signalCode === null;

  const stop = () => {
    // Ending the helper lets ffmpeg finish its last segment by itself.
    if (grab && alive(grab)) grab.kill('SIGTERM'); else if (alive(ffmpeg)) ffmpeg.kill('SIGINT');
    setTimeout(() => { for (const p of procs) if (alive(p)) p.kill('SIGKILL'); }, 2000).unref();
  };
  return new Promise((resolve, reject) => {
    const finish = (err) => {
      if (done) return;
      done = true;
      clearInterval(poll); clearTimeout(giveUp);
      // Let the helper end its capture cleanly, so macOS drops its sharing indicator.
      if (grab && alive(grab)) grab.kill('SIGTERM');
      if (alive(ffmpeg)) ffmpeg.kill('SIGKILL');
      setTimeout(() => { if (grab && alive(grab)) grab.kill('SIGKILL'); }, 3000).unref();
      fs.rmSync(dir, { recursive: true, force: true });
      if (ready) onEnd?.(); else reject(new Error(err || 'capture_failed'));
    };
    const reason = () => (/permission|not authorized|denied|declined/i.test(log) ? 'no_permission' : /gone:/.test(log) ? 'source_gone' : log.trim().split('\n').pop()?.slice(0, 160) || 'capture_failed');
    for (const p of procs) {
      p.on('error', () => finish(p === ffmpeg ? 'ffmpeg_missing' : 'capture_failed'));
      p.on('exit', () => finish(reason()));
    }
    poll = setInterval(() => {
      if (![PLAYLIST, ...Array.from({ length: plan.variants }, (_, i) => `v${i}.m3u8`)].every((f) => fs.existsSync(path.join(dir, f)))) return;
      clearInterval(poll); clearTimeout(giveUp);
      ready = true;
      resolve({ stop });
    }, 250);
    // macOS gives no error when Screen Recording is not allowed: ffmpeg just
    // never receives a frame. Treat a silent start as a missing permission.
    giveUp = setTimeout(() => { if (!ready) { log = 'permission'; stop(); } }, 15000);
  });
}
