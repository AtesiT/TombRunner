export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.music = null;
    this.enabled = false;
    this.musicTimer = null;
    this.lastStep = 0;
  }

  init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.master.gain.value = 0.35;

    this.sfx = this.ctx.createGain();
    this.sfx.connect(this.master);
    this.sfx.gain.value = 0.8;

    this.music = this.ctx.createGain();
    this.music.connect(this.master);
    this.music.gain.value = 0.16;
  }

  resume() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    this.enabled = true;
  }

  _osc(freq, dur, type = 'sine', dest = null, when = null) {
    if (!this.ctx || !this.enabled) return;
    const t = when || this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g);
    g.connect(dest || this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  playStep() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const len = this.ctx.sampleRate * 0.04;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const n = this.ctx.createBufferSource();
    n.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    n.connect(g);
    g.connect(this.sfx);
    n.start(t);
    n.stop(t + 0.04);
  }

  playJump() {
    const t = this.ctx.currentTime;
    this._osc(160, 0.14, 'sine', null, t);
    this._osc(300, 0.24, 'sine', null, t + 0.06);
  }

  playArtifact() {
    const t = this.ctx.currentTime;
    [554, 698, 880, 1108].forEach((f, i) => this._osc(f, 0.28, 'sine', null, t + i * 0.07));
  }

  playDeath() {
    const t = this.ctx.currentTime;
    this._osc(110, 0.7, 'sawtooth', null, t);
    this._osc(80, 0.9, 'sawtooth', null, t + 0.12);
  }

  playCheckpoint() {
    const t = this.ctx.currentTime;
    this._osc(520, 0.18, 'square', null, t);
    this._osc(780, 0.3, 'square', null, t + 0.1);
  }

  playLever() {
    const t = this.ctx.currentTime;
    this._osc(200, 0.12, 'square', null, t);
    this._osc(400, 0.18, 'square', null, t + 0.08);
  }

  startMusic() {
    if (!this.ctx || !this.enabled || this.musicTimer) return;
    const seq = [
      [196, 0.5], [220, 0.5], [246, 0.5], [261, 1],
      [246, 0.5], [220, 0.5], [196, 0.5], [174, 1],
      [220, 0.5], [246, 0.5], [261, 0.5], [311, 1],
      [261, 0.5], [246, 0.5], [220, 0.5], [196, 1],
    ];
    let i = 0;
    const tick = () => {
      if (!this.enabled || !this.musicTimer) return;
      const [f, d] = seq[i];
      i = (i + 1) % seq.length;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f, this.ctx.currentTime);
      g.gain.setValueAtTime(0.12, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0003, this.ctx.currentTime + d);
      o.connect(g);
      g.connect(this.music);
      o.start();
      o.stop(this.ctx.currentTime + d + 0.1);
      this.musicTimer = setTimeout(tick, d * 850 + 90);
    };
    tick();
  }

  stopMusic() {
    if (this.musicTimer) {
      clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
  }
}

export const audio = new AudioManager();
