// AudioWorklets für die Sprachbrücke zu Discord.
// Format zum Server: 24 kHz, mono, Int16, 20-ms-Frames (480 Samples).

const RATE = 24000;
const FRAME = 480;
const SILENCE_RMS = 180; // darunter gilt ein Frame als still
const HANGOVER_FRAMES = 15; // nach dem Sprechen noch 300 ms weiter senden

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(FRAME);
    this.length = 0;
    this.phase = 0;
    this.hangover = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      // Herunterrechnen auf 24 kHz: nur jedes passende Sample übernehmen.
      this.phase += RATE;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const s = Math.max(-1, Math.min(1, input[i]));
      this.frame[this.length++] = s * 0x7fff;
      if (this.length === FRAME) this.flush();
    }
    return true;
  }

  flush() {
    this.length = 0;
    let sum = 0;
    for (const v of this.frame) sum += v * v;
    if (Math.sqrt(sum / FRAME) > SILENCE_RMS) this.hangover = HANGOVER_FRAMES;
    if (this.hangover <= 0) return;
    this.hangover--;
    this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
    this.frame = new Int16Array(FRAME);
  }
}

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.index = 0;
    this.phase = 0;
    this.playing = false;
    this.port.onmessage = (event) => {
      this.queue.push(new Int16Array(event.data));
      // Nicht mehr als ~300 ms Rückstand aufbauen.
      if (this.queue.length > 15) this.queue.splice(0, this.queue.length - 4);
    };
  }

  process(_, outputs) {
    const output = outputs[0];
    // Etwas vorpuffern, damit kleine Netzwerkschwankungen nicht knacken.
    if (!this.playing && this.queue.length < 3) return true;
    this.playing = true;
    const channel = output[0];
    for (let i = 0; i < channel.length; i++) {
      if (!this.current || this.index >= this.current.length) {
        this.current = this.queue.shift();
        this.index = 0;
        if (!this.current) {
          this.playing = false;
          break;
        }
      }
      channel[i] = this.current[this.index] / 0x8000;
      this.phase += RATE;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        this.index++;
      }
    }
    for (let c = 1; c < output.length; c++) output[c].set(channel);
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
registerProcessor('pcm-player', PcmPlayer);
