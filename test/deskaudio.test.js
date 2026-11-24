import test from 'node:test';
import assert from 'node:assert/strict';
import { Mp4Splitter } from '../server/deskaudio.js';

const box = (type, size = 16) => { const b = Buffer.alloc(size, type.charCodeAt(0)); b.writeUInt32BE(size, 0); b.write(type, 4, 'latin1'); return b; };
const collect = () => { const got = { init: [], fragments: [] }; return { got, splitter: new Mp4Splitter({ onInit: (b) => got.init.push(b), onFragment: (b) => got.fragments.push(b) }) }; };

test('splits a live stream into one init piece and whole fragments', () => {
  const ftyp = box('ftyp', 24), moov = box('moov', 40), moof1 = box('moof', 32), mdat1 = box('mdat', 100), moof2 = box('moof', 32), mdat2 = box('mdat', 60);
  const stream = Buffer.concat([ftyp, moov, moof1, mdat1, moof2, mdat2]);
  for (const step of [1, 7, 33, stream.length]) {
    const { got, splitter } = collect();
    for (let i = 0; i < stream.length; i += step) splitter.push(stream.subarray(i, i + step));
    assert.deepEqual(got.init, [Buffer.concat([ftyp, moov])], `step ${step}`);
    assert.deepEqual(got.fragments, [Buffer.concat([moof1, mdat1]), Buffer.concat([moof2, mdat2])], `step ${step}`);
  }
});

test('ignores boxes it has no use for and rejects what is not a stream', () => {
  const { got, splitter } = collect();
  splitter.push(Buffer.concat([box('ftyp'), box('free'), box('moov'), box('mdat'), box('styp'), box('moof'), box('mdat')]));
  assert.equal(got.init.length, 1);
  assert.equal(got.fragments.length, 1); // the stray mdat with no moof is skipped
  assert.throws(() => collect().splitter.push(Buffer.from('HTTP/1.1 400 Bad Request\r\n')));
});
