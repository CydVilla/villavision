import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewOnlyGate } from '../server/rfb.js';

const hello = Buffer.from('RFB 003.008\n');
const pick = Buffer.from([1]), init = Buffer.from([1]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);          // press "a"
const pointer = Buffer.from([5, 1, 0, 10, 0, 10]);              // click
const paste = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from('abc')]);
const refresh = Buffer.from([3, 1, 0, 0, 0, 0, 0, 100, 0, 100]); // ask for pictures
const encodings = Buffer.from([2, 0, 0, 2, 0, 0, 0, 7, 0, 0, 0, 16]);
const resize = Buffer.concat([Buffer.from([251, 0, 3, 0, 2, 0, 1, 0]), Buffer.alloc(16)]);

test('a viewer may ask for pictures but not type, click, paste or resize', () => {
  const gate = new ViewOnlyGate();
  const sent = Buffer.concat([hello, pick, init, encodings, key, refresh, pointer, paste, resize, refresh]);
  assert.deepEqual(gate.push(sent), Buffer.concat([hello, pick, init, encodings, refresh, refresh]));
});

test('it works whatever way the bytes are split up', () => {
  const sent = Buffer.concat([hello, pick, init, key, encodings, paste, refresh, pointer]);
  const want = Buffer.concat([hello, pick, init, encodings, refresh]);
  for (const step of [1, 2, 3, 5, 7]) {
    const gate = new ViewOnlyGate(), out = [];
    for (let i = 0; i < sent.length; i += step) out.push(gate.push(sent.subarray(i, i + step)));
    assert.deepEqual(Buffer.concat(out), want, `step ${step}`);
  }
});

test('the oldest protocol version has no security choice byte', () => {
  const gate = new ViewOnlyGate();
  assert.deepEqual(gate.push(Buffer.concat([Buffer.from('RFB 003.003\n'), init, key, refresh])), Buffer.concat([Buffer.from('RFB 003.003\n'), init, refresh]));
});

test('anything unrecognised ends the connection', () => {
  assert.throws(() => new ViewOnlyGate().push(Buffer.from('GET / HTTP/1.1\r\n')));
  const gate = new ViewOnlyGate();
  gate.push(Buffer.concat([hello, pick, init]));
  assert.throws(() => gate.push(Buffer.from([99, 0, 0, 0])));
  assert.throws(() => gate.push(refresh)); // stays closed
});
