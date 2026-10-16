// Procedural soundtrack: a cinematic electronic "stunt show" anthem, synthesised entirely with
// Web Audio (no samples are downloaded). 126 BPM, A minor, Am - F - C - G.
//
// The engine works on any BaseAudioContext (AudioContext or OfflineAudioContext), so the same code
// can be rendered offline for testing:  new MusicEngine(ctx, destination).start(0); engine.schedule(t)
//
// Signal flow
//   instruments -> buses (HPF on non-bass) -> side-chain duck gains -> synthGate -+
//   gameplay fx (landing impacts, air riser) ------------------------------------+-> synthSum
//   synthSum -> saturation (WaveShaper) -> glue compressor -> postIn
//   reverb sends -> convolver (generated stereo IR) -> ducked return -> postIn
//   optional real track (<audio> element) -> trackGain -> postIn
//   postIn -> tone low-pass (intensity / slow-mo) -> safety soft-clip -> out (level) -> destination

export const MUSIC_BPM = 126;
const SPB = 60 / MUSIC_BPM; // seconds per beat
const STEP = SPB / 4; // one 16th note
const BAR = SPB * 4;
const TRACK_LEVEL = 0.85; // gain applied to an external (already mastered) track

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const frac = (x) => ((x % 1) + 1) % 1;

// ---------------------------------------------------------------------------------------------
// Harmony / patterns
// ---------------------------------------------------------------------------------------------
// root: bass MIDI note, stab: supersaw voicing, pad: pad voicing, arp: pluck tones, choir: formant pad
const CHORDS = {
  Am: { name: 'Am', root: 33, stab: [57, 60, 64, 69], pad: [52, 57, 60, 64], arp: [69, 72, 76, 81], choir: [64, 69, 72] },
  F: { name: 'F', root: 29, stab: [57, 60, 65, 69], pad: [53, 57, 60, 65], arp: [65, 69, 72, 77], choir: [65, 69, 72] },
  C: { name: 'C', root: 36, stab: [55, 60, 64, 67], pad: [52, 55, 60, 64], arp: [67, 72, 76, 79], choir: [64, 67, 72] },
  G: { name: 'G', root: 31, stab: [55, 59, 62, 67], pad: [50, 55, 59, 62], arp: [67, 71, 74, 79], choir: [62, 67, 71] },
  E: { name: 'E', root: 28, stab: [56, 59, 64, 68], pad: [52, 56, 59, 64], arp: [68, 71, 76, 80], choir: [64, 68, 71] },
};

function chordName(sec, bar) {
  switch (sec.name) {
    case 'intro':
      return ['Am', 'F', 'C', 'G'][bar % 4];
    case 'build':
      return sec.bars <= 2 ? ['G', 'E'][bar % 2] : ['F', 'C', 'G', 'E'][bar % 4];
    case 'drop':
      return bar % 8 === 7 ? 'E' : ['Am', 'F', 'C', 'G'][bar % 4];
    default: // breakdown
      return bar % 8 === 7 ? 'E' : ['F', 'C', 'G', 'Am'][bar % 4];
  }
}

// lead hook, one bar per chord: [step, midi, length in steps] (3-3-2 syncopation)
const HOOK = {
  Am: [[0, 76, 3], [3, 76, 3], [6, 74, 2], [8, 72, 2], [10, 74, 2], [12, 76, 4]],
  F: [[0, 77, 3], [3, 76, 3], [6, 72, 2], [8, 69, 2], [10, 72, 2], [12, 72, 4]],
  C: [[0, 79, 3], [3, 76, 3], [6, 72, 2], [8, 67, 2], [10, 72, 2], [12, 76, 4]],
  G: [[0, 74, 3], [3, 74, 3], [6, 71, 2], [8, 67, 2], [10, 71, 2], [12, 74, 2], [14, 79, 2]],
  E: [[0, 71, 3], [3, 71, 3], [6, 68, 2], [8, 64, 2], [10, 68, 2], [12, 71, 2], [14, 76, 2]],
};
const HOOK_AT = {};
for (const k of Object.keys(HOOK)) {
  HOOK_AT[k] = new Array(16).fill(null);
  for (const n of HOOK[k]) HOOK_AT[k][n[0]] = n;
}
const ARP = [0, 1, 2, 3, 1, 2, 3, 2, 0, 1, 2, 3, 1, 2, 3, 2];
const STABS = new Set([0, 3, 6, 8, 11, 14]);

// ---------------------------------------------------------------------------------------------
// Offline DSP used to pre-render one-shots / impulse response once at start-up
// ---------------------------------------------------------------------------------------------
function biquad(x, type, f0, q, sr) {
  const w = (2 * Math.PI * Math.min(f0, sr * 0.45)) / sr;
  const cw = Math.cos(w);
  const al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0;
  } else if (type === 'highpass') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0;
  } else {
    b0 = al; b1 = 0; b2 = -al; // band-pass, 0 dB peak
  }
  const a0 = 1 + al;
  const c1 = (-2 * cw) / a0, c2 = (1 - al) / a0;
  b0 /= a0; b1 /= a0; b2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - c1 * y1 - c2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

function noiseArr(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1;
  return a;
}

function toBuffer(ctx, chans, peak = 1) {
  let m = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
  const k = m > 0 ? peak / m : 1;
  const buf = ctx.createBuffer(chans.length, chans[0].length, ctx.sampleRate);
  chans.forEach((c, ch) => {
    for (let i = 0; i < c.length; i++) c[i] *= k;
    buf.getChannelData(ch).set(c);
  });
  return buf;
}

// kick: sine sweep 150 -> 45 Hz, click transient, tanh drive
function makeKick(ctx) {
  const sr = ctx.sampleRate, len = 0.48, n = Math.floor(sr * len);
  const d = new Float32Array(n);
  const click = biquad(noiseArr(Math.floor(sr * 0.012)), 'highpass', 2500, 0.7, sr);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 45 + 105 * Math.exp(-t / 0.03) + 220 * Math.exp(-t / 0.003);
    ph += (2 * Math.PI * f) / sr;
    const env = Math.min(1, t / 0.0012) * Math.exp(-t / 0.2) * Math.min(1, (len - t) / 0.06);
    let x = Math.sin(ph) * env;
    if (i < click.length) x += click[i] * 0.55 * Math.exp(-t / 0.003);
    d[i] = Math.tanh(1.9 * x);
  }
  return toBuffer(ctx, [d], 1);
}

// clap: four band-passed noise bursts + tail + ~190 Hz tone body
function makeClap(ctx) {
  const sr = ctx.sampleRate, n = Math.floor(sr * 0.5);
  const src = noiseArr(n);
  const a = biquad(src.slice(), 'bandpass', 1150, 1.1, sr);
  const b = biquad(src.slice(), 'bandpass', 2400, 1.4, sr);
  const d = new Float32Array(n);
  const bursts = [0, 0.0105, 0.0205, 0.031], amps = [0.9, 0.75, 0.65, 1];
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let env = 0;
    for (let k = 0; k < 4; k++) {
      const dt = t - bursts[k];
      if (dt >= 0) env = Math.max(env, amps[k] * Math.exp(-dt / 0.0055));
    }
    const dt = t - 0.031;
    if (dt >= 0) env = Math.max(env, 0.85 * Math.exp(-dt / 0.13));
    ph += (2 * Math.PI * (185 + 25 * Math.exp(-t / 0.02))) / sr;
    const body = Math.sin(ph) * Math.exp(-t / 0.03) * Math.min(1, t / 0.001) * 0.1;
    d[i] = (a[i] + b[i] * 0.6) * env * Math.min(1, (0.5 - t) / 0.05) + body;
  }
  return toBuffer(ctx, [d], 1);
}

// snare (for rolls/fills): noise burst + 180-200 Hz body
function makeSnare(ctx) {
  const sr = ctx.sampleRate, len = 0.32, n = Math.floor(sr * len);
  const nz = biquad(biquad(noiseArr(n), 'highpass', 900, 0.7, sr), 'lowpass', 9000, 0.7, sr);
  const d = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * (180 + 22 * Math.exp(-t / 0.015))) / sr;
    const body = Math.sin(ph) * Math.exp(-t / 0.055) * 0.55 + Math.sin(2 * Math.PI * 330 * t) * Math.exp(-t / 0.022) * 0.2;
    const env = Math.min(1, t / 0.0006) * Math.exp(-t / 0.065) * Math.min(1, (len - t) / 0.04);
    d[i] = nz[i] * env * 0.9 + body * Math.min(1, t / 0.0006);
  }
  return toBuffer(ctx, [d], 1);
}

// hi-hat: high-passed noise + 808-style square partials
function makeHat(ctx, decay, len) {
  const sr = ctx.sampleRate, n = Math.floor(sr * len);
  const nz = noiseArr(n);
  const freqs = [205.3, 304.4, 369.6, 522.7, 540, 800];
  const phase = freqs.map(() => Math.random());
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let m = 0;
    for (let k = 0; k < 6; k++) m += frac(freqs[k] * t + phase[k]) < 0.5 ? 1 : -1;
    d[i] = nz[i] * 0.6 + (m / 6) * 0.5;
  }
  biquad(d, 'highpass', 7000, 0.7, sr);
  biquad(d, 'highpass', 7000, 0.7, sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    d[i] *= Math.min(1, t / 0.0008) * Math.exp(-t / decay) * Math.min(1, (len - t) / 0.02);
  }
  return toBuffer(ctx, [d], 1);
}

// crash cymbal, stereo
function makeCrash(ctx) {
  const sr = ctx.sampleRate, len = 2.8, n = Math.floor(sr * len);
  const chans = [];
  for (let ch = 0; ch < 2; ch++) {
    const nz = noiseArr(n);
    const freqs = [296, 387, 512, 663, 791, 1050, 1306, 1557].map((f) => f * (1.9 + Math.random() * 0.2));
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let m = 0;
      for (let k = 0; k < freqs.length; k++) m += frac(freqs[k] * t + k * 0.13) < 0.5 ? 1 : -1;
      d[i] = nz[i] * 0.7 + (m / freqs.length) * 0.35;
    }
    biquad(d, 'highpass', 3200, 0.7, sr);
    biquad(d, 'highpass', 2600, 0.6, sr);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      d[i] *= Math.min(1, t / 0.002) * (0.55 * Math.exp(-t / 0.12) + 0.45 * Math.exp(-t / 0.85)) * Math.min(1, (len - t) / 0.3);
    }
    chans.push(d);
  }
  return toBuffer(ctx, chans, 1);
}

// reverse cymbal swell, exactly one bar long, peaking on the next downbeat
function makeSwell(ctx, crash) {
  const n = Math.min(crash.length, Math.floor(ctx.sampleRate * BAR));
  const chans = [];
  for (let ch = 0; ch < 2; ch++) {
    const src = crash.getChannelData(ch);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = src[n - 1 - i] * Math.pow(i / n, 1.5);
    chans.push(d);
  }
  return toBuffer(ctx, chans, 1);
}

// impact: low sine boom + noise burst
function makeImpact(ctx) {
  const sr = ctx.sampleRate, len = 2.4, n = Math.floor(sr * len);
  const nz = biquad(biquad(noiseArr(n), 'lowpass', 1400, 0.7, sr), 'highpass', 70, 0.7, sr);
  const d = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * (32 + 75 * Math.exp(-t / 0.14))) / sr;
    const boom = Math.sin(ph) * Math.min(1, t / 0.003) * Math.exp(-t / 0.75);
    const burst = nz[i] * 2.2 * Math.exp(-t / 0.13);
    d[i] = Math.tanh(1.5 * (boom + burst)) * Math.min(1, (len - t) / 0.3);
  }
  return toBuffer(ctx, [d], 1);
}

// stereo hall impulse response: pre-delay, early reflections, darkening decaying noise (~2.6 s)
function makeIR(ctx, dur = 2.6) {
  const sr = ctx.sampleRate, n = Math.floor(sr * dur), pre = Math.floor(sr * 0.012);
  const chans = [];
  for (let ch = 0; ch < 2; ch++) {
    const d = new Float32Array(n);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const a = 0.1 + 0.8 * Math.exp(-t / 0.45);
      lp += a * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp((-t * 6.9) / dur) * Math.min(1, t / 0.006);
    }
    for (let k = 0; k < 9; k++) {
      const i = pre + Math.floor(sr * (0.003 + Math.random() * 0.075));
      if (i < n) d[i] += (Math.random() < 0.5 ? -1 : 1) * (0.55 - k * 0.04);
    }
    chans.push(d);
  }
  return toBuffer(ctx, chans, 1);
}

function satCurve(k) {
  const n = 2048, c = new Float32Array(n), tk = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / tk;
  }
  return c;
}

// transparent below 0.8, soft knee above, never exceeds ~0.97
function clipCurve() {
  const n = 4096, c = new Float32Array(n), knee = 0.8, room = 0.18;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
    c[i] = ax <= knee ? x : Math.sign(x) * (knee + room * Math.tanh((ax - knee) / room));
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// Real-track lookup: /music/track.mp3 or .ogg (+ optional track.json {bpm, offset})
// ---------------------------------------------------------------------------------------------
function baseUrl() {
  try {
    const b = import.meta.env && import.meta.env.BASE_URL;
    if (b) return b.endsWith('/') ? b : b + '/';
  } catch {
    /* not running under Vite */
  }
  return '/';
}

export async function findTrack(base = baseUrl()) {
  if (typeof fetch !== 'function') return null;
  const probe = async (url, method) => {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), 2500);
    try {
      return await fetch(url, { method, cache: 'no-store', signal: ctl ? ctl.signal : undefined });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  let url = null;
  for (const ext of ['mp3', 'ogg']) {
    const u = `${base}music/track.${ext}`;
    const r = await probe(u, 'HEAD');
    const ct = r ? (r.headers.get('content-type') || '').toLowerCase() : '';
    // dev servers / SPA hosts answer unknown paths with index.html - only accept real media
    if (r && r.ok && !/text\/|javascript|json/.test(ct)) {
      url = u;
      break;
    }
  }
  if (!url) return null;
  let bpm = MUSIC_BPM, offset = 0;
  const r = await probe(`${base}music/track.json`, 'GET');
  if (r && r.ok) {
    try {
      const j = await r.json();
      if (Number.isFinite(+j.bpm) && +j.bpm >= 40 && +j.bpm <= 300) bpm = +j.bpm;
      if (Number.isFinite(+j.offset)) offset = +j.offset;
    } catch {
      /* not JSON (e.g. SPA fallback) - keep defaults */
    }
  }
  return { url, bpm, offset };
}

// ---------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------
export class MusicEngine {
  constructor(ctx, destination, opts = {}) {
    this.ctx = ctx;
    this.level = opts.level ?? 0.3;
    this.intensity = opts.intensity ?? 0.3;
    this.slowmo = 0;
    this.active = true; // false = music switched off (grid keeps running silently)
    this.external = false; // true = a real track is playing instead of the synth
    this.ext = null;
    this.running = false;
    this.startTime = 0;
    this.stepIndex = 0;
    this.sec = null; // { name, bars, offset?, ext? }
    this.bar = 0;
    this.pending = null; // section to jump to at the next bar line
    this.chord = CHORDS.Am;
    this.dropCount = 0;
    this.fill = 0;
    this.leadEnd = -1;
    this.riser = null;
    this.needMix = false;
    // gameplay state
    this.airTime = 0;
    this.airRiser = null;
    this.airRiserDone = false;
    this.lastImpact = -10;
    this.stuntPrev = false;
    this.stuntReadyAt = 0;
    this._tone = 0;
    this._toneQ = 0;
    this.persistent = [];
    this._buildGraph(destination);
  }

  // ---- graph -------------------------------------------------------------------------------
  _gain(v = 1) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  _filter(type, f, q = 0.707) {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  }

  _osc(type, freq, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    return o;
  }

  _panner(p) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) {
      const s = ctx.createStereoPanner();
      s.pan.value = p;
      return s;
    }
    return this._gain(1);
  }

  _persist(o) {
    o.start(this.ctx.currentTime + Math.random() * 0.02);
    this.persistent.push(o);
    return o;
  }

  _buildGraph(destination) {
    const ctx = this.ctx;
    const G = (v) => this._gain(v);
    const F = (t, f, q) => this._filter(t, f, q);

    // shared buffers
    this.noise = toBuffer(ctx, [noiseArr(ctx.sampleRate * 2)], 1);
    const crash = makeCrash(ctx);
    this.buf = {
      kick: makeKick(ctx),
      clap: makeClap(ctx),
      snare: makeSnare(ctx),
      hat: makeHat(ctx, 0.016, 0.1),
      ohat: makeHat(ctx, 0.11, 0.45),
      crash,
      swell: makeSwell(ctx, crash),
      impact: makeImpact(ctx),
    };

    // output section
    this.out = G(this.level);
    this.out.connect(destination);
    this.finalClip = ctx.createWaveShaper();
    this.finalClip.curve = clipCurve();
    this.finalClip.connect(this.out);
    this.toneLP = F('lowpass', 12000, 0.75);
    this.toneLP.connect(this.finalClip);
    this.postIn = G(1);
    this.postIn.connect(this.toneLP);

    // glue: gentle saturation -> compressor
    this.synthSum = G(1);
    const satIn = G(0.4);
    this.sat = ctx.createWaveShaper();
    this.sat.curve = satCurve(1.3);
    this.sat.oversample = '2x';
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.006;
    this.comp.release.value = 0.16;
    this.synthSum.connect(satIn).connect(this.sat).connect(this.comp).connect(this.postIn);
    this.synthGate = G(1);
    this.synthGate.connect(this.synthSum);
    this.fxBus = G(1);
    this.fxBus.connect(this.synthSum);

    // reverb (send/return)
    this.reverbIn = G(1);
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = makeIR(ctx, 2.6);
    const revHP = F('highpass', 220, 0.7);
    this.revRet = G(1);
    this.duckRev = G(1);
    this.reverbIn.connect(this.convolver).connect(revHP).connect(this.revRet).connect(this.duckRev).connect(this.postIn);
    this.slowSend = G(0); // slow-mo: whole synth mix into the reverb
    this.synthSum.connect(this.slowSend).connect(this.reverbIn);
    const send = (from, amt, to = this.reverbIn) => {
      const g = G(amt);
      from.connect(g).connect(to);
      return g;
    };
    this.fxRev = G(0.35);
    this.fxRev.connect(this.reverbIn);

    // ping-pong delay, dotted 8th
    this.delayIn = G(1);
    this.delayIn.channelCount = 1;
    this.delayIn.channelCountMode = 'explicit';
    this.delayIn.channelInterpretation = 'speakers';
    const dl = ctx.createDelay(2), dr = ctx.createDelay(2);
    dl.delayTime.value = dr.delayTime.value = SPB * 0.75;
    const fb = G(0.42);
    const merger = ctx.createChannelMerger(2);
    this.delayIn.connect(F('highpass', 320, 0.7)).connect(F('lowpass', 5200, 0.7)).connect(dl);
    dl.connect(dr);
    dr.connect(fb).connect(dl);
    dl.connect(merger, 0, 0);
    dr.connect(merger, 0, 1);
    this.delayRet = G(0.55);
    merger.connect(this.delayRet);
    send(this.delayRet, 0.15);

    // side-chained groups
    this.duckHeavy = G(1); // pads, sub, bass, choir
    this.duckLight = G(1); // stabs, arp, lead, delay
    this.duckHeavy.connect(this.synthGate);
    this.duckLight.connect(this.synthGate);
    this.duckers = [[this.duckHeavy, 0.82], [this.duckLight, 0.35], [this.duckRev, 0.5]];
    this.hpHeavy = F('highpass', 140, 0.7);
    this.hpHeavy.connect(this.duckHeavy);
    this.hpLight = F('highpass', 190, 0.7);
    this.hpLight.connect(this.duckLight);
    this.delayRet.connect(this.hpLight);

    // drums
    this.kickBus = G(1);
    this.kickBus.connect(this.synthGate);
    this.drumBus = G(1);
    this.drumBus.connect(F('highpass', 90, 0.7)).connect(this.synthGate);
    send(this.drumBus, 0.1);
    this.hatBus = this._panner(0.18);
    this.hatBus.connect(this.drumBus);

    // pad: detuned saw pairs spread L/R -> low-pass
    this.padLP = F('lowpass', 500, 0.8);
    this.padLevel = G(0.9);
    this.padPanL = this._panner(-0.6);
    this.padPanR = this._panner(0.6);
    this.padPanL.connect(this.padLP);
    this.padPanR.connect(this.padLP);
    this.padLP.connect(this.padLevel).connect(this.hpHeavy);
    send(this.padLevel, 0.4);

    // supersaw stabs: persistent bank, 4 notes x 7 detuned saws, voices panned across the field
    this.stabNorm = G(0.105);
    this.stabLP = F('lowpass', 2000, 1.1);
    this.stabVCA = G(0);
    this.stabBus = G(1);
    this.stabNorm.connect(this.stabLP).connect(this.stabVCA).connect(this.stabBus).connect(this.hpLight);
    send(this.stabBus, 0.22);
    const spread = [-24, -15, -7, 0, 7, 15, 24];
    const pans = [-0.85, -0.55, -0.25, 0, 0.25, 0.55, 0.85];
    const panners = pans.map((p) => {
      const s = this._panner(p);
      s.connect(this.stabNorm);
      return s;
    });
    this.stabOsc = CHORDS.Am.stab.map((m) =>
      spread.map((det, k) => {
        const o = this._osc('sawtooth', mtof(m), det + (Math.random() * 4 - 2));
        o.connect(panners[k]);
        return this._persist(o);
      }),
    );

    // lead: two detuned saws + sub-octave square, vibrato, portamento
    this.leadLP = F('lowpass', 3000, 1.6);
    this.leadVCA = G(0);
    this.leadBus = G(0.3);
    this.leadLP.connect(this.leadVCA).connect(this.leadBus).connect(this.hpLight);
    send(this.leadBus, 0.3, this.delayIn);
    send(this.leadBus, 0.28);
    this.leadOsc = [
      [this._osc('sawtooth', 440, -7), 0.5],
      [this._osc('sawtooth', 440, 7), 0.5],
      [this._osc('square', 440, -1200), 0.28],
    ].map(([o, v]) => {
      o.connect(G(v)).connect(this.leadLP);
      return this._persist(o);
    });
    const vib = this._persist(this._osc('sine', 5.6));
    const vibAmt = G(11);
    vib.connect(vibAmt);
    for (const o of this.leadOsc) vibAmt.connect(o.detune);

    // sub bass (sustained sine, pumped by the side-chain) + offbeat mid bass (saws -> resonant LP)
    this.subOsc = this._persist(this._osc('sine', mtof(33)));
    this.subVCA = G(0);
    this.subOsc.connect(this.subVCA).connect(this.duckHeavy);
    this.bassLP = F('lowpass', 300, 6);
    this.bassVCA = G(0);
    this.bassBus = G(0.3);
    this.bassOsc = [-8, 8].map((det) => {
      const o = this._osc('sawtooth', mtof(45), det);
      o.connect(this.bassLP);
      return this._persist(o);
    });
    this.bassLP.connect(this.bassVCA).connect(this.bassBus).connect(F('highpass', 45, 0.7)).connect(this.duckHeavy);

    // pluck arp
    this.arpLP = F('lowpass', 900, 0.9);
    this.arpLevel = G(0.8);
    this.arpLP.connect(this.arpLevel).connect(this.hpLight);
    send(this.arpLevel, 0.45, this.delayIn);
    send(this.arpLevel, 0.25);

    // "vocal" formant pad (breakdown)
    this.choirIn = G(1);
    this.choirOut = G(3.2);
    this.formants = [[750, 7, 1], [1150, 9, 0.55], [2600, 11, 0.3]].map(([f, q, v]) => {
      const b = F('bandpass', f, q);
      this.choirIn.connect(b);
      b.connect(G(v)).connect(this.choirOut);
      return b;
    });
    this.choirOut.connect(this.hpHeavy);
    send(this.choirOut, 0.6);
    const cvib = this._persist(this._osc('sine', 4.8));
    this.choirVib = G(14);
    cvib.connect(this.choirVib);
  }

  // ---- transport -----------------------------------------------------------------------------
  start(when) {
    if (this.running) return;
    this.running = true;
    this.startTime = when ?? this.ctx.currentTime + 0.1;
    this.stepIndex = 0;
  }

  // schedule every 16th step that starts before `until` (seconds, context time)
  schedule(until) {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    // far behind (throttled background tab): silently catch the grid up instead of firing stray notes
    const catchUp = this.startTime + this.stepIndex * STEP < now - 0.25;
    for (let guard = 0; guard < 4096; guard++) {
      const t = this.startTime + this.stepIndex * STEP;
      if (t >= until) break;
      const s = this.stepIndex & 15;
      // steps that are already late only advance the arrangement
      const live = !catchUp && t >= now - 0.015 && this.active && !this.external;
      if (s === 0) this._advanceBar(t, live);
      if (live) this._playStep(s, t);
      this.stepIndex++;
    }
  }

  setActive(on) {
    if (on && !this.active) this.needMix = true;
    this.active = on;
  }

  // phase within the current beat, 0..1
  beatPhase() {
    if (this.external && this.ext && !this.ext.el.paused) {
      return frac(((this.ext.el.currentTime - this.ext.offset) * this.ext.bpm) / 60);
    }
    const lat = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return frac((this.ctx.currentTime - lat - this.startTime) / SPB);
  }

  get section() {
    return this.sec ? this.sec.name : null;
  }

  // ---- arrangement -----------------------------------------------------------------------
  _next() {
    const s = this.sec;
    switch (s.name) {
      case 'intro':
        return { name: 'build', bars: 4 };
      case 'build':
        return { name: 'drop', bars: 16 };
      case 'drop':
        // keep the party going while the player is going wild
        if (!s.ext && this.intensity > 0.72) return { name: 'drop', bars: 8, offset: 8, ext: true };
        return { name: 'breakdown', bars: 8 };
      default:
        return { name: 'build', bars: 4 };
    }
  }

  _advanceBar(t, live) {
    if (!this.sec) this._enter({ name: 'intro', bars: 8 }, t, live, true);
    else {
      this.bar++;
      const p = this.pending;
      this.pending = null;
      if (p && !(p.name === this.sec.name && p.name !== 'drop')) this._enter(p, t, live);
      else if (this.bar >= this.sec.bars) this._enter(this._next(), t, live);
    }
    const b = this.bar + (this.sec.offset || 0);
    this.chord = CHORDS[chordName(this.sec, b)];
    if (!live) {
      this.needMix = true;
      return;
    }
    if (this.needMix) {
      this.needMix = false;
      this._sectionMix(t);
    }
    this._barEvents(t, b);
  }

  _enter(sec, t, live, first = false) {
    const prev = this.sec;
    if (prev && prev.name === 'build') this._stopBuildRiser(t);
    this.sec = sec;
    this.bar = 0;
    if (sec.name === 'drop' && !sec.ext) this.dropCount++;
    if (!live) return;
    this.needMix = false;
    this._sectionMix(t);
    const n = sec.name;
    if (first) {
      this._impact(t, 0.6, this.synthGate);
      this._crash(t, 0.45);
    }
    if (n === 'build') this._startBuildRiser(t);
    if (n === 'drop') {
      if (sec.ext) this._crash(t, 0.55);
      else if (t - this.lastImpact > 1.8) {
        this._impact(t, 1, this.synthGate);
        this._crash(t, 0.9);
      }
    }
  }

  // levels / filters for the current section
  _sectionMix(t) {
    const n = this.sec.name;
    const set = (param, v, tc = 0.08) => param.setTargetAtTime(v, t, tc);
    const mix = {
      intro: [1.4, 1.2, 0.16],
      build: [0.75, 0.55, 0],
      drop: [0.42, 0.25, 0.4],
      breakdown: [1.2, 0.9, 0.12],
    }[n];
    set(this.padLevel.gain, mix[0], n === 'drop' ? 0.03 : 0.3);
    set(this.arpLevel.gain, mix[1], 0.2);
    set(this.subVCA.gain, mix[2], n === 'drop' ? 0.008 : 0.12);
    if (n === 'drop') {
      set(this.padLP.frequency, 2600, 0.05);
      set(this.arpLP.frequency, 5200, 0.05);
    }
  }

  _barEvents(t, b) {
    const n = this.sec.name, ch = this.chord;
    this._pad(t, ch, n === 'drop' ? 0.65 : 1);
    if (n === 'breakdown') {
      this._choir(t, ch);
      this._vowel(t, b % 2);
    }
    if (n === 'build' || n === 'drop') this._retuneStabs(t, ch);
    if (n !== 'build') this.subOsc.frequency.setTargetAtTime(mtof(ch.root), t, 0.004);
    if (n === 'build' && this.bar === this.sec.bars - 1) this._hit(this.buf.swell, t, 0.42, this.drumBus);
    if (n === 'drop' && b === 8 && !this.sec.ext) this._crash(t, 0.55);
  }

  _playStep(s, t) {
    const sec = this.sec, n = sec.name;
    const b = this.bar + (sec.offset || 0);
    const P = (this.bar * 16 + s) / (sec.bars * 16); // progress through the section
    if (n === 'intro') this._introStep(s, t, b, P);
    else if (n === 'build') this._buildStep(s, t, P);
    else if (n === 'drop') this._dropStep(s, t, b);
    else this._breakdownStep(s, t, b, P);
    if (this.fill > 0) {
      if (n === 'drop') {
        const k = 8 - this.fill;
        const v = 0.35 + k * 0.07, r = 1 + k * 0.03;
        this._snare(t, v, r);
        if (k >= 4) this._snare(t + STEP / 2, v, r);
      }
      this.fill--;
    }
  }

  _introStep(s, t, b, P) {
    const ch = this.chord, I = this.intensity;
    if (s % 4 === 0) {
      this.padLP.frequency.setTargetAtTime(700 * Math.pow(3.5, P), t, 0.2);
      this.arpLP.frequency.setTargetAtTime(1000 * Math.pow(5, P), t, 0.2);
    }
    const accent = s % 4 === 0 ? 1 : s % 2 === 0 ? 0.7 : 0.5;
    this._arp(t, ch.arp[ARP[s]], accent * (0.55 + 0.45 * P), 0.2);
    if (b >= 4) {
      if (s % 4 === 0) this._kick(t, 0.5 + 0.1 * (b - 4), 0.55);
      if (s % 4 === 2 && I > 0.4) this._hat(t, 0.4 + 0.4 * I, false);
      if (b >= 6 && (s === 4 || s === 12)) this._clap(t, 0.22);
    }
    if (b === 7 && s >= 12) this._snare(t, 0.2 + (s - 12) * 0.08, 1);
  }

  _buildStep(s, t, P) {
    const ch = this.chord, bars = this.sec.bars, bar = this.bar;
    const last = bar === bars - 1;
    const gap = last && s >= 14; // a breath before the drop
    if (s % 2 === 0) {
      this.padLP.frequency.setTargetAtTime(1200 * Math.pow(4, P), t, 0.1);
      this.arpLP.frequency.setTargetAtTime(2000 * Math.pow(3.5, P), t, 0.1);
    }
    if (this.riser) {
      this.riser.bp.frequency.setTargetAtTime(350 * Math.pow(24, P), t, 0.08);
      this.riser.g.gain.setTargetAtTime(0.04 + 0.75 * P * P, t, 0.1);
    }
    if (!last && s % 4 === 0) this._kick(t, 0.9, 0.8);
    // accelerating snare roll: 4ths -> 8ths -> 16ths -> 32nds
    const every = bars >= 4 ? (bar === 0 ? 4 : bar === 1 ? 2 : 1) : bar === 0 ? (s < 8 ? 2 : 1) : 1;
    if (!gap && s % every === 0) {
      const v = 0.18 + 0.62 * P, r = 1 + 0.3 * P;
      this._snare(t, v, r);
      if (last && s >= 8) this._snare(t + STEP / 2, v, r);
    }
    if (!gap && s % 2 === 0) this._stab(t, STEP * 1.1, 0.3 + 0.45 * P, 500 * Math.pow(16, P));
    if (!gap && P > 0.4 && s % 2 === 1) this._hat(t, 0.25 + 0.4 * P, false);
    if (!gap) this._arp(t, ch.arp[ARP[s]], (s % 4 === 0 ? 0.5 : 0.32) * (1 - 0.4 * P), 0.15);
  }

  _dropStep(s, t, b) {
    const ch = this.chord, I = this.intensity;
    const second = b >= 8, bar8 = b % 8;
    if (s % 4 === 0) this._kick(t, 1, 1);
    if (s === 4 || s === 12) this._clap(t, 0.5);
    if (s % 4 === 2) this._hat(t, I > 0.35 || second ? 0.75 : 0.8, I > 0.35 || second);
    else if (s % 2 === 1 && (I > 0.5 || second)) this._hat(t, 0.3 + 0.3 * Math.random(), false, true);
    if (bar8 === 7 && s >= 12) this._snare(t, 0.45 + (s - 12) * 0.12, 1.05);
    // offbeat bass with octave pop, rolling 16th when the action is high
    if (s % 4 === 2) this._bass(t, ch.root + 12 + (s === 14 ? 12 : 0), STEP * 1.3);
    else if (s === 15 && I > 0.55) this._bass(t, ch.root + 24, STEP * 0.7, 0.7);
    if (STABS.has(s)) this._stab(t, STEP * 1.4, 0.85, 4200 + 3500 * I);
    const thin = I < 0.25 && bar8 >= 4; // idle: call & response instead of non-stop hook
    const note = HOOK_AT[ch.name][s];
    if (note && !thin) this._lead(t, note[1], note[2] * STEP);
    if (second && I > 0.45) this._arp(t, ch.arp[ARP[s]] + 12, 0.22, 0.1);
  }

  _breakdownStep(s, t, b, P) {
    const ch = this.chord;
    if (s % 4 === 0) {
      this.padLP.frequency.setTargetAtTime(1500 + 1800 * P, t, 0.3);
      this.arpLP.frequency.setTargetAtTime(1800 + 2400 * P, t, 0.3);
    }
    if (b < 4) {
      if (s % 2 === 0) this._arp(t, ch.arp[ARP[s]], s % 4 === 0 ? 0.6 : 0.4, 0.3);
    } else {
      const note = HOOK_AT[ch.name][s]; // the hook, foreshadowed on the pluck
      if (note) this._arp(t, note[1], 0.75, 0.45);
      if (s % 4 === 2) this._arp(t, ch.arp[ARP[s]], 0.3, 0.2);
    }
    if (b === 7 && s >= 8 && s % 2 === 0) this._snare(t, 0.12 + (s - 8) * 0.04, 1);
  }

  // ---- instruments -------------------------------------------------------------------------
  _cleanup(src, nodes) {
    src.onended = () => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      }
    };
  }

  _hit(buf, t, vel, bus, rate = 1, rev = 0) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = this._gain(vel);
    s.connect(g).connect(bus);
    const nodes = [s, g];
    if (rev > 0) {
      const r = this._gain(rev);
      g.connect(r).connect(this.reverbIn);
      nodes.push(r);
    }
    s.start(Math.max(t, 0));
    this._cleanup(s, nodes);
    return s;
  }

  _duck(t, amt) {
    for (const [node, depth] of this.duckers) {
      const g = node.gain;
      g.setValueAtTime(1, t);
      g.linearRampToValueAtTime(1 - depth * amt, t + 0.006);
      g.setTargetAtTime(1, t + 0.035, 0.07);
    }
  }

  _kick(t, vel = 1, duck = 1) {
    this._hit(this.buf.kick, t, 0.85 * vel, this.kickBus);
    if (duck > 0) this._duck(t, duck);
  }

  _clap(t, vel) {
    this._hit(this.buf.clap, t, vel, this.drumBus, 0.98 + Math.random() * 0.04);
  }

  _snare(t, vel, rate = 1) {
    this._hit(this.buf.snare, t, 0.5 * vel, this.drumBus, rate);
  }

  _hat(t, vel, open, swing = false) {
    const v = vel * (0.85 + Math.random() * 0.3);
    this._hit(open ? this.buf.ohat : this.buf.hat, t + (swing ? 0.008 : 0), (open ? 0.13 : 0.17) * v, this.hatBus, 0.97 + Math.random() * 0.06);
  }

  _crash(t, vel, bus = this.drumBus) {
    this._hit(this.buf.crash, t, 0.34 * vel, bus);
  }

  _impact(t, vel, bus) {
    this._hit(this.buf.impact, t, 0.75 * vel, bus, 1, 0.3);
  }

  _pad(t, ch, amp) {
    const ctx = this.ctx, end = t + BAR, stop = end + 1.4;
    for (const [pan, det] of [[this.padPanL, -9], [this.padPanR, 9]]) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.06 * amp, t + 0.45);
      g.gain.setTargetAtTime(0, end, 0.28);
      g.connect(pan);
      const nodes = [g];
      let o;
      for (const m of ch.pad) {
        o = this._osc('sawtooth', mtof(m), det + (Math.random() * 6 - 3));
        o.connect(g);
        o.start(t);
        o.stop(stop);
        nodes.push(o);
      }
      this._cleanup(o, nodes);
    }
  }

  _choir(t, ch) {
    const ctx = this.ctx, end = t + BAR, stop = end + 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.1, t + 0.7);
    g.gain.setTargetAtTime(0, end, 0.35);
    g.connect(this.choirIn);
    const oscs = [];
    for (const m of ch.choir) {
      for (const det of [-7, 7]) {
        const o = this._osc('sawtooth', mtof(m), det);
        this.choirVib.connect(o.detune);
        o.connect(g);
        o.start(t);
        o.stop(stop);
        oscs.push(o);
      }
    }
    oscs[oscs.length - 1].onended = () => {
      for (const o of oscs) {
        try {
          this.choirVib.disconnect(o.detune);
        } catch {
          /* gone */
        }
        o.disconnect();
      }
      g.disconnect();
    };
  }

  _vowel(t, k) {
    const v = k ? [570, 840, 2410] : [750, 1150, 2600]; // "oh" / "ah"
    this.formants.forEach((f, i) => f.frequency.setTargetAtTime(v[i], t, 0.6));
  }

  _arp(t, midi, vel, decay) {
    const ctx = this.ctx;
    const o = this._osc('sawtooth', mtof(midi));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(5200, t);
    lp.frequency.setTargetAtTime(500, t + 0.002, decay * 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.2 * vel, t + 0.002);
    g.gain.setTargetAtTime(0, t + 0.004, decay * 0.45);
    o.connect(lp).connect(g).connect(this.arpLP);
    o.start(t);
    o.stop(t + decay * 2.6 + 0.02);
    this._cleanup(o, [o, lp, g]);
  }

  _retuneStabs(t, ch) {
    this.stabOsc.forEach((row, n) => {
      const f = mtof(ch.stab[n]);
      for (const o of row) o.frequency.setValueAtTime(f, t);
    });
  }

  _stab(t, len, vel, cut) {
    const g = this.stabVCA.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(vel, t + 0.003);
    g.setTargetAtTime(vel * 0.6, t + 0.003, 0.06);
    g.setTargetAtTime(0, t + len, 0.02);
    const c = this.stabLP.frequency, f = Math.min(cut, 16000);
    c.setValueAtTime(f, t);
    c.setTargetAtTime(f * 0.3 + 250, t + 0.004, 0.08);
  }

  _bass(t, midi, len, vel = 1) {
    const f = mtof(midi);
    for (const o of this.bassOsc) o.frequency.setValueAtTime(f, t);
    const c = this.bassLP.frequency;
    c.setValueAtTime(2400, t);
    c.setTargetAtTime(160, t + 0.002, 0.045);
    const g = this.bassVCA.gain;
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(vel, t + 0.004);
    g.setTargetAtTime(0, t + len, 0.02);
  }

  _lead(t, midi, dur) {
    const f = mtof(midi);
    const legato = Math.abs(t - this.leadEnd) < 0.005;
    for (const o of this.leadOsc) {
      if (legato) o.frequency.setTargetAtTime(f, t, 0.012);
      else o.frequency.setValueAtTime(f, t);
    }
    const g = this.leadVCA.gain;
    if (!legato) g.setValueAtTime(0, t);
    g.setTargetAtTime(1, t, 0.003);
    g.setTargetAtTime(0.7, t + 0.03, 0.12);
    g.setTargetAtTime(0, t + dur - 0.03, 0.02); // articulation dip / release
    const c = this.leadLP.frequency;
    c.setTargetAtTime(7000, t, 0.004);
    c.setTargetAtTime(2600, t + 0.02, 0.15);
    this.leadEnd = t + dur;
  }

  _startBuildRiser(t) {
    this._stopBuildRiser(t);
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const hp = this._filter('highpass', 250, 0.7);
    const bp = this._filter('bandpass', 350, 2.2);
    const g = this._gain(0);
    n.connect(hp).connect(bp).connect(g).connect(this.hpLight);
    const r = this._gain(0.35);
    g.connect(r).connect(this.reverbIn);
    n.start(t, Math.random() * 1.5);
    this._cleanup(n, [n, hp, bp, g, r]);
    this.riser = { n, bp, g };
  }

  _stopBuildRiser(t) {
    const r = this.riser;
    if (!r) return;
    this.riser = null;
    r.g.gain.setTargetAtTime(0, t, 0.012);
    r.n.stop(t + 0.2);
  }

  // short noise sweep (stunt fill)
  _sweep(t, dur, bus = this.hpLight) {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    const bp = this._filter('bandpass', 600, 1.8);
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
    const g = this._gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + dur * 0.9);
    g.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(bp).connect(g).connect(bus);
    const r = this._gain(0.4);
    g.connect(r).connect(this.reverbIn);
    n.start(t, Math.random());
    n.stop(t + dur + 0.05);
    this._cleanup(n, [n, bp, g, r]);
  }

  // ---- gameplay reactions ------------------------------------------------------------------
  // called every frame with the player vehicle
  react(v, dt) {
    if (!this.running || !v) return;
    const now = this.ctx.currentTime;
    dt = clamp(dt || 0, 0, 0.1);
    const sp = v.vel && v.vel.length ? v.vel.length() : 0;
    const thrust = v.thrust || 0, air = !!v.airborne, wall = v.wallGrip || 0, trick = !!v.trick;
    const target = clamp(
      0.18 + 0.5 * clamp(sp / 45, 0, 1) + 0.25 * thrust + (air ? 0.12 : 0) + (wall > 0.2 ? 0.2 : 0) + (trick ? 0.25 : 0) + (v.burnout ? 0.12 : 0),
      0,
      1,
    );
    const rate = target > this.intensity ? 2.2 : 0.5;
    this.intensity += (target - this.intensity) * (1 - Math.exp(-rate * dt));
    this._applyTone(now);

    if (air) {
      this.airTime += dt;
      this._airRiserUpdate(now);
    } else {
      if (this.airTime > 0) {
        const long = this.airTime > 1.2;
        this._airRiserStop(now, long);
        if (long) this._landing(now, this.airTime);
      }
      this.airTime = 0;
      this.airRiserDone = false;
    }

    const stunt = wall > 0.2 || trick;
    if (stunt && !this.stuntPrev && now >= this.stuntReadyAt) {
      this.stuntReadyAt = now + 6;
      this._stunt(now);
    }
    this.stuntPrev = stunt;
  }

  _airRiserUpdate(now) {
    const a = this.airTime;
    if (a <= 0.6 || this.airRiserDone) return;
    if (!this.airRiser) {
      const n = this.ctx.createBufferSource();
      n.buffer = this.noise;
      n.loop = true;
      const hp = this._filter('highpass', 300, 0.7);
      const bp = this._filter('bandpass', 450, 1.6);
      const g = this._gain(0);
      n.connect(hp).connect(bp).connect(g);
      g.connect(this.fxBus);
      g.connect(this.fxRev);
      n.start(now, Math.random() * 1.5);
      this._cleanup(n, [n, hp, bp, g]);
      this.airRiser = { n, bp, g };
    }
    const k = clamp((a - 0.6) / 3.2, 0, 1);
    const fade = a > 7 ? clamp(1 - (a - 7) / 4, 0, 1) : 1; // long flights: let it settle away
    this.airRiser.bp.frequency.setTargetAtTime(450 * Math.pow(18, k), now, 0.1);
    this.airRiser.g.gain.setTargetAtTime(0.5 * k * k * fade, now, 0.12);
    if (fade <= 0) {
      this._airRiserStop(now, false);
      this.airRiserDone = true;
    }
  }

  _airRiserStop(now, fast) {
    const r = this.airRiser;
    if (!r) return;
    this.airRiser = null;
    r.g.gain.cancelScheduledValues(now);
    r.g.gain.setTargetAtTime(0, now, fast ? 0.012 : 0.12);
    r.n.stop(now + (fast ? 0.15 : 0.9));
  }

  _landing(now, air) {
    if (now - this.lastImpact < 2.2) return;
    this.lastImpact = now;
    const k = clamp(0.55 + air / 4, 0.55, 1);
    this._impact(now + 0.005, k, this.fxBus);
    this._crash(now + 0.005, 0.5 + 0.4 * k, this.fxBus);
    if (!this.external && this.sec && this.sec.name !== 'drop') this.pending = { name: 'drop', bars: 16 };
  }

  _stunt(now) {
    if (this.external || !this.sec) return;
    const n = this.sec.name;
    if ((n === 'intro' || n === 'breakdown') && !this.pending) this.pending = { name: 'build', bars: 2 };
    else if (n === 'drop' && !this.fill) {
      this.fill = 8;
      this._sweep(now + 0.02, 0.9);
    }
  }

  _applyTone(now) {
    const I = this.intensity;
    const base = this.external ? 6500 * Math.pow(3.2, I) : 2600 * Math.pow(7.7, I);
    const f = clamp(base * Math.pow(0.01, this.slowmo), 280, 20000);
    if (Math.abs(f - this._tone) > f * 0.015) {
      this._tone = f;
      this.toneLP.frequency.setTargetAtTime(f, now, 0.1);
    }
    const q = 0.75 + 1.2 * this.slowmo;
    if (Math.abs(q - this._toneQ) > 0.05) {
      this._toneQ = q;
      this.toneLP.Q.setTargetAtTime(q, now, 0.1);
    }
  }

  // 0..1 - heavy low-pass + extra reverb
  setSlowmo(a) {
    a = clamp(a || 0, 0, 1);
    if (Math.abs(a - this.slowmo) < 0.005) return;
    this.slowmo = a;
    const now = this.ctx.currentTime;
    this._applyTone(now);
    this.slowSend.gain.setTargetAtTime(0.9 * a, now, 0.15);
    if (this.trackSlow) this.trackSlow.gain.setTargetAtTime(0.9 * a, now, 0.15);
    this.revRet.gain.setTargetAtTime(1 + 1.1 * a, now, 0.2);
  }

  // ---- external track ----------------------------------------------------------------------
  attachTrack(el, bpm, offset) {
    const src = this.ctx.createMediaElementSource(el);
    this.trackGain = this._gain(0);
    this.trackSlow = this._gain(0);
    src.connect(this.trackGain);
    this.trackGain.connect(this.postIn);
    this.trackGain.connect(this.trackSlow).connect(this.reverbIn);
    this.ext = { el, src, bpm: bpm || MUSIC_BPM, offset: offset || 0 };
    this.useExternal(true);
  }

  useExternal(on) {
    if (!this.ext) on = false;
    if (!on && this.external) this.needMix = true;
    this.external = on;
    const now = this.ctx.currentTime;
    if (this.trackGain) this.trackGain.gain.setTargetAtTime(on ? TRACK_LEVEL : 0, now, 0.25);
    this.synthGate.gain.setTargetAtTime(on ? 0 : 1, now, 0.25);
    this._tone = 0;
    this._applyTone(now);
  }

  dispose() {
    this.running = false;
    for (const o of this.persistent) {
      try {
        o.stop();
      } catch {
        /* already stopped */
      }
    }
    try {
      this.out.disconnect();
    } catch {
      /* gone */
    }
  }
}
