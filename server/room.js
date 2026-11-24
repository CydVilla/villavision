// One theatre room. Transport-agnostic on purpose: a "conn" is anything with
// send(obj) and close(), so this class can later sit behind a different
// runtime (e.g. a Cloudflare Durable Object) without changes.
import crypto from 'node:crypto';

export const SEATS = 16;
const MAX_CHAT = 100;
const rid = (n = 6) => crypto.randomBytes(n).toString('base64url');
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export class Room {
  constructor({ id, name, movie, position = 0, isHostKey, onChange, ice }) {
    this.id = id;
    this.name = name;
    this.movie = movie;
    this.isHostKey = isHostKey;
    this.onChange = onChange || (() => {});
    this.play = { playing: false, position, at: Date.now(), by: null };
    this.people = new Map(); // pid -> person (connected)
    this.remembered = new Map(); // clientId -> { pid, role, seat }
    this.chat = [];
    this.share = null; // { pid, streamId } while someone is sharing their screen
    this.ice = ice || null;
  }

  position() {
    const p = this.play;
    const pos = p.playing ? p.position + (Date.now() - p.at) / 1000 : p.position;
    return Math.min(Math.max(pos, 0), this.movie.duration);
  }

  // Called on a timer by the host process: stop the clock at the end credits.
  tick() {
    if (this.play.playing && this.position() >= this.movie.duration) {
      this.setPlay(false, this.movie.duration, null);
    }
  }

  setPlay(playing, position, by) {
    this.play = { playing, position, at: Date.now(), by };
    this.broadcast({ type: 'state', state: this.play, now: Date.now() });
    this.onChange();
  }

  setShare(share) {
    this.share = share;
    this.broadcast({ type: 'share', share });
  }

  publicPeople() {
    return [...this.people.values()].map(({ pid, sid, name, role, seat, mic, cam, streamId }) => ({ pid, sid, name, role, seat, mic, cam, streamId }));
  }

  broadcast(msg, except) {
    for (const p of this.people.values()) if (p.conn !== except) p.conn.send(msg);
  }

  say(text, kind) {
    const m = { id: rid(), system: true, kind, text, at: Date.now() };
    this.chat.push(m);
    if (this.chat.length > MAX_CHAT) this.chat.shift();
    this.broadcast({ type: 'chat', message: m });
  }

  join(conn, msg) {
    const clientId = String(msg.clientId || '');
    if (clientId.length < 8 || clientId.length > 80) return conn.close();
    const name = clean(msg.name, 24) || 'Guest';

    let mem = this.remembered.get(clientId);
    if (!mem) {
      if (this.people.size >= SEATS) {
        conn.send({ type: 'full' });
        return conn.close();
      }
      mem = { pid: rid(), role: 'guest', seat: null };
      if (this.remembered.size >= 500) this.remembered.delete(this.remembered.keys().next().value);
      this.remembered.set(clientId, mem);
    }
    if (msg.hostKey && conn.canHost && this.isHostKey(msg.hostKey)) mem.role = 'host';

    // Same person opening a second tab replaces the first one.
    const old = this.people.get(mem.pid);
    if (old) {
      old.conn.send({ type: 'replaced' });
      old.conn.person = null;
      old.conn.close();
      this.people.delete(mem.pid);
      if (this.share?.pid === mem.pid) this.setShare(null);
    }

    const taken = new Set([...this.people.values()].map((p) => p.seat));
    if (mem.seat == null || taken.has(mem.seat)) {
      mem.seat = null;
      for (let i = 0; i < SEATS; i++) if (!taken.has(i)) { mem.seat = i; break; }
      if (mem.seat == null) {
        conn.send({ type: 'full' });
        return conn.close();
      }
    }

    const person = { pid: mem.pid, sid: rid(4), name, role: mem.role, seat: mem.seat, mic: false, cam: false, streamId: null, conn, mem, lastReact: 0, lastChat: 0 };
    conn.person = person;
    this.people.set(person.pid, person);

    conn.send({
      type: 'welcome',
      you: { pid: person.pid, role: person.role },
      room: { id: this.id, name: this.name, seats: SEATS },
      movie: { title: this.movie.title, duration: this.movie.duration, subs: this.movie.subs || [] },
      state: this.play,
      share: this.share,
      ice: this.ice,
      now: Date.now(),
      people: this.publicPeople(),
      chat: this.chat,
    });
    this.broadcast({ type: 'people', people: this.publicPeople() }, conn);
    if (!old) this.say(name, 'joined');
  }

  leave(conn) {
    const person = conn.person;
    if (!person || this.people.get(person.pid) !== person) return;
    this.people.delete(person.pid);
    if (this.share?.pid === person.pid) this.setShare(null);
    this.broadcast({ type: 'people', people: this.publicPeople() });
    this.say(person.name, 'left');
  }

  handle(conn, msg) {
    const me = conn.person;
    if (!me) return;
    const canControl = me.role === 'host' || me.role === 'cohost';

    switch (msg.type) {
      case 'ping':
        conn.send({ type: 'pong', t0: msg.t0, t1: Date.now() });
        break;

      case 'control': {
        if (!canControl || this.share) return;
        if (msg.action === 'play') this.setPlay(true, this.position() >= this.movie.duration ? 0 : this.position(), me.name);
        else if (msg.action === 'pause') this.setPlay(false, this.position(), me.name);
        else if (msg.action === 'seek') {
          const pos = Number(msg.position);
          if (!Number.isFinite(pos)) return;
          this.setPlay(this.play.playing, Math.min(Math.max(pos, 0), this.movie.duration), me.name);
        }
        break;
      }

      case 'role': {
        if (me.role !== 'host') return;
        const target = this.people.get(String(msg.target));
        if (!target || target.role === 'host') return;
        target.role = target.mem.role = msg.cohost ? 'cohost' : 'guest';
        if (target.role === 'guest' && this.share?.pid === target.pid) this.setShare(null);
        target.conn.send({ type: 'role', role: target.role });
        this.broadcast({ type: 'people', people: this.publicPeople() });
        break;
      }

      case 'seat': {
        const seat = Number(msg.seat);
        if (!Number.isInteger(seat) || seat < 0 || seat >= SEATS) return;
        if ([...this.people.values()].some((p) => p.seat === seat)) return;
        me.seat = me.mem.seat = seat;
        this.broadcast({ type: 'people', people: this.publicPeople() });
        break;
      }

      case 'media':
        me.mic = !!msg.mic;
        me.cam = !!msg.cam;
        me.streamId = clean(msg.streamId, 64) || null;
        this.broadcast({ type: 'people', people: this.publicPeople() });
        break;

      case 'chat': {
        const text = clean(msg.text, 500);
        if (!text || Date.now() - me.lastChat < 300) return;
        me.lastChat = Date.now();
        const m = { id: rid(), pid: me.pid, name: me.name, text, at: Date.now() };
        this.chat.push(m);
        if (this.chat.length > MAX_CHAT) this.chat.shift();
        this.broadcast({ type: 'chat', message: m });
        break;
      }

      case 'react': {
        const now = Date.now();
        if (now - me.lastReact < 150) return;
        me.lastReact = now;
        const emoji = clean(msg.emoji, 8);
        if (emoji) this.broadcast({ type: 'react', pid: me.pid, emoji });
        break;
      }

      case 'share': {
        // Screen sharing takes over the big screen. Only the host and people
        // holding the remote may start one; the host can stop anyone's.
        if (msg.on) {
          const streamId = clean(msg.streamId, 64);
          if (!canControl || !streamId || (this.share && this.share.pid !== me.pid)) return;
          if (this.play.playing) this.setPlay(false, this.position(), me.name);
          this.setShare({ pid: me.pid, streamId });
        } else if (this.share && (this.share.pid === me.pid || me.role === 'host')) this.setShare(null);
        break;
      }

      case 'signal': {
        // WebRTC handshake relay for voice and webcam (media itself is peer to peer).
        const target = this.people.get(String(msg.to));
        if (target) target.conn.send({ type: 'signal', from: me.pid, sid: me.sid, data: msg.data });
        break;
      }
    }
  }
}
