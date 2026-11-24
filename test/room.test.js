import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';

const movie = { id: 'm', title: 'Test', duration: 100, subs: [] };
const makeRoom = () => new Room({ id: 'r', name: 'Room', movie, isHostKey: (k) => k === 'secret' });
function join(room, name, { hostKey, canHost = true } = {}) {
  const c = { msgs: [], canHost, closed: false, send(m) { this.msgs.push(m); }, close() { this.closed = true; }, last(t) { return this.msgs.filter((m) => m.type === t).at(-1); } };
  room.join(c, { clientId: `${name}-client-id`, name, hostKey });
  return c;
}

test('host key makes a host only on a connection allowed to host', () => {
  const room = makeRoom();
  assert.equal(join(room, 'Host', { hostKey: 'secret' }).last('welcome').you.role, 'host');
  assert.equal(join(room, 'Remote', { hostKey: 'secret', canHost: false }).last('welcome').you.role, 'guest');
  assert.equal(join(room, 'Wrong', { hostKey: 'nope' }).last('welcome').you.role, 'guest');
});

test('only host and co-hosts control playback', () => {
  const room = makeRoom();
  const host = join(room, 'Host', { hostKey: 'secret' }), guest = join(room, 'Guest');
  room.handle(guest, { type: 'control', action: 'play' });
  assert.equal(room.play.playing, false);
  room.handle(host, { type: 'control', action: 'seek', position: 40 });
  room.handle(host, { type: 'control', action: 'play' });
  assert.equal(guest.last('state').state.playing, true);
  assert.ok(Math.abs(room.position() - 40) < 0.5);
  room.handle(guest, { type: 'role', target: host.person.pid, cohost: false }); // guests cannot change roles
  room.handle(host, { type: 'role', target: guest.person.pid, cohost: true });
  room.handle(guest, { type: 'control', action: 'pause' });
  assert.equal(room.play.playing, false);
  room.handle(host, { type: 'control', action: 'seek', position: 9999 });
  assert.equal(room.play.position, 100);
});

test('screen share: needs the remote, one at a time, pauses the movie, ends when the sharer leaves', () => {
  const room = makeRoom();
  const host = join(room, 'Host', { hostKey: 'secret' }), guest = join(room, 'Guest');
  room.handle(guest, { type: 'share', on: true, streamId: 'g' });
  assert.equal(room.share, null);
  room.handle(host, { type: 'control', action: 'play' });
  room.handle(host, { type: 'role', target: guest.person.pid, cohost: true });
  room.handle(guest, { type: 'share', on: true, streamId: 'g' });
  assert.deepEqual(room.share, { pid: guest.person.pid, streamId: 'g' });
  assert.equal(room.play.playing, false);
  room.handle(host, { type: 'share', on: true, streamId: 'h' }); // busy
  assert.equal(room.share.streamId, 'g');
  room.handle(host, { type: 'control', action: 'play' }); // movie stays paused during a share
  assert.equal(room.play.playing, false);
  room.handle(host, { type: 'role', target: guest.person.pid, cohost: false }); // taking the remote ends it
  assert.equal(room.share, null);
  room.handle(host, { type: 'share', on: true, streamId: 'h' });
  room.leave(host);
  assert.equal(room.share, null);
  assert.equal(guest.last('share').share, null);
});

test('seats, chat cleaning and reconnects', () => {
  const room = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B');
  assert.equal(join(room, '  Zed\u0000  ').person.name, 'Zed');
  room.handle(b, { type: 'seat', seat: a.person.seat });
  assert.notEqual(b.person.seat, a.person.seat);
  room.handle(b, { type: 'seat', seat: 9 });
  room.handle(b, { type: 'chat', text: 'x'.repeat(900) });
  assert.equal(a.last('chat').message.text.length, 500);
  room.leave(b);
  const b2 = join(room, 'B');
  assert.equal(b2.person.seat, 9);
  const b3 = join(room, 'B'); // second tab replaces the first
  assert.equal(b2.closed, true);
  assert.equal(room.people.size, 3);
  assert.ok(b3.person);
});

test('the theatre has a limited number of seats', () => {
  const room = makeRoom();
  for (let i = 0; i < 16; i++) join(room, `P${i}`);
  const extra = join(room, 'Extra');
  assert.equal(extra.last('full')?.type, 'full');
  assert.equal(room.people.size, 16);
});

test('signals are relayed only to the named person and carry the true sender', () => {
  const room = makeRoom();
  const a = join(room, 'A'), b = join(room, 'B'), c = join(room, 'C');
  room.handle(a, { type: 'signal', to: b.person.pid, from: c.person.pid, data: { x: 1 } });
  assert.equal(b.last('signal').from, a.person.pid);
  assert.equal(c.last('signal'), undefined);
});
