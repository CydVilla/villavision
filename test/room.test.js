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

test('screen share: only the host, pauses the movie, keeps it paused, and a browser cannot start one', () => {
  const room = makeRoom();
  const host = join(room, 'Host', { hostKey: 'secret' }), guest = join(room, 'Guest');
  room.handle(host, { type: 'role', target: guest.person.pid, cohost: true });
  room.handle(guest, { type: 'share', on: true, streamId: 'g' });
  room.handle(host, { type: 'share', on: true, streamId: 'h' });
  assert.equal(room.share, null);
  room.handle(host, { type: 'control', action: 'play' });
  assert.equal(room.startLive(host.person.pid), true);
  assert.equal(room.play.playing, false);
  room.handle(host, { type: 'control', action: 'play' }); // movie stays paused during a share
  assert.equal(room.play.playing, false);
  room.handle(host, { type: 'share', on: false });
  assert.equal(room.share, null);
  assert.equal(guest.last('share').share, null);
});

test('a theatre with no film ignores playback controls but allows screen sharing', () => {
  const room = new Room({ id: 'r', name: 'Room', movie: { id: null, title: null, duration: 0, subs: [] }, isHostKey: (k) => k === 'secret' });
  const host = join(room, 'Host', { hostKey: 'secret' });
  room.handle(host, { type: 'control', action: 'play' });
  assert.equal(room.play.playing, false);
  assert.equal(room.startLive(host.person.pid), true);
  assert.ok(room.share);
});

test('only a host in the room can put a captured screen up, and only the host can take it down', () => {
  const room = makeRoom();
  const ended = [];
  room.onLiveEnd = (why) => ended.push(why);
  const host = join(room, 'Host', { hostKey: 'secret' }), guest = join(room, 'Guest');
  assert.equal(room.startLive(guest.last('welcome').you.pid), false);
  assert.equal(room.startLive('nobody'), false);
  assert.equal(room.startLive(host.last('welcome').you.pid), true);
  assert.equal(guest.last('share').share.pid, host.person.pid);
  room.handle(guest, { type: 'share', on: false });
  assert.ok(room.share);
  room.handle(host, { type: 'share', on: false });
  assert.equal(room.share, null);
  assert.deepEqual(ended, ['Host stopped it']);
});

test('a share survives the host dropping out and coming back, and ends if they stay away', async () => {
  const room = new Room({ id: 'r', name: 'Room', movie, isHostKey: (k) => k === 'secret', shareGrace: 40 });
  const ended = [];
  room.onLiveEnd = (why) => ended.push(why);
  const host = join(room, 'Host', { hostKey: 'secret' });
  join(room, 'Guest');
  room.startLive(host.person.pid);
  room.leave(host); // their tab dozed behind the shared window
  assert.ok(room.share);
  const back = join(room, 'Host', { hostKey: 'secret' });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(room.share);
  join(room, 'Host', { hostKey: 'secret' }); // a second tab replaces the first
  assert.ok(room.share);
  assert.equal(back.closed, true);
  room.leave([...room.people.values()].find((p) => p.name === 'Host').conn);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(room.share, null);
  assert.deepEqual(ended, ['the host left the theatre']);
});
