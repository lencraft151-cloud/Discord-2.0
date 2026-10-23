// Audioformate der Sprachbrücke:
// - Browser <-> Server: 24 kHz, mono, 16 Bit, 20-ms-Frames (480 Samples = 960 Bytes)
// - Server <-> Discord: 48 kHz, stereo, 16 Bit, 20-ms-Frames (960 Samples × 2 Kanäle = 3840 Bytes)

export const FRAME_MS = 20;
export const WEB_FRAME_SAMPLES = 480;
export const WEB_FRAME_BYTES = WEB_FRAME_SAMPLES * 2;
export const DISCORD_FRAME_BYTES = 3840;

const clamp = (v) => (v > 32767 ? 32767 : v < -32768 ? -32768 : v);

// Liest einen Browser-Frame. Kopiert, falls der Puffer nicht auf 2 Bytes ausgerichtet ist.
export function toWebFrame(data) {
  if (!(data instanceof ArrayBuffer || ArrayBuffer.isView(data))) return null;
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength !== WEB_FRAME_BYTES) return null;
  const aligned = bytes.byteOffset % 2 === 0 ? bytes : bytes.slice();
  return new Int16Array(aligned.buffer, aligned.byteOffset, WEB_FRAME_SAMPLES);
}

export function mixFrames(frames) {
  if (frames.length === 1) return frames[0];
  const out = new Int16Array(frames[0].length);
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (const frame of frames) sum += frame[i];
    out[i] = clamp(sum);
  }
  return out;
}

// 24 kHz mono -> 48 kHz stereo (linear interpoliert)
export function webToDiscord(frame) {
  const out = Buffer.alloc(DISCORD_FRAME_BYTES);
  for (let i = 0; i < frame.length; i++) {
    const a = frame[i];
    const b = i + 1 < frame.length ? frame[i + 1] : a;
    const mid = (a + b) >> 1;
    const o = i * 8;
    out.writeInt16LE(a, o);
    out.writeInt16LE(a, o + 2);
    out.writeInt16LE(mid, o + 4);
    out.writeInt16LE(mid, o + 6);
  }
  return out;
}

// 48 kHz stereo -> 24 kHz mono (Mittelwert aus 2 Samples × 2 Kanälen)
export function discordToWeb(buffer) {
  const out = new Int16Array(WEB_FRAME_SAMPLES);
  for (let i = 0; i < WEB_FRAME_SAMPLES; i++) {
    const o = i * 8;
    out[i] = (buffer.readInt16LE(o) + buffer.readInt16LE(o + 2) + buffer.readInt16LE(o + 4) + buffer.readInt16LE(o + 6)) >> 2;
  }
  return out;
}

// Puffert Frames mehrerer Sprecher und gibt pro Takt einen gemischten Frame aus.
export class FrameMixer {
  constructor({ maxQueue = 8 } = {}) {
    this.queues = new Map();
    this.maxQueue = maxQueue;
  }

  push(key, frame) {
    let queue = this.queues.get(key);
    if (!queue) this.queues.set(key, (queue = []));
    queue.push(frame);
    // Zu viel Rückstand -> älteste Frames verwerfen, damit die Verzögerung klein bleibt.
    if (queue.length > this.maxQueue) queue.splice(0, queue.length - 2);
  }

  remove(key) {
    this.queues.delete(key);
  }

  next() {
    const frames = [];
    for (const [key, queue] of this.queues) {
      const frame = queue.shift();
      if (frame) frames.push(frame);
      else this.queues.delete(key);
    }
    return frames.length ? mixFrames(frames) : null;
  }
}
