// A view-only gate for the shared computer's screen.
//
// The screen travels as the RFB (VNC) protocol. People who do not hold the
// remote may watch but must not type or click, and that cannot be left to
// their browser to honour. This reads what a viewer's browser sends and lets
// through only the messages that ask for pictures, dropping key presses,
// pointer movement and clipboard text before they reach the machine.

const HEADER = 12; // "RFB 003.008\n"

// Client message type -> how to find its length once enough bytes are in.
// Returns the total length, or 0 if more bytes are needed to know.
const LENGTH = {
  0: () => 20,                                              // SetPixelFormat
  2: (b) => (b.length < 4 ? 0 : 4 + 4 * b.readUInt16BE(2)), // SetEncodings
  3: () => 10,                                              // FramebufferUpdateRequest
  4: () => 8,                                               // KeyEvent
  5: () => 6,                                               // PointerEvent
  6: (b) => (b.length < 8 ? 0 : 8 + Math.abs(b.readInt32BE(4))), // ClientCutText
  150: () => 10,                                            // EnableContinuousUpdates
  248: (b) => (b.length < 9 ? 0 : 9 + b[8]),                // ClientFence
  250: () => 4,                                             // xvp
  251: (b) => (b.length < 8 ? 0 : 8 + 16 * b[6]),           // SetDesktopSize
  255: (b) => (b.length < 2 ? 0 : b[1] === 0 ? 12 : -1),    // QEMU extended key event
};
const WATCHING = new Set([0, 2, 3, 150, 248]); // what a viewer may send
const MAX_MESSAGE = 1 << 20;

export class ViewOnlyGate {
  constructor() {
    this.pending = Buffer.alloc(0);
    this.handshake = null; // bytes of handshake still to pass through untouched
    this.failed = false;
  }

  // Takes bytes from the viewer's browser; returns the bytes to forward to the
  // machine. Throws on anything it does not recognise, so the caller hangs up.
  push(chunk) {
    if (this.failed) throw new Error('rfb: closed');
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out = [];
    try {
      if (this.handshake === null) {
        if (this.pending.length < HEADER) return Buffer.alloc(0);
        const hello = this.pending.subarray(0, HEADER).toString('latin1');
        const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(hello);
        if (!m) throw new Error('rfb: not a viewer');
        // After the version: 3.3 sends only the "shared" flag; later versions
        // first send the one-byte choice of security type.
        this.handshake = HEADER + (Number(m[2]) >= 7 ? 2 : 1);
      }
      if (this.handshake > 0) {
        const n = Math.min(this.handshake, this.pending.length);
        out.push(this.pending.subarray(0, n));
        this.pending = this.pending.subarray(n);
        this.handshake -= n;
        if (this.handshake > 0) return Buffer.concat(out);
      }
      while (this.pending.length) {
        const type = this.pending[0];
        const sizer = LENGTH[type];
        if (!sizer) throw new Error(`rfb: unknown message ${type}`);
        const size = sizer(this.pending);
        if (size < 0 || size > MAX_MESSAGE) throw new Error('rfb: bad message');
        if (size === 0 || this.pending.length < size) break; // wait for the rest
        if (WATCHING.has(type)) out.push(this.pending.subarray(0, size));
        this.pending = this.pending.subarray(size);
      }
      if (this.pending.length > MAX_MESSAGE) throw new Error('rfb: too much');
    } catch (e) {
      this.failed = true;
      throw e;
    }
    return Buffer.concat(out);
  }
}
