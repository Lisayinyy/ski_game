/**
 * Audio — everything synthesised, no assets. Wind rises with speed, the edges hiss when you
 * carve, gates give a chime, landings thump. Fails silent if WebAudio is unavailable.
 */
export class Audio {
  constructor() {
    this.ready = false;
    this.muted = false;
  }

  init() {
    if (this.ready) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      const ctx = new Ctx();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(ctx.destination);

      // shared white-noise source
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;

      // wind
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.value = 620;
      this.windFilter = windFilter;
      const windSrc = ctx.createBufferSource();
      windSrc.buffer = buf;
      windSrc.loop = true;
      windSrc.connect(windFilter).connect(this.windGain).connect(this.master);
      windSrc.start();

      // edge scrape
      this.edgeGain = ctx.createGain();
      this.edgeGain.gain.value = 0;
      const edgeFilter = ctx.createBiquadFilter();
      edgeFilter.type = 'bandpass';
      edgeFilter.frequency.value = 2600;
      edgeFilter.Q.value = 1.1;
      this.edgeFilter = edgeFilter;
      const edgeSrc = ctx.createBufferSource();
      edgeSrc.buffer = buf;
      edgeSrc.loop = true;
      edgeSrc.connect(edgeFilter).connect(this.edgeGain).connect(this.master);
      edgeSrc.start();

      this.ready = true;
    } catch {
      this.ready = false;
    }
  }

  resume() {
    this.init();
    if (this.ready && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.ready) this.master.gain.value = m ? 0 : 0.9;
  }

  /** Continuous layer: called every frame. */
  ambience(speedRatio, edgeAmount, offPiste) {
    if (!this.ready || this.muted) return;
    const now = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(0.035 + speedRatio * 0.16, now, 0.15);
    this.windFilter.frequency.setTargetAtTime(420 + speedRatio * 1100, now, 0.2);
    const scrape = edgeAmount * speedRatio * (offPiste > 0.4 ? 0.35 : 1);
    this.edgeGain.gain.setTargetAtTime(scrape * 0.075, now, 0.08);
    this.edgeFilter.frequency.setTargetAtTime(1500 + speedRatio * 2600 + offPiste * -600, now, 0.1);
  }

  tone(freq, dur, type = 'triangle', gain = 0.16) {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  burst(freq, dur, gain = 0.2) {
    if (!this.ready || this.muted) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.25), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  gate(combo) { this.tone(560 + Math.min(8, combo) * 70, 0.14, 'triangle', 0.18); }
  miss() { this.tone(180, 0.2, 'sawtooth', 0.10); }
  jump() { this.burst(1800, 0.22, 0.14); }
  land(impact) { this.burst(340 + impact * 12, 0.26, 0.22); }
  crash() { this.burst(220, 0.6, 0.34); this.tone(90, 0.5, 'sine', 0.16); }
  start() { this.tone(660, 0.16); setTimeout(() => this.tone(880, 0.2), 130); }
  finish() {
    [660, 880, 1100].forEach((f, i) => setTimeout(() => this.tone(f, 0.28, 'triangle', 0.2), i * 150));
  }
}
