import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAvfoundation, parseDshowAudio, captureArgs, LIVE_FILE } from '../server/capture.js';

test('reads screens and sound inputs from the macOS device list', () => {
  const s = parseAvfoundation([
    '[AVFoundation indev @ 0x1] AVFoundation video devices:',
    '[AVFoundation indev @ 0x1] [0] FaceTime HD Camera',
    '[AVFoundation indev @ 0x1] [3] Capture screen 0',
    '[AVFoundation indev @ 0x1] [4] Capture screen 1',
    '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
    '[AVFoundation indev @ 0x1] [1] MacBook Pro Microphone',
  ].join('\n'));
  assert.deepEqual(s.screens, [{ id: '3', label: 'Screen 1' }, { id: '4', label: 'Screen 2' }]);
  assert.deepEqual(s.audio, [{ id: '1', label: 'MacBook Pro Microphone' }]);
  assert.equal(s.supported, true);
  assert.equal(parseAvfoundation(null).supported, false);
});

test('reads sound inputs from the Windows device list', () => {
  assert.deepEqual(parseDshowAudio('[dshow @ 1] "HD Webcam" (video)\n[dshow @ 1] "Stereo Mix (Realtek)" (audio)'), [{ id: 'Stereo Mix (Realtek)', label: 'Stereo Mix (Realtek)' }]);
});

test('builds a capture command per platform, with and without sound', () => {
  const mac = captureArgs({ platform: 'darwin', screen: '3', audio: null, dir: '/tmp/x' });
  assert.ok(mac.includes('3:none') && mac.includes('-an') && mac.includes('h264_videotoolbox'));
  assert.ok(captureArgs({ platform: 'darwin', screen: '3', audio: '1', dir: '/tmp/x' }).includes('3:1'));
  const win = captureArgs({ platform: 'win32', screen: 'desktop', audio: 'Stereo Mix', dir: 'C:\\x' });
  assert.ok(win.includes('gdigrab') && win.includes('audio=Stereo Mix') && win.includes('libx264'));
  assert.ok(captureArgs({ platform: 'linux', screen: ':0', audio: null, dir: '/tmp/x' }).includes('x11grab'));
});

test('only stream files can be fetched from a live capture', () => {
  for (const ok of ['live.m3u8', 's00012.ts']) assert.ok(LIVE_FILE.test(ok));
  for (const bad of ['..', 'state.json', 'live.m3u8.tmp', 's1.ts/..', 'x.ts']) assert.ok(!LIVE_FILE.test(bad));
});
