// Sound from the shared computer.
//
// Inside the virtual machine, ffmpeg turns everything the desktop plays into a
// live fragmented-MP4 (AAC) stream on a TCP port. This connects to it once and
// hands the stream out in the pieces a browser's player needs: one "init"
// piece that describes the sound, then a steady run of small fragments. A
// viewer who joins late gets the init piece first and then whatever is live.
import net from 'node:net';

// Splits a fragmented-MP4 byte stream into its init segment and fragments.
export class Mp4Splitter {
  constructor({ onInit, onFragment }) {
    this.onInit = onInit;
    this.onFragment = onFragment;
    this.pending = Buffer.alloc(0);
    this.init = [];
    this.moof = null;
  }

  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      if (this.pending.length < 8) return;
      let size = this.pending.readUInt32BE(0), header = 8;
      const type = this.pending.toString('latin1', 4, 8);
      if (size === 1) {
        if (this.pending.length < 16) return;
        size = Number(this.pending.readBigUInt64BE(8));
        header = 16;
      }
      if (size < header || size > 64 * 1024 * 1024 || !/^[\x20-\x7e]{4}$/.test(type)) throw new Error('mp4: not a stream');
      if (this.pending.length < size) return;
      const box = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      if (type === 'ftyp') this.init = [box];
      else if (type === 'moov') { this.init.push(box); this.onInit(Buffer.concat(this.init)); }
      else if (type === 'moof') this.moof = box;
      else if (type === 'mdat' && this.moof) { this.onFragment(Buffer.concat([this.moof, box])); this.moof = null; }
    }
  }
}

// Keeps a connection to the machine's sound stream for as long as it runs.
// onInit(buf) is called each time the stream (re)starts; onFragment(buf) for
// every piece of sound. Returns { stop() }.
export function listenToDesk({ host, port, onInit, onFragment }) {
  let stopped = false, socket = null, timer = null;
  const connect = () => {
    if (stopped) return;
    const splitter = new Mp4Splitter({ onInit, onFragment });
    socket = net.connect({ host, port });
    socket.setNoDelay(true);
    socket.on('data', (d) => { try { splitter.push(d); } catch { socket.destroy(); } });
    socket.on('error', () => {});
    socket.on('close', () => { if (!stopped) timer = setTimeout(connect, 1000); });
  };
  connect();
  return { stop() { stopped = true; clearTimeout(timer); socket?.destroy(); } };
}
