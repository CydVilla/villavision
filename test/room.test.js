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
  assert.equal(room.share?.kind, 'live');
});

test('only a host in the room can put a captured screen up, and it ends when they leave', () => {
  const room = makeRoom();
  let ended = 0;
  room.onLiveEnd = () => ended++;
  const host = join(room, 'Host', { hostKey: 'secret' }), guest = join(room, 'Guest');
  assert.equal(room.startLive(guest.last('welcome').you.pid), false);
  assert.equal(room.startLive('nobody'), false);
  assert.equal(room.startLive(host.last('welcome').you.pid), true);
  assert.equal(guest.last('share').share.kind, 'live');
  room.handle(guest, { type: 'share', on: false });
  assert.equal(room.share?.kind, 'live');
  room.leave(host);
  assert.equal(room.share, null);
  assert.equal(ended, 1);
});

test('the shared computer belongs to the theatre and only the host can take it down', () => {
  const room = makeRoom();
  let ended = 0;
  room.onDeskEnd = () => ended++;
  const host = join(room, 'Host', { hostKey: 'secret' }), guest = join(room, 'Guest');
  assert.equal(room.startDesk(guest.last('welcome').you.pid), false);
  assert.equal(room.startDesk(host.last('welcome').you.pid), true);
  assert.equal(guest.last('share').share.kind, 'desk');
  room.handle(guest, { type: 'share', on: false });
  room.handle(guest, { type: 'share', on: true, streamId: 'x' });
  assert.equal(room.share.kind, 'desk');
  room.leave(host);
  assert.equal(room.share.kind, 'desk'); // still there when the host steps out
  const back = join(room, 'Host', { hostKey: 'secret' });
  room.handle(back, { type: 'share', on: false });
  assert.equal(room.share, null);
  assert.equal(ended, 1);
});

test('a private ticket identifies one person and is never shown to others', () => {
  const room = makeRoom();
  const a = join(room, 'Ana'), b = join(room, 'Ben');
  const ticket = a.last('welcome').you.ticket;
  assert.equal(room.personByTicket(ticket).name, 'Ana');
  assert.equal(room.personByTicket('nope'), null);
  assert.equal(room.personByTicket(undefined), null);
  assert.ok(!JSON.stringify(b.msgs).includes(ticket));
});
