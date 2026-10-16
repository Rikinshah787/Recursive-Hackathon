import { clamp } from './util.js';
import { MusicEngine, MUSIC_BPM, findTrack } from './music.js';

const BPM = MUSIC_BPM;
// Overall music level into the master bus. The engine output is mastered to peak just under 1.0;
// 0.14 puts the drop at about the same RMS as the old synth loop (~ -27 dBFS), under the SFX.
const MUSIC_LEVEL = 0.14;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.musicOn = true;
    this.startTime = 0;
    this.musicEngine = null;
    this._track = null;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this._syncTrack(true);
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    // SFX are muffled in slow motion (the music has its own, heavier slow-mo treatment)
    this.slowLP = ctx.createBiquadFilter();
    this.slowLP.type = 'lowpass';
    this.slowLP.frequency.value = 20000;
    this.slowLP.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.slowLP);

    // music: procedural anthem (or a user supplied track) -> music on/off gain -> master
    this.music = ctx.createGain();
    this.music.gain.value = this.musicOn ? 1 : 0;
    this.music.connect(this.master);
    this.musicEngine = new MusicEngine(ctx, this.music, { level: MUSIC_LEVEL });
    this.musicEngine.setActive(this.musicOn);

    // shared noise buffer
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    const noise = () => {
      const n = ctx.createBufferSource();
      n.buffer = buf;
      n.loop = true;
      n.start(0, Math.random() * 2);
      return n;
    };
    const filt = (type, f, q = 0.7) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };

    // electric motor: two detuned oscillators + whine
    this.motorG = gain(0);
    this.motorF = filt('lowpass', 600, 1.2);
    this.motorF.connect(this.motorG).connect(this.sfx);
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'triangle';
    this.osc1.connect(this.motorF);
    this.osc2.connect(this.motorF);
    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whineG = gain(0);
    this.whine.connect(this.whineG).connect(this.sfx);
    for (const o of [this.osc1, this.osc2, this.whine]) o.start();

    // thrusters: hiss + rumble
    this.hissG = gain(0);
    noise().connect(filt('highpass', 500)).connect(filt('bandpass', 1800, 0.5)).connect(this.hissG).connect(this.sfx);
    this.rumbleG = gain(0);
    noise().connect(filt('lowpass', 160, 1)).connect(this.rumbleG).connect(this.sfx);

    // tyre squeal
    this.squealF = filt('bandpass', 2300, 14);
    this.squealG = gain(0);
    noise().connect(this.squealF).connect(this.squealG).connect(this.sfx);

    // wind
    this.windG = gain(0);
    this.windF = filt('lowpass', 500, 0.5);
    noise().connect(this.windF).connect(this.windG).connect(this.sfx);

    // crowd bed
    this.crowdG = gain(0.035);
    this.crowdF = filt('bandpass', 700, 0.6);
    noise().connect(this.crowdF).connect(this.crowdG).connect(this.sfx);

    this.startTime = ctx.currentTime + 0.1;
    this.scheduler = setInterval(() => this.schedule(), 25);
    this._setupMusic();
  }

  // look for public/music/track.mp3|ogg; otherwise start the built-in synth anthem
  async _setupMusic() {
    const me = this.musicEngine;
    let track = null;
    try {
      track = await findTrack();
    } catch {
      track = null;
    }
    if (track) {
      try {
        this._attachTrack(track);
      } catch {
        this._track = null;
        me.useExternal(false);
      }
    }
    if (!me.running) {
      me.start(this.ctx.currentTime + 0.06);
      this.startTime = me.startTime;
    }
  }

  _attachTrack(track) {
    const el = new Audio();
    el.src = track.url;
    el.loop = true;
    el.preload = 'auto';
    this.musicEngine.attachTrack(el, track.bpm, track.offset);
    this._track = { el, pending: false, nextTry: 0 };
    el.addEventListener('error', () => {
      // undecodable file: fall back to the synth
      if (this.musicEngine) this.musicEngine.useExternal(false);
      this._track = null;
    });
    this._syncTrack(true);
  }

  // keep the <audio> element playing only while the context runs and music is on
  _syncTrack(force = false) {
    const tr = this._track;
    if (!tr || !this.ctx) return;
    const want = this.musicOn && this.ctx.state === 'running';
    if (want && tr.el.paused && !tr.pending) {
      // after a rejected play() (autoplay policy) retry at most every 1.5 s, or on the next gesture
      if (!force && performance.now() < tr.nextTry) return;
      tr.pending = true;
      const done = (ok) => {
        tr.pending = false;
        if (!ok) tr.nextTry = performance.now() + 1500;
      };
      const p = tr.el.play();
      if (p && p.then) p.then(() => done(true), () => done(false));
      else done(true);
    } else if (!want && !tr.el.paused) tr.el.pause();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  // muffled sound while time is slowed down
  setSlowmo(amount) {
    if (!this.slowLP) return;
    const f = amount > 0.05 ? 20000 * Math.pow(0.03, amount) : 20000;
    this.slowLP.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.08);
    if (this.musicEngine) this.musicEngine.setSlowmo(amount);
  }

  boom() {
    if (!this.ctx) return;
    this.thud(2.2);
    this.whoosh();
  }

  setMusic(on) {
    this.musicOn = on;
    if (this.music) this.music.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.1);
    if (this.musicEngine) this.musicEngine.setActive(on);
    this._syncTrack(true);
  }

  // phase within the current beat, 0..1 (also used to pulse the lights)
  beatPhase(fallbackTime) {
    if (this.musicEngine && this.musicEngine.running) return this.musicEngine.beatPhase();
    const spb = 60 / BPM;
    const t = this.ctx ? this.ctx.currentTime - this.startTime : fallbackTime || 0;
    return ((t / spb) % 1 + 1) % 1;
  }

  schedule() {
    if (this.musicEngine) this.musicEngine.schedule(this.ctx.currentTime + 0.12);
  }

  env(g, t, a, peak, dec) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
  }

  update(v, dt) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const sp = v.vel.length();
    const fs = Math.abs(v.forwardSpeed);
    const set = (param, val, tc = 0.06) => param.setTargetAtTime(val, now, tc);
    const throttle = v.lastThrottle || 0;
    const spinBoost = v.burnout ? 38 : 0;
    const f = 38 + (fs + spinBoost) * 4.2;
    set(this.osc1.frequency, f);
    set(this.osc2.frequency, f * 2.01);
    set(this.whine.frequency, 600 + (fs + spinBoost) * 42);
    set(this.motorF.frequency, 300 + fs * 30 + throttle * 600);
    set(this.motorG.gain, 0.02 + throttle * 0.06 + Math.min(fs, 40) * 0.0012);
    set(this.whineG.gain, Math.min(0.03, 0.004 + (fs + spinBoost) * 0.0006) * (0.4 + throttle * 0.6));
    set(this.hissG.gain, v.thrust * 0.55);
    set(this.rumbleG.gain, v.thrust * 0.9);
    let slip = 0;
    for (const w of v.wheels) slip = Math.max(slip, w.contact ? w.slip : 0);
    set(this.squealG.gain, slip * 0.12);
    set(this.squealF.frequency, 2100 + Math.sin(now * 23) * 200);
    set(this.windG.gain, clamp(sp / 60, 0, 1) * 0.12);
    set(this.windF.frequency, 300 + sp * 20);

    // music reacts to the driving (intensity, air-time risers, landing impacts, stunt build-ups)
    if (this.musicEngine && this.ctx.state === 'running') this.musicEngine.react(v, dt);
    if (this._track) this._syncTrack();
  }

  cheer(intensity = 1) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const g = this.crowdG.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0.06 + 0.22 * intensity, now + 0.25);
    g.setTargetAtTime(0.035, now + 0.9, 0.9);
    this.crowdF.frequency.setTargetAtTime(900, now, 0.1);
    this.crowdF.frequency.setTargetAtTime(700, now + 1, 0.5);
    // a few whistles
    for (let i = 0; i < Math.round(2 + intensity * 3); i++) {
      const t = now + 0.1 + Math.random() * 0.8;
      const o = this.ctx.createOscillator();
      const og = this.ctx.createGain();
      o.frequency.setValueAtTime(1600 + Math.random() * 600, t);
      o.frequency.exponentialRampToValueAtTime(2600 + Math.random() * 800, t + 0.25);
      o.frequency.exponentialRampToValueAtTime(1500, t + 0.5);
      this.env(og, t, 0.03, 0.02 * intensity, 0.45);
      o.connect(og).connect(this.sfx);
      o.start(t);
      o.stop(t + 0.6);
    }
  }

  blip(freq = 880, dur = 0.12, vol = 0.12, type = 'sine') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    this.env(g, t, 0.005, vol, dur);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  chime() {
    [784, 988, 1319].forEach((f, i) => setTimeout(() => this.blip(f, 0.35, 0.09, 'triangle'), i * 70));
  }

  whoosh() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(3000, t + 0.35);
    const g = this.ctx.createGain();
    this.env(g, t, 0.05, 0.4, 0.4);
    n.connect(f).connect(g).connect(this.sfx);
    n.start(t);
    n.stop(t + 0.5);
  }

  thud(strength = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.25);
    const g = this.ctx.createGain();
    this.env(g, t, 0.004, clamp(0.25 * strength, 0.05, 0.8), 0.35);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.45);
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const ng = this.ctx.createGain();
    this.env(ng, t, 0.002, clamp(0.2 * strength, 0.03, 0.6), 0.25);
    n.connect(f).connect(ng).connect(this.sfx);
    n.start(t, Math.random());
    n.stop(t + 0.3);
  }
}
