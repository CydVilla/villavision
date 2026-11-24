import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { startTunnel } from './tunnel.js';
import net from 'node:net';
import { listSources, startCapture, prepareHelper, LIVE_FILE } from './capture.js';
import { prepareWorkspace, workspaceStatus, setupWorkspace, startDesk, stopDesk, runningDesk, DESK_PORT, DESK_SOUND_PORT, DESK_PICTURE_PORT } from './workspace.js';
import { listenToDesk } from './deskaudio.js';
import { ViewOnlyGate } from './rfb.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch {}

const PUBLIC = path.join(ROOT, 'public');
const MEDIA = path.resolve(process.env.MEDIA_DIR || path.join(ROOT, 'media'));
const DATA = path.join(ROOT, 'data');
const INCOMING = path.join(DATA, 'incoming');
const LIVE = path.join(DATA, 'live');
const STATE_FILE = path.join(DATA, 'state.json');
const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '127.0.0.1';
const ONLINE = process.argv.includes('--online');
const ALLOW_REMOTE_HOST = process.env.ALLOW_REMOTE_HOST === '1';
// The shared computer is unfinished: switched off, and absent from the pages, unless asked for.
const SHARED_COMPUTER = process.env.SHARED_COMPUTER === '1';
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_GB) || 50) * 1024 ** 3;
const MAX_CONNECTIONS = 200;
let publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// Voice, webcams and screen sharing travel directly between viewers. STUN
// helps them find each other; an optional TURN relay covers strict networks.
const ice = [{ urls: (process.env.STUN_URLS || 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean) }];
if (process.env.TURN_URLS) ice.push({ urls: process.env.TURN_URLS.split(',').map((s) => s.trim()), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt; charset=utf-8',
};
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.m4v', '.avi', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.flv']);

// ---------- persistent state (host key + theatres, so links survive restarts) ----------
fs.mkdirSync(MEDIA, { recursive: true });
fs.rmSync(INCOMING, { recursive: true, force: true });
fs.mkdirSync(INCOMING, { recursive: true });
fs.rmSync(LIVE, { recursive: true, force: true });
let state = { hostKey: crypto.randomBytes(18).toString('base64url'), rooms: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
function writeState() {
  for (const r of rooms.values()) if (state.rooms[r.id]) state.rooms[r.id].position = r.position();
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(writeState, 300); }

// ---------- who may act as host ----------
function isHostKey(k) {
  const a = Buffer.from(String(k || '')), b = Buffer.from(state.hostKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Host powers work only from this computer: a request that came in through a
// tunnel or proxy carries forwarding headers and is refused even with the key.
// Set ALLOW_REMOTE_HOST=1 if you run this on a remote server on purpose.
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'via'];
function isLocal(req) {
  if (ALLOW_REMOTE_HOST) return true;
  if (FORWARDED.some((h) => req.headers[h])) return false;
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}
const isHost = (req) => isLocal(req) && isHostKey(req.headers['x-host-key']);

// ---------- library ----------
const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
// A theatre with no film: the big screen is only for screen sharing.
const NO_MOVIE = Object.freeze({ id: null, title: null, duration: 0, subs: [] });
function loadMovie(id) {
  if (!ID_RE.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(MEDIA, id, 'meta.json'), 'utf8')); } catch { return null; }
}
function listMovies() {
  return fs.readdirSync(MEDIA, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => loadMovie(d.name)).filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// Uploaded movies are prepared one at a time so the computer stays usable.
const jobs = [];
let working = false;
function nextJob() {
  if (working) return;
  const job = jobs.find((j) => j.status === 'queued');
  if (!job) return;
  working = true; job.status = 'preparing';
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'ingest.js'), job.file, job.title], { env: { ...process.env, MEDIA_DIR: MEDIA }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stdout.on('data', (d) => { const m = /(\d+)%/.exec(d.toString().split('\r').pop()); if (m) job.pct = Number(m[1]); });
  child.stderr.on('data', (d) => { err = (err + d).slice(-400); });
  child.on('exit', (code) => {
    job.status = code === 0 ? 'done' : 'error';
    if (code !== 0) job.error = err.trim().split('\n').pop() || 'Could not prepare this file.';
    fs.rm(job.file, { force: true }, () => {});
    setTimeout(() => { const i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1); }, code === 0 ? 5000 : 60000);
    working = false; nextJob();
  });
}

// ---------- theatres ----------
const rooms = new Map();
function openRoom(id) {
  if (rooms.has(id)) return rooms.get(id);
  const saved = Object.hasOwn(state.rooms, id) ? state.rooms[id] : null;
  if (!saved) return null;
  const movie = saved.movieId ? loadMovie(saved.movieId) : NO_MOVIE;
  if (!movie) return null;
  const room = new Room({ id, name: saved.name, movie, position: saved.position || 0, isHostKey, onChange: save, ice });
  room.onLiveEnd = () => { if (live?.roomId === id) stopLive(); };
  room.onDeskEnd = () => { if (runningDesk()?.roomId === id) stopDesk(); };
  room.onRole = (person) => dropDeskViewers(id, person.pid); // they reconnect with their new rights
  rooms.set(id, room);
  return room;
}
// ---------- screen capture on this computer ----------
// One capture at a time: { roomId, dir, stop } while this computer's screen is
// being broadcast to a theatre, `starting` while ffmpeg is warming up.
let live = null, starting = false;
function stopLive() {
  const was = live;
  if (!was) return;
  live = null;
  was.stop();
  const room = rooms.get(was.roomId);
  if (room?.share?.kind === 'live') room.setShare(null);
}
async function beginLive(room, { source: sourceId, audio, pid }) {
  if (starting) return 'busy';
  starting = true;
  try {
    return await beginLiveNow(room, { sourceId, audio, pid });
  } finally { starting = false; }
}
async function beginLiveNow(room, { sourceId, audio, pid }) {
  // Only what this computer just listed can be captured, never a raw value from the request.
  const sources = await listSources();
  if (!sources.supported) return sources.note === 'no_permission' ? 'no_permission' : 'unsupported';
  const source = [...sources.screens, ...sources.windows].find((s) => s.id === sourceId);
  if (!source) return 'source_gone';
  if (audio != null && !sources.audio.some((a) => a.id === audio)) return 'unknown_audio';
  const host = room.people.get(String(pid));
  if (!host || host.role !== 'host') return 'not_in_theatre';
  stopLive();
  const dir = path.join(LIVE, `${room.id}.${Date.now()}`);
  try {
    // If ffmpeg stops by itself (display unplugged, crash), take the share down.
    const cap = await startCapture({ dir, source, audio, onEnd: () => { if (live?.dir === dir) stopLive(); } });
    live = { roomId: room.id, dir, stop: cap.stop };
    if (!room.startLive(pid)) { stopLive(); return 'not_in_theatre'; }
    return null;
  } catch (e) {
    return e.message;
  }
}

// ---------- the shared computer ----------
// Browsers watching or using the shared computer's screen: pid -> sockets.
const deskViewers = new Map();
function dropDeskViewers(roomId, pid) {
  for (const [key, set] of deskViewers) {
    if (key.startsWith(roomId + ' ') && (pid == null || key === `${roomId} ${pid}`)) for (const s of set) s.close();
  }
}
// Live streams out of the shared computer, each read from the machine once and
// handed to everyone who wants it: its sound alone (for people using it, whose
// picture comes another way) and its screen with sound as video (for people
// watching). The machine only produces a stream while someone is on it.
function makeDeskStream(port) {
  const hub = { ip: null, listeners: new Set(), init: null, source: null };
  const stopSource = () => { hub.source?.stop(); hub.source = null; hub.init = null; };
  hub.add = (ws) => {
    if (!hub.ip) return ws.close();
    hub.listeners.add(ws);
    ws.on('close', () => { hub.listeners.delete(ws); if (!hub.listeners.size) stopSource(); });
    if (hub.init) ws.send(hub.init);
    if (!hub.source) hub.source = listenToDesk({
      host: hub.ip, port,
      onInit: (buf) => { hub.init = buf; for (const l of hub.listeners) if (l.readyState === 1) { l.send('restart'); l.send(buf); } },
      // Someone on a slow link skips ahead rather than falling ever further behind.
      onFragment: (buf) => { for (const l of hub.listeners) if (l.readyState === 1 && l.bufferedAmount < 1_500_000) l.send(buf); },
    });
  };
  hub.start = (ip) => { hub.stop(); hub.ip = ip; };
  hub.stop = () => { hub.ip = null; stopSource(); for (const l of hub.listeners) l.close(); hub.listeners.clear(); };
  return hub;
}
const deskStreams = { sound: makeDeskStream(DESK_SOUND_PORT), picture: makeDeskStream(DESK_PICTURE_PORT) };
const stopDeskStreams = () => { for (const h of Object.values(deskStreams)) h.stop(); };

async function beginDesk(room, pid) {
  const host = room.people.get(String(pid));
  if (!host || host.role !== 'host') return 'not_in_theatre';
  if (room.share) return 'screen_busy';
  try {
    const vm = await startDesk(room.id, () => { stopDeskStreams(); dropDeskViewers(room.id); if (room.share?.kind === 'desk') room.setShare(null); });
    for (const h of Object.values(deskStreams)) h.start(vm.ip);
  } catch (e) { return e.message; }
  if (!room.startDesk(pid)) { stopDesk(); return 'not_in_theatre'; }
  return null;
}

function closeRoom(id) {
  if (live?.roomId === id) stopLive();
  if (runningDesk()?.roomId === id) stopDesk();
  const room = rooms.get(id);
  if (room) { for (const person of room.people.values()) person.conn.close(); rooms.delete(id); }
  delete state.rooms[id];
}
setInterval(() => { for (const r of rooms.values()) r.tick(); }, 1000).unref();
setInterval(() => { if ([...rooms.values()].some((r) => r.play.playing)) save(); }, 15000).unref();

// ---------- http ----------
function securityHeaders(req) {
  const host = /^[\w.-]+(:\d+)?$|^\[::1\](:\d+)?$/.test(req.headers.host || '') ? req.headers.host : '';
  return {
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'${host ? ` ws://${host} wss://${host}` : ''}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
    'X-Robots-Tag': 'noindex, nofollow',
  };
}
function send(req, res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders(req), ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
const notFound = (req, res) => send(req, res, 404, 'Not found');

function safeJoin(base, rel) {
  const full = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

function serveFile(req, res, file, cache = 'no-cache') {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(req, res);
    const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache, 'Accept-Ranges': 'bytes', ...securityHeaders(req) };
    let start = 0, end = st.size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); }
      else start = Math.max(0, st.size - Number(m[2]));
      if (start > end || start >= st.size) return send(req, res, 416, 'Range not satisfiable', { 'Content-Range': `bytes */${st.size}` });
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 10_000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function receiveMovie(req, res, url) {
  const name = path.basename(String(url.searchParams.get('filename') || ''));
  const ext = path.extname(name).toLowerCase();
  if (!VIDEO_EXT.has(ext)) return send(req, res, 400, { error: 'That file type is not a supported video.' });
  if (Number(req.headers['content-length']) > MAX_UPLOAD) return send(req, res, 413, { error: 'That file is larger than the upload limit.' });
  const title = (String(url.searchParams.get('title') || '').trim() || path.basename(name, ext).replace(/[._]+/g, ' ').trim() || 'Movie').slice(0, 100);
  const file = path.join(INCOMING, crypto.randomBytes(8).toString('hex') + ext);
  const out = fs.createWriteStream(file, { mode: 0o600 });
  let size = 0, failed = false;
  const fail = (code, error) => { if (failed) return; failed = true; out.destroy(); fs.rm(file, { force: true }, () => {}); if (!res.headersSent) send(req, res, code, { error }, { Connection: 'close' }); req.destroy(); };
  req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) fail(413, 'That file is larger than the upload limit.'); });
  req.on('aborted', () => fail(400, 'Upload interrupted.'));
  out.on('error', () => fail(500, 'Could not save the file (is the disk full?).'));
  out.on('finish', () => {
    if (failed) return;
    jobs.push({ id: crypto.randomBytes(4).toString('hex'), title, file, status: 'queued', pct: 0 });
    nextJob();
    send(req, res, 200, { ok: true });
  });
  req.pipe(out);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return send(req, res, 400, 'Bad request'); }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (p === '/') return serveFile(req, res, path.join(PUBLIC, 'index.html'));
    if (p === '/host') return isLocal(req) ? serveFile(req, res, path.join(PUBLIC, 'host.html')) : notFound(req, res);
    if (/^\/r\/[\w-]+$/.test(p)) return serveFile(req, res, path.join(PUBLIC, 'theatre.html'));
    // The viewer for the shared computer's screen (noVNC), straight from its package.
    if (p.startsWith('/vendor/novnc/')) {
      const f = /^[\w./-]+\.js$/.test(p) ? safeJoin(path.join(ROOT, 'node_modules/@novnc/novnc'), p.slice('/vendor/novnc/'.length)) : null;
      return f ? serveFile(req, res, f, 'public, max-age=86400') : notFound(req, res);
    }
    if (p === '/api/workspace') {
      if (!isHost(req)) return send(req, res, 401, { error: 'unauthorized' });
      return send(req, res, 200, SHARED_COMPUTER ? workspaceStatus() : { state: 'off' });
    }
    if (p === '/vendor/hls.min.js') return serveFile(req, res, path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js'), 'public, max-age=86400');
    if (p.startsWith('/assets/')) {
      const f = safeJoin(path.join(PUBLIC, 'assets'), p.slice('/assets/'.length));
      return f ? serveFile(req, res, f) : notFound(req, res);
    }
    // Movie files are reachable only through a theatre link, never by movie id.
    const mm = /^\/m\/([\w-]+)\/(.+)$/.exec(p);
    if (mm) {
      const saved = Object.hasOwn(state.rooms, mm[1]) ? state.rooms[mm[1]] : null;
      if (!saved || !saved.movieId || !ID_RE.test(saved.movieId) || !/\.(m3u8|ts|vtt)$/.test(mm[2])) return notFound(req, res);
      const f = safeJoin(path.join(MEDIA, saved.movieId), mm[2]);
      return f ? serveFile(req, res, f, 'private, max-age=3600') : notFound(req, res);
    }
    // This computer's captured screen, reachable only through the theatre showing it.
    const lv = /^\/live\/([\w-]+)\/([\w.]+)$/.exec(p);
    if (lv) {
      if (!live || live.roomId !== lv[1] || !LIVE_FILE.test(lv[2])) return notFound(req, res);
      const f = safeJoin(live.dir, lv[2]);
      return f ? serveFile(req, res, f, lv[2].endsWith('.m3u8') ? 'no-store' : 'private, max-age=60') : notFound(req, res);
    }
    if (p === '/api/capture') {
      if (!isHost(req)) return send(req, res, 401, { error: 'unauthorized' });
      return send(req, res, 200, { ...(await listSources()), live: live?.roomId || null });
    }
    const rm = /^\/api\/room\/([\w-]+)$/.exec(p);
    if (rm) {
      const room = openRoom(rm[1]);
      return room ? send(req, res, 200, { name: room.name, movie: room.movie.title, invite: publicUrl ? `${publicUrl}/r/${room.id}` : null }) : send(req, res, 404, { error: 'not_found' });
    }
    if (p === '/api/library') {
      if (!isHost(req)) return send(req, res, 401, { error: 'unauthorized' });
      return send(req, res, 200, {
        publicUrl,
        movies: listMovies().map(({ id, title, duration, height }) => ({ id, title, duration, height })),
        rooms: Object.entries(state.rooms).map(([id, r]) => ({ id, ...r, position: rooms.get(id)?.position() ?? r.position, people: rooms.get(id)?.people.size || 0 })),
        jobs: jobs.map(({ id, title, status, pct, error }) => ({ id, title, status, pct, error })),
      });
    }
    return notFound(req, res);
  }

  // Everything below changes something and is for the host only.
  if (!isHost(req)) return send(req, res, 401, { error: 'unauthorized' }, { Connection: 'close' });

  if (req.method === 'POST' && p === '/api/rooms') {
    const body = await readJson(req);
    // No movieId means a theatre for screen sharing only.
    const movie = body.movieId == null ? NO_MOVIE : loadMovie(String(body.movieId));
    if (!movie) return send(req, res, 400, { error: 'unknown_movie' });
    const id = crypto.randomBytes(12).toString('base64url');
    state.rooms[id] = { movieId: movie.id, name: String(body.name || '').trim().slice(0, 60) || movie.title || 'Screen share', position: 0, createdAt: Date.now() };
    save();
    return send(req, res, 200, { id });
  }
  if (req.method === 'POST' && p === '/api/movies') return receiveMovie(req, res, url);

  if (req.method === 'POST' && p === '/api/workspace/setup') {
    if (!SHARED_COMPUTER) return send(req, res, 404, { error: 'off' });
    return setupWorkspace() ? send(req, res, 200, { ok: true }) : send(req, res, 400, { error: workspaceStatus().state });
  }
  const desk = /^\/api\/rooms\/([\w-]+)\/desk$/.exec(p);
  if (desk && req.method === 'POST') {
    if (!SHARED_COMPUTER) return send(req, res, 404, { error: 'off' });
    const room = openRoom(desk[1]);
    if (!room) return send(req, res, 404, { error: 'not_found' });
    const body = await readJson(req);
    const error = await beginDesk(room, body.pid);
    return error ? send(req, res, 400, { error }) : send(req, res, 200, { ok: true });
  }

  const cast = /^\/api\/rooms\/([\w-]+)\/broadcast$/.exec(p);
  if (cast && req.method === 'POST') {
    const room = openRoom(cast[1]);
    if (!room) return send(req, res, 404, { error: 'not_found' });
    const body = await readJson(req);
    const error = await beginLive(room, { source: String(body.source ?? ''), audio: body.audio == null ? null : String(body.audio), pid: body.pid });
    return error ? send(req, res, 400, { error }) : send(req, res, 200, { ok: true });
  }
  if (cast && req.method === 'DELETE') {
    if (live?.roomId === cast[1]) stopLive();
    return send(req, res, 200, { ok: true });
  }

  const delRoom = /^\/api\/rooms\/([\w-]+)$/.exec(p);
  if (req.method === 'DELETE' && delRoom) { closeRoom(delRoom[1]); save(); return send(req, res, 200, { ok: true }); }

  const delMovie = /^\/api\/movies\/([a-z0-9-]+)$/.exec(p);
  if (req.method === 'DELETE' && delMovie && loadMovie(delMovie[1])) {
    for (const [id, r] of Object.entries(state.rooms)) if (r.movieId === delMovie[1]) closeRoom(id);
    const dir = safeJoin(MEDIA, delMovie[1]);
    if (dir && dir !== MEDIA) fs.rmSync(dir, { recursive: true, force: true });
    save();
    return send(req, res, 200, { ok: true });
  }
  notFound(req, res);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => { if (!res.headersSent) send(req, res, 400, 'Bad request'); else res.destroy(); if (!(e instanceof SyntaxError)) console.error(e.message); });
});
server.headersTimeout = 15000;

// ---------- websocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
// The shared computer's screen: a WebSocket per viewer, bridged to the display
// server inside the virtual machine. People holding the remote get the raw
// connection; everyone else goes through a gate that drops keys and clicks.
const deskWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
// Anyone in the theatre may watch and listen to the shared computer.
function bridgeDeskStream(req, socket, head, roomId, hub) {
  const room = rooms.get(roomId);
  if (!room || room.share?.kind !== 'desk' || runningDesk()?.roomId !== roomId || deskWss.clients.size >= MAX_CONNECTIONS) return socket.destroy();
  deskWss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', () => {});
    const late = setTimeout(() => ws.terminate(), 8000);
    ws.once('message', (first, isBinary) => {
      clearTimeout(late);
      if (isBinary || !room.personByTicket(first.toString()) || runningDesk()?.roomId !== roomId) return ws.close();
      hub.add(ws);
    });
  });
}
function bridgeDesk(req, socket, head, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.share?.kind !== 'desk' || deskWss.clients.size >= MAX_CONNECTIONS) return socket.destroy();
  deskWss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', () => {});
    const late = setTimeout(() => ws.terminate(), 8000);
    // The first message is the viewer's private ticket (kept out of the address).
    ws.once('message', (first, isBinary) => {
      clearTimeout(late);
      const person = isBinary ? null : room.personByTicket(first.toString());
      const vm = runningDesk();
      if (!person || !vm || vm.roomId !== roomId || room.share?.kind !== 'desk') return ws.close();
      const gate = person.role === 'host' || person.role === 'cohost' ? null : new ViewOnlyGate();
      const key = `${roomId} ${person.pid}`;
      if (!deskViewers.has(key)) deskViewers.set(key, new Set());
      deskViewers.get(key).add(ws);
      const tcp = net.connect({ host: vm.ip, port: DESK_PORT });
      tcp.setNoDelay(true);
      tcp.on('data', (d) => { if (ws.readyState === 1) { ws.send(d); if (ws.bufferedAmount > 16_000_000) ws.terminate(); } });
      tcp.on('close', () => ws.close());
      tcp.on('error', () => ws.close());
      ws.on('message', (raw) => {
        try { const out = gate ? gate.push(raw) : raw; if (out.length) tcp.write(out); } catch { ws.close(); }
      });
      ws.on('close', () => { tcp.destroy(); deskViewers.get(key)?.delete(ws); if (!deskViewers.get(key)?.size) deskViewers.delete(key); });
    });
  });
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const room = url.pathname === '/ws' ? openRoom(url.searchParams.get('room') || '') : null;
  // Refuse pages on other websites trying to open a connection from a visitor's browser.
  let sameOrigin = true;
  if (req.headers.origin) { try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch { sameOrigin = false; } }
  if (sameOrigin && url.pathname === '/desk') return bridgeDesk(req, socket, head, url.searchParams.get('room') || '');
  if (sameOrigin && url.pathname === '/desksound') return bridgeDeskStream(req, socket, head, url.searchParams.get('room') || '', deskStreams.sound);
  if (sameOrigin && url.pathname === '/deskpicture') return bridgeDeskStream(req, socket, head, url.searchParams.get('room') || '', deskStreams.picture);
  if (!room || !sameOrigin || wss.clients.size >= MAX_CONNECTIONS) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = {
      person: null,
      canHost: isLocal(req),
      send: (o) => { if (ws.readyState === 1 && ws.bufferedAmount < 4_000_000) ws.send(JSON.stringify(o)); },
      close: () => ws.close(),
    };
    ws.lastSeen = Date.now();
    let windowStart = Date.now(), count = 0;
    const helloTimer = setTimeout(() => { if (!conn.person) ws.terminate(); }, 10000);
    ws.on('message', (raw) => {
      const now = Date.now();
      ws.lastSeen = now;
      if (now - windowStart > 1000) { windowStart = now; count = 0; }
      if (++count > 80) return ws.terminate(); // flooding
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      try {
        if (!conn.person) { if (msg.type === 'hello') room.join(conn, msg); }
        else room.handle(conn, msg);
      } catch (e) { console.error('room error:', e.message); }
    });
    ws.on('close', () => { clearTimeout(helloTimer); const pid = conn.person?.pid; room.leave(conn); if (pid) dropDeskViewers(room.id, pid); });
    ws.on('error', () => {});
  });
});
setInterval(() => { for (const ws of wss.clients) if (Date.now() - ws.lastSeen > 45000) ws.terminate(); }, 15000).unref();

// ---------- start ----------
if (spawnSync('ffmpeg', ['-version']).error) {
  console.warn('\n  ! ffmpeg was not found. You need it to add movies.\n    macOS: brew install ffmpeg   Windows: winget install ffmpeg   Linux: sudo apt install ffmpeg\n');
}
let tunnel = null;
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set PORT in .env to use another.` : e.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  writeState();
  prepareHelper(DATA); // builds the macOS window capture helper in the background
  if (SHARED_COMPUTER) prepareWorkspace(DATA); // and the helper that runs the shared computer
  console.log('\n  Villavisión is running.\n');
  console.log('  Your host page (private: it controls your theatres):');
  console.log(`  http://localhost:${PORT}/host#key=${state.hostKey}\n`);
  if (ONLINE) {
    tunnel = startTunnel({ root: ROOT, port: PORT, onUrl: (u) => { publicUrl = u; console.log(`  Online. Family links now start with:\n  ${u}\n`); } });
  } else if (!publicUrl) {
    console.log('  Only this computer can reach it right now. To invite people, run: npm run online\n');
  }
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  try { writeState(); } catch {}
  stopLive();
  stopDesk();
  tunnel?.kill();
  process.exit(0);
});
