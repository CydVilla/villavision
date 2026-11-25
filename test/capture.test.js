import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAvfoundation, parseDshowAudio, parseHelperList, capturePlan, ladder, fitSize, LIVE_FILE } from '../server/capture.js';

test('reads screens and sound inputs from the macOS device list', () => {
  const s = parseAvfoundation([
    '[AVFoundation indev @ 0x1] AVFoundation video devices:',
    '[AVFoundation indev @ 0x1] [0] FaceTime HD Camera',
    '[AVFoundation indev @ 0x1] [3] Capture screen 0',
    '[AVFoundation indev @ 0x1] [4] Capture screen 1',
    '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
    '[AVFoundation indev @ 0x1] [1] MacBook Pro Microphone',
  ].join('\n'));
  assert.deepEqual(s.screens.map((x) => x.id), ['screen:3', 'screen:4']);
  assert.deepEqual(s.audio, [{ id: '1', label: 'MacBook Pro Microphone' }]);
  assert.deepEqual(parseAvfoundation(null), { screens: [], audio: [] });
});

test('reads screens and windows from the macOS helper', () => {
  const s = parseHelperList(JSON.stringify({
    displays: [{ id: 1, width: 3456, height: 2234 }],
    windows: [{ id: 9, app: 'Safari', title: 'Recipes', width: 2400, height: 1600 }, { id: 4, app: 'Notes', title: 'Notes', width: 800, height: 600 }],
  }));
  assert.equal(s.supported, true);
  assert.deepEqual(s.screens.map((x) => x.id), ['display:1']);
  assert.deepEqual(s.windows.map((x) => [x.id, x.label]), [['window:4', 'Notes'], ['window:9', 'Safari — Recipes']]);
  assert.equal(parseHelperList('not json').supported, false);
});

test('reads sound inputs from the Windows device list', () => {
  assert.deepEqual(parseDshowAudio('[dshow @ 1] "HD Webcam" (video)\n[dshow @ 1] "Stereo Mix (Realtek)" (audio)'), [{ id: 'Stereo Mix (Realtek)', label: 'Stereo Mix (Realtek)' }]);
});

test('fits a capture inside 1080p with even sides and never enlarges', () => {
  assert.deepEqual(fitSize(3456, 2234), [1670, 1080]);
  assert.deepEqual(fitSize(801, 601), [800, 600]);
  assert.deepEqual(fitSize(4000, 1000), [1920, 480]);
});

test('plans a capture per platform and source', () => {
  const win = { id: 'window:9', width: 2400, height: 1600 };
  const a = capturePlan({ platform: 'darwin', source: win, audio: 'system', dir: '/tmp/x' });
  assert.deepEqual(a.helper, ['capture', 'window', '9', '1620', '1080', '30', 'audio']);
  assert.ok(a.ffmpeg.includes('pipe:0') && a.ffmpeg.includes('pipe:3') && a.ffmpeg.includes('1620x1080') && !a.ffmpeg.includes('-nostdin'));
  const b = capturePlan({ platform: 'darwin', source: { id: 'display:1', width: 3456, height: 2234 }, audio: 'mic:1', dir: '/tmp/x' });
  assert.deepEqual(b.helper, ['capture', 'display', '1', '1670', '1080', '30']);
  assert.ok(b.ffmpeg.includes(':1') && !b.ffmpeg.includes('pipe:3'));
  const c = capturePlan({ platform: 'darwin', source: { id: 'screen:3' }, audio: null, dir: '/tmp/x' });
  assert.equal(c.helper, null);
  assert.ok(c.ffmpeg.includes('3:none') && !c.ffmpeg.includes('aac') && c.variants === 1);
  const d = capturePlan({ platform: 'win32', source: { id: 'title:My: Window' }, audio: 'mic:Stereo Mix', dir: 'C:\\x' });
  assert.ok(d.ffmpeg.includes('title=My: Window') && d.ffmpeg.includes('audio=Stereo Mix') && d.ffmpeg.includes('libx264'));
  assert.ok(capturePlan({ platform: 'win32', source: { id: 'desktop' }, dir: 'C:\\x' }).ffmpeg.includes('desktop'));
  assert.ok(capturePlan({ platform: 'linux', source: { id: 'x11::0.0' }, dir: '/tmp/x' }).ffmpeg.includes(':0.0'));
});

test('makes the stream at several sizes, sharpest first, and never larger than the source', () => {
  assert.deepEqual(ladder(1920, 1080), [{ height: 1080, kbps: 6800 }, { height: 720, kbps: 3000 }, { height: 480, kbps: 1400 }]);
  assert.deepEqual(ladder(1172, 866).map((s) => s.height), [866, 480]);
  assert.deepEqual(ladder(640, 360).map((s) => s.height), [360]);
  const plan = capturePlan({ platform: 'darwin', source: { id: 'window:9', width: 3840, height: 2160 }, audio: 'system', dir: '/tmp/x' });
  assert.equal(plan.variants, 3);
  assert.ok(plan.ffmpeg.includes('v:0,a:0 v:1,a:1 v:2,a:2'));
});

test('of windows with no title, only one covering the screen is listed (a full-screen video)', () => {
  const list = parseHelperList(JSON.stringify({ displays: [{ id: 1, width: 3456, height: 2234 }], windows: [
    { id: 7, app: 'Safari', title: '', width: 3456, height: 2168 }, { id: 8, app: 'Safari', title: '', width: 1738, height: 1056 }] }));
  assert.deepEqual(list.windows.map((w) => w.label), ['Safari — ⛶ full screen']);
});

test('only stream files can be fetched from a live capture', () => {
  for (const ok of ['live.m3u8', 'v0.m3u8', 's2_00012.ts']) assert.ok(LIVE_FILE.test(ok));
  for (const bad of ['..', 'state.json', 'live.m3u8.tmp', 's1_1.ts/..', 'x.ts', 'v0.m3u8.tmp']) assert.ok(!LIVE_FILE.test(bad));
});
