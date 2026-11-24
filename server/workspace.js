// The shared computer: a Linux desktop with a web browser, running in a
// virtual machine on the host (macOS, Apple's Virtualization framework via
// native/vv-vm.swift). It shares none of the host's files. The theatre shows
// its screen, and whoever holds the remote can use it.
//
// Setting up happens once: download Debian's official cloud image, boot it
// with vm/user-data to install the desktop, and keep the result as a master
// disk. Each shared computer then starts in seconds as a copy of the master
// and is deleted when it is shut down.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_SOURCE = path.join(HERE, 'native', 'vv-vm.swift');
const ENTITLEMENTS = path.join(HERE, 'native', 'vv-vm.entitlements');
const USER_DATA = path.join(HERE, 'vm', 'user-data');
const ARCH = { arm64: 'arm64', x64: 'amd64' }[process.arch];
const IMAGE_BASE = 'https://cloud.debian.org/images/cloud/trixie/latest/';
const IMAGE_NAME = `debian-13-genericcloud-${ARCH}.tar.xz`;
const DISK_BYTES = 16 * 1024 ** 3;
const MAC = '52:54:00:76:76:01';
export const DESK_PORT = 5901;
export const DESK_SOUND_PORT = 5902;
export const DESK_PICTURE_PORT = 5903;
export const DOWNLOAD_MB = 700; // image plus the packages the first boot installs, roughly

const sh = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 600000, ...opts }, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(String(stdout))));
});
const sha = (file, algo) => new Promise((resolve, reject) => {
  const h = crypto.createHash(algo);
  fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

// state: 'unsupported' | 'no_swift' | 'preparing' | 'idle' (not set up) |
//        'downloading' | 'building' | 'ready' | 'starting' | 'running' | 'failed'
const ws = { state: 'unsupported', pct: 0, error: null, helper: null, dir: null, vm: null };
export const workspaceStatus = () => ({ state: ws.state, pct: ws.pct, error: ws.error, room: ws.vm?.roomId || null, downloadMb: DOWNLOAD_MB });
export const runningDesk = () => (ws.state === 'running' ? ws.vm : null);

const stampOf = () => crypto.createHash('sha256').update(fs.readFileSync(USER_DATA)).digest('hex').slice(0, 16);
const masterReady = () => { try { return fs.readFileSync(path.join(ws.dir, 'master.stamp'), 'utf8') === stampOf() && fs.existsSync(path.join(ws.dir, 'master.raw')); } catch { return false; } };

// Compiles and signs the helper in the background, once per version of its source.
export function prepareWorkspace(dataDir) {
  if (process.platform !== 'darwin' || !ARCH || ws.state !== 'unsupported') return;
  ws.dir = path.join(dataDir, 'vm');
  fs.mkdirSync(ws.dir, { recursive: true });
  fs.rmSync(path.join(ws.dir, 'run'), { recursive: true, force: true }); // left over from a crash
  ws.state = 'preparing';
  const bin = path.join(dataDir, 'bin');
  const stamp = crypto.createHash('sha256').update(fs.readFileSync(HELPER_SOURCE)).update(fs.readFileSync(ENTITLEMENTS)).digest('hex').slice(0, 16);
  const out = path.join(bin, `vv-vm-${stamp}`);
  const done = () => { ws.helper = out; ws.state = masterReady() ? 'ready' : 'idle'; };
  if (fs.existsSync(out)) return done();
  fs.mkdirSync(bin, { recursive: true });
  for (const old of fs.readdirSync(bin)) if (old.startsWith('vv-vm')) fs.rmSync(path.join(bin, old), { force: true });
  const tmp = `${out}.tmp`;
  sh('swiftc', ['-O', '-swift-version', '5', HELPER_SOURCE, '-o', tmp])
    .then(() => sh('codesign', ['--force', '-s', '-', '--entitlements', ENTITLEMENTS, tmp]))
    .then(() => { fs.renameSync(tmp, out); done(); })
    .catch((e) => {
      ws.state = e.code === 'ENOENT' || /xcode-select|no developer tools/i.test(e.stderr || '') ? 'no_swift' : 'failed';
      ws.error = 'helper';
      if (ws.state === 'failed') console.warn('  ! Could not build the shared computer helper:\n' + String(e.stderr || e.message).split('\n').slice(0, 6).join('\n'));
    });
}

// Runs the helper on a disk. onLine gets each line the guest prints on its
// serial console. Resolves with the exit code.
function boot(disk, vars, onLine) {
  const cpus = Math.max(2, Math.min(4, Math.floor(os.cpus().length / 2)));
  const child = spawn(ws.helper, ['run', disk, path.join(ws.dir, 'seed.iso'), vars, String(cpus), '4096', MAC], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '', err = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('latin1');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop().slice(-4000);
    for (const line of lines) onLine(line.trim());
  });
  child.stderr.on('data', (d) => { err = (err + d).slice(-1000); });
  const exited = new Promise((resolve) => {
    child.on('error', () => resolve({ code: -1, err: 'helper_missing' }));
    child.on('exit', (code) => resolve({ code, err: err.trim().split('\n').pop() || '' }));
  });
  return { child, exited };
}

async function download(url, file, onPct) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (d) => { got += d.length; if (total) onPct(Math.floor((got / total) * 100)); });
  await pipeline(body, fs.createWriteStream(file));
}

// One-time setup, started by the host. Progress is read with workspaceStatus().
export function setupWorkspace() {
  if (ws.state !== 'idle' && !(ws.state === 'failed' && ws.helper)) return false;
  ws.error = null; ws.pct = 0; ws.state = 'downloading';
  (async () => {
    const base = path.join(ws.dir, 'base');
    const disk = path.join(base, 'disk.raw');
    if (!fs.existsSync(disk)) {
      fs.rmSync(base, { recursive: true, force: true });
      fs.mkdirSync(base, { recursive: true });
      const archive = path.join(base, IMAGE_NAME);
      const sums = await (await fetch(IMAGE_BASE + 'SHA512SUMS')).text();
      const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === IMAGE_NAME)?.[0];
      if (!want) throw new Error('checksum list has no entry for the image');
      await download(IMAGE_BASE + IMAGE_NAME, archive, (p) => { ws.pct = p; });
      if ((await sha(archive, 'sha512')) !== want) { fs.rmSync(archive, { force: true }); throw new Error('the downloaded image failed its checksum'); }
      await sh('tar', ['-xJf', archive, '-C', base]);
      fs.rmSync(archive, { force: true });
      if (!fs.existsSync(disk)) throw new Error('the image did not contain a disk');
    }
    ws.state = 'building'; ws.pct = 0;
    // The setup instructions travel on a small disc labelled "cidata".
    const seedDir = path.join(ws.dir, 'seed');
    fs.rmSync(seedDir, { recursive: true, force: true });
    fs.mkdirSync(seedDir, { recursive: true });
    fs.copyFileSync(USER_DATA, path.join(seedDir, 'user-data'));
    fs.writeFileSync(path.join(seedDir, 'meta-data'), 'instance-id: villavision-1\nlocal-hostname: villavision\n');
    fs.rmSync(path.join(ws.dir, 'seed.iso'), { force: true });
    await sh('hdiutil', ['makehybrid', '-quiet', '-iso', '-joliet', '-default-volume-name', 'cidata', '-o', path.join(ws.dir, 'seed.iso'), seedDir]);

    const building = path.join(ws.dir, 'master.building.raw'), vars = path.join(ws.dir, 'master.vars');
    for (const f of [building, vars, path.join(ws.dir, 'master.raw'), path.join(ws.dir, 'master.stamp')]) fs.rmSync(f, { force: true });
    fs.copyFileSync(disk, building, fs.constants.COPYFILE_FICLONE);
    fs.truncateSync(building, DISK_BYTES);
    // First start: the machine installs its desktop, then switches itself off.
    const first = boot(building, vars, () => {});
    const timer = setTimeout(() => first.child.kill('SIGTERM'), 30 * 60 * 1000);
    const { code, err } = await first.exited;
    clearTimeout(timer);
    if (code !== 0) throw new Error(err || 'the first start did not finish');
    // Second start: prove the desktop really comes up before calling it ready.
    let sawDesktop = false;
    const check = boot(building, vars, (line) => { if (READY.test(line) && !sawDesktop) { sawDesktop = true; check.child.kill('SIGTERM'); } });
    const checkTimer = setTimeout(() => check.child.kill('SIGTERM'), 3 * 60 * 1000);
    await check.exited;
    clearTimeout(checkTimer);
    if (!sawDesktop) throw new Error('the desktop did not start inside the machine');
    fs.renameSync(building, path.join(ws.dir, 'master.raw'));
    fs.writeFileSync(path.join(ws.dir, 'master.stamp'), stampOf());
    ws.state = 'ready';
  })().catch((e) => {
    ws.state = 'failed';
    ws.error = String(e.message || e).slice(0, 200);
    console.warn('  ! Setting up the shared computer failed: ' + ws.error);
  });
  return true;
}

const READY = /VV-READY (\S+)$/;
const PRIVATE_IP = /^(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/;

// Starts a fresh computer for a theatre. Resolves with { roomId, ip } when its
// desktop is reachable; rejects with a short reason. onEnd runs once when it
// stops for any reason afterwards.
export async function startDesk(roomId, onEnd) {
  if (ws.state !== 'ready') throw new Error(ws.state === 'running' || ws.state === 'starting' ? 'busy' : 'not_set_up');
  ws.state = 'starting';
  const runDir = path.join(ws.dir, 'run');
  const disk = path.join(runDir, 'disk.raw'), vars = path.join(runDir, 'efi.vars');
  let up = false;
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.copyFileSync(path.join(ws.dir, 'master.raw'), disk, fs.constants.COPYFILE_FICLONE);
    fs.copyFileSync(path.join(ws.dir, 'master.vars'), vars);
    let ready;
    const gotIp = new Promise((resolve) => { ready = resolve; });
    const run = boot(disk, vars, (line) => { const m = READY.exec(line); if (m && PRIVATE_IP.test(m[1])) ready(m[1]); });
    run.exited.then(() => {
      fs.rmSync(runDir, { recursive: true, force: true });
      const was = ws.vm;
      ws.vm = null;
      if (ws.state === 'running' || ws.state === 'starting') ws.state = masterReady() ? 'ready' : 'idle';
      if (up && was) onEnd?.();
    });
    const ip = await Promise.race([
      gotIp,
      run.exited.then(({ err }) => { throw new Error(err || 'stopped'); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 120000)),
    ]).catch((e) => { run.child.kill('SIGTERM'); throw e; });
    up = true;
    ws.vm = { roomId, ip, stop: () => run.child.kill('SIGTERM') };
    ws.state = 'running';
    return ws.vm;
  } catch (e) {
    if (ws.state === 'starting') ws.state = masterReady() ? 'ready' : 'idle';
    throw e;
  }
}

export function stopDesk() {
  ws.vm?.stop();
}
