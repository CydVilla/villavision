// Villavisión's own screen capture, OBS-style: ffmpeg on the host computer
// records a display (and optionally a sound input) and writes a short rolling
// live stream that the theatre plays on the big screen. No browser picker.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const PLAYLIST = 'live.m3u8';
export const LIVE_FILE = /^(live\.m3u8|s\d{1,9}\.ts)$/;
const SEGMENT_SECONDS = 2;

function ffmpegText(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', ...args], { encoding: 'utf8', timeout: 8000 });
  return r.error ? null : `${r.stdout || ''}\n${r.stderr || ''}`;
}

// What this computer can capture: { supported, screens: [{id,label}], audio: [{id,label}] }.
export function listSources(platform = process.platform) {
  if (platform === 'darwin') return parseAvfoundation(ffmpegText(['-f', 'avfoundation', '-list_devices', 'true', '-i', '']));
  if (platform === 'win32') {
    const audio = parseDshowAudio(ffmpegText(['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy']));
    return { supported: audio !== null, screens: [{ id: 'desktop', label: 'Whole desktop' }], audio: audio || [] };
  }
  const display = process.env.DISPLAY;
  if (!display || !/^[\w.:-]+$/.test(display) || ffmpegText(['-version']) === null) return { supported: false, screens: [], audio: [] };
  return { supported: true, screens: [{ id: display, label: `Display ${display}` }], audio: [{ id: 'default', label: 'Default sound input (PulseAudio)' }] };
}

export function parseAvfoundation(text) {
  const out = { supported: false, screens: [], audio: [] };
  if (!text) return out;
  let section = null;
  for (const line of text.split('\n')) {
    if (/AVFoundation video devices/.test(line)) section = 'video';
    else if (/AVFoundation audio devices/.test(line)) section = 'audio';
    const m = /\[(\d+)\]\s+(.+?)\s*$/.exec(line.replace(/^\[[^\]]*\]\s*/, ''));
    if (!m || !section) continue;
    if (section === 'video') { if (/^Capture screen/i.test(m[2])) out.screens.push({ id: m[1], label: `Screen ${out.screens.length + 1}` }); }
    else out.audio.push({ id: m[1], label: m[2] });
  }
  out.supported = out.screens.length > 0;
  return out;
}

export function parseDshowAudio(text) {
  if (!text) return null;
  const audio = [];
  for (const line of text.split('\n')) {
    const m = /"([^"]+)"\s+\(audio\)/.exec(line);
    if (m) audio.push({ id: m[1], label: m[1] });
  }
  return audio;
}

// The ffmpeg arguments for one capture. `screen` and `audio` must be ids that
// listSources() returned; the caller checks that before calling this.
export function captureArgs({ platform = process.platform, screen, audio, dir }) {
  const input = [];
  if (platform === 'darwin') {
    input.push('-f', 'avfoundation', '-thread_queue_size', '1024', '-framerate', '30', '-capture_cursor', '1', '-i', `${screen}:${audio ?? 'none'}`);
  } else if (platform === 'win32') {
    input.push('-f', 'gdigrab', '-thread_queue_size', '1024', '-framerate', '30', '-draw_mouse', '1', '-i', 'desktop');
    if (audio != null) input.push('-f', 'dshow', '-thread_queue_size', '1024', '-i', `audio=${audio}`);
  } else {
    input.push('-f', 'x11grab', '-thread_queue_size', '1024', '-framerate', '30', '-draw_mouse', '1', '-i', screen);
    if (audio != null) input.push('-f', 'pulse', '-thread_queue_size', '1024', '-i', 'default');
  }
  const gop = String(30 * SEGMENT_SECONDS);
  const video = platform === 'darwin'
    ? ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-b:v', '5000k', '-maxrate', '6000k']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', '4500k', '-maxrate', '5000k', '-bufsize', '9000k'];
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', ...input,
    '-vf', "fps=30,scale=-2:'min(1080,ih)',format=yuv420p",
    ...video, '-g', gop, '-keyint_min', gop, '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    ...(audio != null ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000'] : ['-an']),
    '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+program_date_time+independent_segments+temp_file',
    '-hls_segment_filename', path.join(dir, 's%05d.ts'), path.join(dir, PLAYLIST),
  ];
}

// Starts capturing. Resolves with { stop() } once the stream is watchable, or
// rejects with a short reason. `onEnd` runs once when the capture stops for
// any reason after that (stopped, crashed, display unplugged).
export function startCapture({ dir, screen, audio, onEnd }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn('ffmpeg', captureArgs({ screen, audio, dir }), { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '', done = false, ready = false, poll = null, giveUp = null;
  child.stderr.on('data', (d) => { log = (log + d).slice(-2000); });

  const stop = () => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGINT');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000).unref();
    }
  };
  return new Promise((resolve, reject) => {
    const finish = (err) => {
      if (done) return;
      done = true;
      clearInterval(poll); clearTimeout(giveUp);
      fs.rmSync(dir, { recursive: true, force: true });
      if (ready) onEnd?.(); else reject(new Error(err || 'capture_failed'));
    };
    child.on('error', () => finish('ffmpeg_missing'));
    child.on('exit', () => finish(/permission|not authorized|denied/i.test(log) ? 'no_permission' : log.trim().split('\n').pop() || 'capture_failed'));
    poll = setInterval(() => {
      if (!fs.existsSync(path.join(dir, PLAYLIST))) return;
      clearInterval(poll); clearTimeout(giveUp);
      ready = true;
      resolve({ stop });
    }, 250);
    // macOS gives no error when Screen Recording is not allowed: ffmpeg just
    // never receives a frame. Treat a silent start as a missing permission.
    giveUp = setTimeout(() => { if (!ready) { log = 'permission'; stop(); } }, 15000);
  });
}
