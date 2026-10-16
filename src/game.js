import * as THREE from 'three';
import { LAYOUT } from './environment.js';
import { STUNTS } from './stunts.js';
import { TAU } from './util.js';
export { formatViews } from './util.js';

const STAGE = LAYOUT.stage;
const PAD = LAYOUT.pad;
const GATE = LAYOUT.gate;

const _q = new THREE.Quaternion();
const _w = new THREE.Vector3();

// Launch Show: the original reveal video
const STEPS = [
  { id: 'gate', text: 'Drive through the gate' },
  { id: 'lift', text: 'Lift off' },
  { id: 'rings', text: 'Fly through the ring' },
  { id: 'flip', text: 'Do a flip' },
  { id: 'land', text: 'Land on the pad' },
  { id: 'donut', text: 'Spin a donut' },
  { id: 'park', text: 'Park on the stage' },
];

// Stunt steps (the roadmap from the kickflip + wall-ride videos). A step's group picks the
// start line, title card, respawn point, slow-mo shot and cannons.
const STUNT_STEPS = {
  kickflip: { id: 'kickflip', group: 'truck', title: 'TRUCK KICKFLIP', text: 'Hit the kicker and KICKFLIP over the truck', hint: 'Full throttle · press R in the air' },
  truckjump: { id: 'truckjump', group: 'truck', title: 'CAR JUMP', text: 'Jump the truck', hint: 'hold W all the way to the ramp' },
  flipjump: { id: 'flipjump', group: 'truck', title: 'FLIP JUMP', text: 'Flip over the truck', hint: 'hold W · press F as you leave the ramp' },
  wallride: { id: 'wallride', group: 'wall', title: 'MEGA WALL', text: 'Floor it straight up the Mega Wall', hint: 'Full throttle · keep it straight' },
  walllaunch: { id: 'walllaunch', group: 'wall', title: 'MEGA WALL', text: 'Launch off the top & jet-land in the smoke zone', hint: 'SPACE = thrusters · SHIFT = descend' },
  loop: { id: 'loop', group: 'loop', title: 'THE C-LOOP', text: 'Run the C-Loop upside down & stick the landing', hint: 'Full throttle · SPACE to catch the drop' },
  finale: { id: 'finale', group: 'finale', title: 'DONUT FINALE', text: 'Burn 3 donuts inside the laser grid', hint: 'Hold W + S and steer' },
};
const S = STUNT_STEPS;
const TOUR = [S.kickflip, S.wallride, S.walllaunch, S.loop, S.finale];
const TRUCK_STEPS = new Set(['kickflip', 'truckjump', 'flipjump']);
const FLIPS = ['KICKFLIP', 'FRONT FLIP', 'BACKFLIP'];

// ------------------------------------------------------------------ beginner levels (1-3)
// easy levels get a briefing card, a "do this now" coach prompt, fix-it fail messages,
// a quicker respawn and a fuel floor. In all text, [KEY] is drawn as a keycap.
const EASY_FAIL_S = 1.3; // fail call-out -> respawn (normal levels: 1.6 s)
const EASY_CRASH_S = 1.6; // crash -> respawn (normal levels: 2.2 s)
const TIP_S = 6; // the last fix-it tip stays on the coach this long after the respawn
const FIX = {
  slow: ['TOO SLOW', 'hold [W] all the way to the ramp'],
  missed: ['MISSED THE RAMP', 'steer with [A] [D] — aim for the middle of the ramp'],
  onTruck: ['LANDED ON THE TRUCK', 'hold [W] the whole way to fly further'],
  hitTruck: ['HIT THE TRUCK', 'hold [W] the whole way — speed clears it'],
  // the flip level coaches F (front flip): it settles cleanly before the landing; R / B still count
  noFlip: ['NO FLIP', 'press [F] as you leave the ramp'],
  lateFlip: ['FLIP TOO LATE', 'press [F] the moment you leave the ramp'],
  twoFlips: ['ONE FLIP IS ENOUGH', 'press [F] just once'],
  lowFlip: ['FLIP TOO LOW', 'go higher with [SPACE] before you flip'],
  upside: ['LANDED UPSIDE DOWN', 'let go of the keys in the air — the car self-levels'],
  side: ['LANDED ON ITS SIDE', 'let go of the keys in the air — the car self-levels'],
  rolled: ['ROLLED OVER', 'let go of the keys in the air — the car self-levels'],
  hard: ['LANDED TOO HARD', 'tap [SPACE] to slow the drop'],
  crash: ['CRASHED', 'slow down — ease off [W] near walls'],
};
const plain = (s) => String(s || '').replace(/[[\]]/g, '');

// ------------------------------------------------------------------ levels
// stars = total-point thresholds for 1/2/3 stars, fuel = thrust tank size (0..1), par = time-bonus par (s)
// easy levels: brief = briefing card, fuelFloor = the tank never drops below this,
// rings / donuts / padR / parkR = gentler Launch Show goals (defaults: 3 rings, 2 donuts, PAD.r + 1.2, 3.4)
export const LEVELS = [
  {
    id: 'reveal', num: 1, title: 'LAUNCH SHOW', subtitle: 'Drive, lift off, fly through a ring, land', kind: 'show', stars: [4000, 7000, 10000], fuel: 1, par: 160, steps: STEPS,
    easy: true, fuelFloor: 0.25, rings: 1, donuts: 1, padR: PAD.r + 4.5, parkR: 7,
    brief: { goal: 'Drive out, fly through the ring, land and park', steps: ['[W] Hold to drive · [A] [D] steer', '[SPACE] Lift off · [SHIFT] come down', 'Then just do what the big prompt says'] },
  },
  {
    id: 'jump', num: 2, title: 'CAR JUMP', subtitle: 'Hold W, hit the ramp, jump the truck', kind: 'stunt', stars: [2000, 3500, 5000], fuel: 1, par: 45, steps: [S.truckjump],
    easy: true, fuelFloor: 0.25,
    brief: { goal: 'Jump over the truck and land it', steps: ['[W] Hold it down — full speed', 'Keep holding [W] up the ramp', 'Land past the truck. That\'s it!'] },
  },
  {
    id: 'flip', num: 3, title: 'FLIP JUMP', subtitle: 'Same jump — press F in the air to flip', kind: 'stunt', stars: [2500, 4500, 6500], fuel: 1, par: 45, steps: [S.flipjump],
    easy: true, fuelFloor: 0.25,
    brief: { goal: 'Flip over the truck and land it', steps: ['[W] Hold it down — full speed', '[F] Press as you leave the ramp', 'Flipped? Let go of the keys and land'] },
  },
  { id: 'wall', num: 4, title: 'MEGA WALL', subtitle: 'Ride the wall, launch & jet-land', kind: 'stunt', stars: [3000, 5000, 7000], fuel: 0.7, par: 45, steps: [S.wallride, S.walllaunch] },
  { id: 'loop', num: 5, title: 'THE C-LOOP', subtitle: 'Upside down & stick the landing', kind: 'stunt', stars: [3000, 5000, 7000], fuel: 0.6, par: 45, steps: [S.loop] },
  { id: 'finale', num: 6, title: 'DONUT FINALE', subtitle: 'Burn 3 donuts in the laser grid', kind: 'stunt', stars: [2000, 3500, 5000], fuel: 0.3, par: 45, steps: [S.finale] },
  { id: 'tour', num: 7, title: 'STUNT TOUR', subtitle: 'Every stunt, back to back', kind: 'stunt', stars: [9000, 13000, 17000], fuel: 1, par: 220, steps: TOUR },
];
// A level entry used where a string is expected (template literal, Supabase filter, JSON payload)
// turns into its id, so passing result.level instead of result.levelId still works.
for (const L of LEVELS) {
  Object.defineProperty(L, 'toString', { value() { return this.id; } });
  Object.defineProperty(L, 'toJSON', { value() { return this.id; } });
}

const LEGACY = { show: 'reveal', stunt: 'tour' };
const LEGACY_BEST = { reveal: 'roadster-best', tour: 'roadster-best-stunt' };
const PROGRESS_KEY = 'roadster-progress';

export function getLevel(id) {
  const key = LEGACY[id] || id;
  return LEVELS.find((l) => l.id === key) || null;
}

export function nextLevel(id) {
  const i = LEVELS.findIndex((l) => l.id === (LEGACY[id] || id));
  return i >= 0 && i < LEVELS.length - 1 ? LEVELS[i + 1] : null;
}

export function starsFor(level, total) {
  if (!level) return 0;
  return level.stars.filter((s) => total >= s).length;
}

function readNumber(key) {
  try { return Number(localStorage.getItem(key) || 0) || 0; } catch { return 0; }
}

export function loadProgress() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}'); } catch { raw = {}; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const out = {};
  for (const L of LEVELS) {
    const p = raw[L.id];
    if (p && typeof p === 'object') {
      out[L.id] = { done: !!p.done, best: Math.max(0, Number(p.best) || 0), stars: Math.max(0, Math.min(3, Number(p.stars) || 0)) };
    }
    // players who finished the old Launch Show / Stunt Tour keep that credit
    const legacy = LEGACY_BEST[L.id] ? readNumber(LEGACY_BEST[L.id]) : 0;
    if (legacy > 0) {
      const cur = out[L.id] || { done: false, best: 0, stars: 0 };
      out[L.id] = { done: true, best: Math.max(cur.best, legacy), stars: Math.max(cur.stars, starsFor(L, legacy)) };
    }
  }
  return out;
}

export function saveProgress(progress) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); } catch { /* storage unavailable */ }
}

export function isUnlocked(levelId, progress = loadProgress()) {
  if (levelId === 'free') return true;
  const i = LEVELS.findIndex((l) => l.id === (LEGACY[levelId] || levelId));
  if (i < 0) return false;
  if (i === 0) return true;
  const prev = progress && progress[LEVELS[i - 1].id];
  return !!(prev && prev.done);
}

// ------------------------------------------------------------------ game
export class Game {
  constructor({ vehicle, arena, stunts, hud, audio, rig, fx, onFinish }) {
    Object.assign(this, { vehicle, arena, stunts, hud, audio, rig, fx, onFinish });
    this.mode = 'attract';
    this.state = 'title';
    this.level = null;
    this.steps = null;
    this.runToken = 0;
    this.prevPos = new THREE.Vector3();
    this.lastSafe = { pos: new THREE.Vector3(STAGE.x, 0, STAGE.z), heading: 0 };
    this.resetRun();
  }

  resetRun() {
    this.score = 0;
    this.views = 0;
    this.pending = 0;
    this.combo = 0;
    this.time = 0;
    this.step = 0;
    this.pendingNext = 0;
    this.ringIndex = 0;
    this.donuts = 0;
    this.burnYaw = 0;
    this.parkTimer = 0;
    this.crashTimer = 0;
    this.upsideTimer = 0;
    this.safeTimer = 0;
    this.countdown = 0;
    this.cardTimer = 0;
    this.nextTimer = 0;
    this.failTimer = 0;
    this.ringCooldown = [0, 0, 0];
    this.gasWarned = false;
    this.gasLowWarned = false;
    this.loopInverted = false;
    this.wallRidden = false;
    this.fading = false;
    this.tip = '';
    this.tipTimer = 0;
    this.lastTrickT = -9;
    this.resetAttempt();
    this.resetAir();
  }

  // per-attempt coach state (cleared on every respawn)
  resetAttempt() {
    this.wHeld = false;
    this.touchedKicker = false;
    this.stillTimer = 0;
    this.turning = false;
    this.heightCue = 0;
    this.braking = false;
    this.coasting = false;
  }

  resetAir() {
    this.acc = { pitch: 0, roll: 0, yaw: 0 };
    this.airPoints = 0;
    // started = flips begun in this air time (to tell an unfinished flip from a bad landing)
    this.air = { from: null, tricks: [], overTruck: false, wallLaunch: false, kicker: false, started: 0, trickRef: null };
  }

  get easy() {
    return !!(this.level && this.level.easy);
  }

  get ringCount() {
    return Math.min(this.arena.rings.length, (this.level && this.level.rings) || this.arena.rings.length);
  }

  get donutGoal() {
    return (this.level && this.level.donuts) || 2;
  }

  get padR() {
    return (this.level && this.level.padR) || PAD.r + 1.2;
  }

  get parkR() {
    return (this.level && this.level.parkR) || 3.4;
  }

  // ------------------------------------------------------------------ flow
  // which: a LEVELS id, 'free', or the legacy 'show' / 'stunt'
  start(which = 'free') {
    const level = which === 'free' ? null : getLevel(which);
    this.level = level;
    this.mode = level ? level.kind : 'free';
    this.steps = level && level.kind === 'stunt' ? level.steps : null;
    this.runToken++;
    this.resetRun();
    this.arena.cones.reset();
    this.prevPos.copy(this.vehicle.pos);
    this.rig.snap = true;
    if (this.mode === 'stunt') {
      this.beginTourStep(0, true);
    } else {
      const spawn = this.mode === 'show' ? LAYOUT.spawnStage : LAYOUT.spawnFree;
      this.resetVehicle(new THREE.Vector3(spawn.x, 0, spawn.z), spawn.heading);
      this.lastSafe.pos.set(spawn.x, 0, spawn.z);
      this.lastSafe.heading = spawn.heading;
      this.stunts.setActive(null);
      if (this.mode === 'show' && level.brief) {
        this.state = 'brief'; // dismissBrief() starts the countdown
      } else if (this.mode === 'show') {
        this.state = 'countdown';
        this.countdown = 3.6;
        this.lastCount = null;
      } else {
        this.state = 'play';
      }
    }
    this.prevPos.copy(this.vehicle.pos);
    this.syncMarkers();
  }

  // what to pass back into start() to replay this run ('free' or a level id)
  get runId() {
    return this.level ? this.level.id : 'free';
  }

  get controlsLive() {
    return this.state === 'play' && this.crashTimer <= 0 && this.failTimer <= 0;
  }

  // briefing card -> play (W / SPACE / ENTER or the GO button)
  dismissBrief() {
    if (this.state !== 'brief') return;
    if (this.mode === 'show') {
      this.state = 'countdown';
      this.countdown = 3.6;
      this.lastCount = null;
    } else {
      this.state = 'play';
      this.audio.blip(1320, 0.35, 0.12, 'square');
      this.audio.cheer(0.6);
    }
  }

  get tourStep() {
    return this.mode === 'stunt' && this.steps ? this.steps[Math.min(this.step, this.steps.length - 1)] : null;
  }

  get stepId() {
    const s = this.tourStep;
    return s ? s.id : null;
  }

  resetVehicle(pos, heading) {
    this.vehicle.gasCap = this.level ? this.level.fuel : 1;
    this.vehicle.reset(pos, heading);
  }

  groupStart(group) {
    return STUNTS[group].start;
  }

  // distinct stunt groups of the current level, in order
  stuntGroups() {
    const steps = this.steps || [];
    return steps.filter((t, k) => k === 0 || t.group !== steps[k - 1].group);
  }

  beginTourStep(i, first = false) {
    const steps = this.steps;
    const prev = first ? null : steps[this.step];
    this.step = i;
    const st = steps[i];
    this.stunts.setActive(st.group);
    if (!prev || prev.group !== st.group) {
      const s = this.groupStart(st.group);
      this.resetVehicle(new THREE.Vector3(s.x, 0, s.z), s.heading);
      this.prevPos.copy(this.vehicle.pos);
      this.rig.snap = true;
      this.resetAir();
      this.loopInverted = false;
      this.wallRidden = false;
      this.donuts = 0;
      this.resetAttempt();
      if (first && this.level.brief) {
        this.state = 'brief'; // the briefing card replaces the title card
      } else {
        this.state = 'card';
        this.cardTimer = 2.4;
        const groups = this.stuntGroups();
        let top = `LEVEL ${this.level.num}`;
        if (groups.length > 1) {
          const n = steps.slice(0, i + 1).filter((t, k) => k === 0 || t.group !== steps[k - 1].group).length;
          const total = groups.filter((g) => g.group !== 'finale').length;
          top += st.group === 'finale' ? ' · FINALE' : ` · STUNT ${n} / ${total}`;
        }
        this.fx.card(top, st.title, st.hint);
        this.audio.blip(520, 0.2, 0.1, 'triangle');
      }
    }
    this.syncMarkers();
  }

  syncMarkers() {
    const show = this.mode === 'show' ? STEPS[this.step] : null;
    const id = show ? show.id : null;
    this.arena.setGateActive(id === 'gate');
    this.arena.setPadActive(id === 'land' || id === 'donut' || this.mode === 'free');
    this.arena.setParkActive(id === 'park');
    const rings = this.ringCount;
    this.arena.rings.forEach((r, i) => {
      if (this.mode === 'free') r.setState('active');
      else if (this.mode === 'show' && i >= rings) r.setState('done'); // not part of this level: dimmed
      else if (id === 'rings') r.setState(i < this.ringIndex ? 'done' : i === this.ringIndex ? 'active' : 'idle');
      else r.setState(this.mode === 'show' && this.step > 2 ? 'done' : 'idle');
    });
  }

  advance() {
    this.audio.chime();
    this.arena.kick(0.5);
    this.turning = false;
    this.heightCue = 0;
    this.braking = false;
    this.coasting = false;
    if (this.mode === 'stunt') {
      const next = this.steps[this.step + 1];
      this.nextTimer = next && next.group === this.steps[this.step].group ? 0.01 : 2.4;
      this.pendingNext = this.step + 1;
      return;
    }
    this.step++;
    if (this.step >= STEPS.length) {
      this.finish();
      return;
    }
    this.syncMarkers();
  }

  stuntComplete(name, pts) {
    // this step is already done (next one on its way), or the run is crashing / failing and about to respawn
    if (this.nextTimer > 0 || this.crashTimer > 0 || this.failTimer > 0) return;
    this.award(name, pts, { bank: true, kind: 'good', big: true });
    this.addViews(380000 + Math.random() * 120000);
    this.audio.cheer(1.4);
    this.arena.kick(1.5);
    const st = this.tourStep;
    this.fx.burst(st ? st.group : null);
    this.advance();
  }

  // fix = [title, what to do] used instead of msg / sub on the beginner levels
  fail(msg, sub = 'try again', fix = null) {
    if (this.failTimer > 0 || this.crashTimer > 0 || this.nextTimer > 0) return;
    if (fix && this.easy) this.fixTip(fix);
    else this.hud.trick(msg, sub, 'bad');
    this.failTimer = this.easy ? EASY_FAIL_S : 1.6;
    this.audio.blip(220, 0.3, 0.12, 'sawtooth');
  }

  fixTip(fix) {
    this.hud.trick(fix[0], plain(fix[1]), 'bad fix');
    this.tip = fix[1];
    this.tipTimer = TIP_S;
  }

  addViews(n) {
    this.views += n;
    this.hud.likes(n);
  }

  award(name, pts, { bank = false, kind = '', big = false } = {}) {
    if (bank) this.score += pts;
    else {
      this.pending += pts;
      this.combo++;
    }
    if (pts > 0) this.addViews(pts * (55 + this.combo * 22) * (0.8 + Math.random() * 0.4));
    this.hud.trick(name, `${pts > 0 ? '+' : ''}${pts.toLocaleString()}`, kind + (big ? ' big' : ''));
  }

  crash(reason = 'CRASHED', fix = null) {
    if (this.crashTimer > 0) return;
    // beginners: already won (rolling into the wall afterwards) or already failing (respawn on its way): no pile-up
    if (this.easy && (this.nextTimer > 0 || this.failTimer > 0)) return;
    if (fix && this.easy) this.fixTip(fix);
    else this.hud.trick(reason, this.pending > 0 ? 'tricks lost' : '', 'bad');
    this.pending = 0;
    this.combo = 0;
    this.resetAir();
    // a crash voids any half-done loop / wall ride so a bounce can't complete it
    this.loopInverted = false;
    this.wallRidden = false;
    if (this.mode === 'show') this.score = Math.max(0, this.score - 300);
    this.crashTimer = this.easy ? EASY_CRASH_S : 2.2;
    this.audio.thud(1.5);
    this.rig.addShake(1);
  }

  respawn() {
    if (this.mode === 'stunt') {
      const s = this.groupStart(this.tourStep.group);
      this.resetVehicle(new THREE.Vector3(s.x, 0, s.z), s.heading);
    } else {
      this.resetVehicle(this.lastSafe.pos, this.lastSafe.heading);
    }
    this.prevPos.copy(this.vehicle.pos);
    this.rig.snap = true;
    this.loopInverted = false;
    this.wallRidden = false;
    this.resetAttempt();
    this.resetAir();
  }

  finish() {
    if (this.state === 'results') return;
    this.state = 'results';
    const level = this.level;
    const t = this.time;
    const par = level ? level.par : 160;
    const bonus = Math.max(0, Math.round((par - t) * 40));
    const total = this.score + bonus;
    const stars = starsFor(level, total);
    const grade = ['C', 'B', 'A', 'S'][stars];

    let best = 0;
    let isBest = false;
    let progress = null;
    if (level) {
      progress = loadProgress();
      const prev = progress[level.id] || { done: false, best: 0, stars: 0 };
      isBest = total > prev.best;
      best = Math.max(prev.best, total);
      progress[level.id] = { done: true, best, stars: Math.max(prev.stars, stars) };
      saveProgress(progress);
      // legacy per-mode bests (title screen "BEST" line)
      const key = LEGACY_BEST[level.id];
      if (key && total > readNumber(key)) {
        try { localStorage.setItem(key, String(total)); } catch { /* storage unavailable */ }
      }
    }
    const next = level ? nextLevel(level.id) : null;
    this.audio.cheer(1.4);
    this.arena.kick(1.5);
    this.onFinish({
      level, // LEVELS entry (stringifies to its id)
      levelId: level ? level.id : 'free',
      mode: this.mode,
      time: t,
      par,
      tricks: this.score,
      bonus,
      total,
      grade,
      stars,
      best,
      isBest,
      views: this.views,
      next: next ? next.id : null,
      progress,
    });
  }

  // ------------------------------------------------------------------ per frame
  update(dt, input) {
    const v = this.vehicle;
    const hud = this.hud;
    this.inp = input;

    if (this.state === 'brief' && (input.throttle > 0.5 || input.lift > 0.5 || input.reset)) {
      this.dismissBrief();
      this.prevPos.copy(v.pos);
      v.events.length = 0;
      this.updateHud(dt);
      return; // the Enter that dismissed the card must not also count as a reset
    }
    if (this.state === 'countdown') {
      this.countdown -= dt;
      const n = Math.ceil(this.countdown - 0.6);
      const label = n > 0 ? String(n) : 'GO';
      if (label !== this.lastCount && this.countdown > 0) {
        this.lastCount = label;
        hud.countdown(label);
        this.audio.blip(label === 'GO' ? 1320 : 660, label === 'GO' ? 0.4 : 0.15, 0.14, 'square');
        if (label === 'GO') {
          this.audio.cheer(1);
          this.arena.kick(0.8);
        }
      }
      if (this.countdown <= 0) {
        hud.countdown('');
        this.state = 'play';
      }
    }
    if (this.state === 'card') {
      this.cardTimer -= dt;
      if (this.cardTimer <= 0) {
        this.state = 'play';
        this.fx.card(null);
        this.audio.blip(1320, 0.35, 0.12, 'square');
        this.audio.cheer(0.6);
      }
    }

    if (this.state !== 'play') {
      this.prevPos.copy(v.pos);
      v.events.length = 0;
      this.updateHud(dt);
      return;
    }

    this.time += dt;
    for (let i = 0; i < 3; i++) this.ringCooldown[i] = Math.max(0, this.ringCooldown[i] - dt);
    const L = this.level;
    if (L && L.easy) {
      // beginners never fail for fuel: the tank stops draining at the floor
      if (L.fuelFloor && v.gas < L.fuelFloor) v.gas = L.fuelFloor;
      if (this.controlsLive) {
        if (this.tipTimer > 0) this.tipTimer -= dt;
        if (input.throttle > 0.5) this.wHeld = true;
      }
    }

    // next stunt step after a success
    if (this.nextTimer > 0 && this.mode === 'stunt') {
      this.nextTimer -= dt;
      if (this.nextTimer <= 0) {
        this.nextTimer = 0;
        if (this.pendingNext >= this.steps.length) {
          this.finish();
          return;
        }
        const sameGroup = this.steps[this.pendingNext].group === this.steps[this.step].group;
        if (!sameGroup) {
          const token = this.runToken;
          const nextStep = this.pendingNext;
          hud.fade(true);
          setTimeout(() => {
            if (token !== this.runToken) return; // a new run started meanwhile
            if (this.mode === 'stunt') this.beginTourStep(nextStep);
            hud.fade(false);
          }, 450);
        } else this.beginTourStep(this.pendingNext);
      }
    }

    // crash / fail handling and respawn
    for (const key of ['crashTimer', 'failTimer']) {
      if (this[key] <= 0) continue;
      this[key] -= dt;
      if (this[key] < 0.5 && !this.fading) {
        this.fading = true;
        hud.fade(true);
      }
      if (this[key] <= 0) {
        this.fading = false;
        this.respawn();
        hud.fade(false);
      }
    }
    if (input.reset && this.crashTimer <= 0) {
      this.respawn();
      hud.toast(this.mode === 'stunt' ? 'BACK TO THE START LINE' : 'CAR RESET');
    }

    // events from physics
    for (const e of v.events) {
      if (e.type === 'land') this.onLand(e);
      else if (e.type === 'leave') this.onLeave(e);
      else if (e.type === 'impact') {
        const ramp = e.surface === 'megawall' || e.surface === 'cloop' || e.surface === 'kicker';
        if (e.surface === 'truck' && e.speed > 6) this.crash('HIT THE TRUCK', FIX.hitTruck);
        else if (!ramp && (e.speed > 15 || (e.speed > 11 && v.up.y < 0.4))) this.crash(undefined, FIX.crash);
      }
    }
    v.events.length = 0;
    if (this.state !== 'play') return; // a landing finished the level

    const touching = !v.airborne;
    const stepId = this.stepId;
    // stunt surfaces
    if (touching && v.surface === 'cloop' && v.up.y < -0.45 && !this.loopInverted) {
      this.loopInverted = true;
      this.hud.trick('INVERTED', '', 'good');
      this.addViews(60000);
    }
    if (touching && v.surface === 'megawall' && v.pos.y > STUNTS.wall.top - 3 && !this.wallRidden) {
      this.wallRidden = true;
      if (stepId === 'wallride') this.stuntComplete('WALL RIDE', 1500);
      else this.award('WALL RIDE', 1000, { bank: true, kind: 'good' });
    }
    if (touching && v.surface === 'ground') this.wallRidden = false;

    // tricks in the air
    if (!touching) {
      if (this.stunts.overTruck(v.pos)) this.air.overTruck = true;
      if (v.trick && v.trick !== this.air.trickRef) {
        this.air.trickRef = v.trick;
        this.air.started++;
      }
      _q.copy(v.quat).invert();
      _w.copy(v.angVel).applyQuaternion(_q);
      this.acc.pitch += _w.x * dt;
      this.acc.roll += _w.z * dt;
      // spins only count when they're fast (steering in assisted hover is too slow to farm points)
      if (Math.abs(_w.y) > 2.2) this.acc.yaw += _w.y * dt;
      else this.acc.yaw *= Math.max(0, 1 - dt * 3);
      const full = TAU * 0.86;
      if (Math.abs(this.acc.pitch) > full) {
        const front = this.acc.pitch > 0;
        this.acc.pitch -= Math.sign(this.acc.pitch) * TAU;
        this.trickDone(front ? 'FRONT FLIP' : 'BACKFLIP', front ? 1000 : 1100);
      }
      if (Math.abs(this.acc.roll) > full) {
        this.acc.roll -= Math.sign(this.acc.roll) * TAU;
        this.trickDone('KICKFLIP', 900);
      }
      if (Math.abs(this.acc.yaw) > TAU * 0.92) {
        this.acc.yaw -= Math.sign(this.acc.yaw) * TAU;
        this.trickDone('360 SPIN', 600);
      }
      if (v.altitude > 3) {
        this.airPoints += 45 * dt;
        if (this.airPoints >= 50) {
          this.pending += 50;
          this.airPoints -= 50;
        }
      }
      // falling hard from a launch: remind about the thrusters
      if (!v.armed && v.vel.y < -9 && v.altitude > 8 && !this.thrustHinted && v.gas > 0.05) {
        this.thrustHinted = true;
        if (!this.easy) hud.toast('SPACE — FIRE THE THRUSTERS!', 1.6); // the coach prompt covers it
      }
    } else this.thrustHinted = false;

    // stuck upside down
    if (touching && v.up.y < 0.25 && v.surface !== 'cloop' && v.surface !== 'megawall' && this.crashTimer <= 0) {
      this.upsideTimer += dt;
      if (this.upsideTimer > 1.4) this.crash('ROLLED OVER', FIX.rolled);
    } else this.upsideTimer = 0;

    // beginner truck jump: a run that can no longer reach the ramp fails fast with a fix-it tip
    if (this.easy && TRUCK_STEPS.has(stepId) && touching && this.crashTimer <= 0 && this.failTimer <= 0 && this.nextTimer <= 0) {
      const K = STUNTS.truck.kicker.origin;
      if (v.surface === 'kicker') this.touchedKicker = true;
      const why = this.touchedKicker ? FIX.slow : FIX.missed;
      if (v.surface === 'ground' && (v.pos.x < K.x - 6.5 || Math.abs(v.pos.z - K.z) > 13)) this.fail(why[0], '', why);
      else if (v.pos.x < K.x + 1 && v.vel.length() < 1.2) {
        // rolled to a stop on (or just past) the ramp
        this.stillTimer += dt;
        if (this.stillTimer > 1.2) this.fail(why[0], '', why);
      } else this.stillTimer = 0;
    }

    // remember a safe respawn point
    this.safeTimer -= dt;
    if (this.safeTimer <= 0 && v.grounded >= 4 && v.up.y > 0.95 && v.vel.length() < 25 && !v.armed && v.surface === 'ground') {
      this.safeTimer = 0.5;
      this.lastSafe.pos.set(v.pos.x, 0, v.pos.z);
      this.lastSafe.heading = Math.atan2(v.fwd.x, v.fwd.z);
    }

    // burnout donuts
    if (v.burnout) {
      this.burnYaw += v.angVel.y * dt;
      if (Math.abs(this.burnYaw) > TAU) {
        this.burnYaw -= Math.sign(this.burnYaw) * TAU;
        const inGrid = this.stunts.inZone('finale', v.pos);
        const counts = this.mode !== 'stunt' || (stepId === 'finale' && inGrid);
        if (counts) this.donuts++;
        this.award(inGrid ? 'GRID DONUT' : 'DONUT', inGrid ? 400 : 300, { bank: true });
        this.audio.cheer(0.7);
        this.arena.kick(0.5);
        if (inGrid) this.fx.burst('finale', 0.4);
        if (stepId === 'finale' && this.donuts >= 3) this.stuntComplete('DONUT FINALE', 2000);
      }
    } else {
      this.burnYaw *= 1 - Math.min(1, dt * 0.5);
    }

    // cones
    const hits = this.arena.cones.update(dt, v);
    if (hits > 0) {
      // beginners clip the cone ring round the pad on the way out: no penalty (or "-200" pop-up) for them
      if (this.mode === 'show') { if (!this.easy) this.award('CONE', -100 * hits, { bank: true, kind: 'bad' }); }
      else this.award('CONE BOWLING', 50 * hits, { bank: true });
    }

    // gas warnings (the tank only refills when stopped on the ground)
    const flying = v.armed || v.airborne;
    if (v.gas < 0.2 && v.gas >= 0.02 && v.armed && !this.gasLowWarned) {
      this.gasLowWarned = true;
      hud.toast('LOW GAS — save some for the landing', 1.6);
    }
    if (v.gas < 0.02 && flying && !this.gasWarned) {
      this.gasWarned = true;
      hud.toast('GAS EMPTY — stop on the ground to refuel');
    }
    if (v.gas > 0.3) {
      this.gasWarned = false;
      this.gasLowWarned = false;
    }

    // objectives
    const cur = v.pos;
    if (this.mode === 'free') {
      this.arena.rings.forEach((r, i) => {
        if (this.ringCooldown[i] <= 0 && r.checkPass(this.prevPos, cur)) {
          this.ringCooldown[i] = 2;
          r.flash = 1;
          this.award('RING', 500, { bank: true, kind: 'good' });
          this.audio.whoosh();
          this.arena.kick(0.4);
        }
      });
    } else if (this.mode === 'show') {
      this.updateShow(dt, cur);
      if (this.state !== 'play') return;
    }

    this.prevPos.copy(cur);
    this.updateHud(dt);
  }

  updateShow(dt, cur) {
    const v = this.vehicle;
    const s = STEPS[this.step];
    if (!s) return;
    const easy = this.easy;
    switch (s.id) {
      case 'gate': {
        // easy: crossing the gate line either way counts (a car that turned back still gets it)
        const crossed = easy ? (this.prevPos.z < GATE.z) !== (cur.z < GATE.z) : this.prevPos.z < GATE.z && cur.z >= GATE.z;
        if (crossed && Math.abs(cur.x) < GATE.halfW + 0.5 && v.altitude < 3) {
          this.audio.whoosh();
          this.advance();
        }
        break;
      }
      case 'lift': {
        // easy: flying straight through the ring while still climbing counts for both steps
        const r = this.arena.rings[this.ringIndex];
        if (easy && v.armed && r.checkPass(this.prevPos, cur)) {
          this.advance();
          this.passRing(r);
        } else if (v.altitude > 8) this.advance();
        break;
      }
      case 'rings': {
        const r = this.arena.rings[this.ringIndex];
        if (r.checkPass(this.prevPos, cur)) this.passRing(r);
        break;
      }
      case 'land': {
        // easy: a car that touched down just off the pad can also drive (or hover-taxi) onto it
        const d = Math.hypot(cur.x - PAD.x, cur.z - PAD.z);
        if (easy && v.grounded >= 3 && d < this.padR && v.vel.length() < 6) {
          this.award('ON THE PAD', 250, { bank: true, kind: 'good' });
          this.advance();
        }
        break;
      }
      case 'donut':
        if (this.donuts >= this.donutGoal) this.advance();
        break;
      case 'park': {
        const d = Math.hypot(cur.x - STAGE.x, cur.z - STAGE.z);
        if (d < this.parkR && v.vel.length() < (easy ? 1.2 : 0.9) && v.grounded >= 3) {
          this.parkTimer += dt;
          if (this.parkTimer > (easy ? 0.6 : 1)) this.advance();
        } else this.parkTimer = 0;
        break;
      }
      default:
        break;
    }
  }

  passRing(r) {
    r.flash = 1;
    this.award(`RING ${this.ringIndex + 1}`, 500, { bank: true, kind: 'good' });
    this.audio.whoosh();
    this.ringIndex++;
    if (this.ringIndex >= this.ringCount) this.advance();
    else {
      this.audio.blip(990, 0.15, 0.08);
      this.syncMarkers();
    }
  }

  onLeave(e) {
    this.resetAir();
    this.air.from = e.surface;
    if (e.surface === 'kicker' && e.speed > 12) {
      this.air.kicker = true;
      this.tipTimer = 0; // this attempt is airborne: the old tip has done its job
      this.fx.slowmo(1.5);
      this.fx.action(STUNTS.truck.shot, 2.6);
    } else if (e.surface === 'megawall' && e.y > 16) {
      this.air.wallLaunch = true;
      this.fx.slowmo(1.7);
      this.fx.action(STUNTS.wall.shot, 2.8);
      this.hud.trick('LAUNCH!', '', 'good');
      this.addViews(90000);
    } else if (e.surface === 'cloop' && this.loopInverted) {
      this.fx.slowmo(1.3);
      this.fx.action(STUNTS.loop.shot, 2.4);
    }
  }

  trickDone(name, pts) {
    this.award(name, pts);
    this.air.tricks.push(name);
    this.audio.cheer(0.9);
    this.arena.kick(1);
    if (this.mode === 'show' && STEPS[this.step] && STEPS[this.step].id === 'flip') this.advance();
  }

  onLand(e) {
    const v = this.vehicle;
    const vy = Math.abs(e.vy || 0);
    this.audio.thud(vy / 5);
    this.rig.addShake(Math.min(1, vy / 14));
    // bounces while a crash / fail is playing out (before the respawn) score nothing
    if (this.crashTimer > 0 || this.failTimer > 0) {
      this.resetAir();
      return;
    }
    const air = this.air;
    // beginner levels forgive an upright car whose bumper touches before its wheels
    const sideways = !e.onWheels && vy > 6 && !(this.easy && e.upright > 0.85);
    if (e.upright < 0.55 || sideways || vy > 16) {
      if (e.surface === 'cloop' || e.surface === 'megawall') return; // just touching the ramp again
      this.crash(vy > 16 ? 'BOTTOMED OUT' : 'CRASHED', this.landingFix(e, vy));
      return;
    }
    if (e.surface === 'cloop' || e.surface === 'megawall') return;
    let bonus = 0;
    if (e.airTime > 1.2 && vy < 3.2) {
      bonus = 250;
      this.hud.trick('SMOOTH LANDING', '+250', 'good');
    } else if (vy > 9) {
      this.hud.trick('HARD LANDING', '', 'bad');
    }
    if (this.pending > 0) {
      const mult = 1 + 0.5 * Math.max(0, this.combo - 1);
      const banked = Math.round(this.pending * mult);
      this.score += banked;
      this.addViews(banked * 30);
      if (this.combo > 0 || banked > 100) this.hud.trick('LANDED', `+${banked.toLocaleString()}${mult > 1 ? `  (x${mult})` : ''}`, 'good');
      if (this.combo > 0) this.audio.cheer(0.8 + Math.min(1, this.combo * 0.2));
    }
    this.score += bonus;
    this.pending = 0;
    this.combo = 0;
    const kickflipped = air.tricks.includes('KICKFLIP');
    const flipped = air.tricks.some((t) => FLIPS.includes(t));
    const stepId = this.stepId;
    const truckStep = TRUCK_STEPS.has(stepId);

    // stunt resolutions
    if (air.overTruck) {
      if (truckStep && e.surface === 'truck') {
        this.fail('ON THE TRUCK', 'clear it all the way', FIX.onTruck);
      } else if (stepId === 'kickflip') {
        if (kickflipped) this.stuntComplete('TRUCK KICKFLIP', 2500);
        else this.fail('CLEARED IT!', 'now add the KICKFLIP (R)');
      } else if (stepId === 'truckjump') {
        this.stuntComplete('CAR JUMP', 2000);
      } else if (stepId === 'flipjump') {
        if (flipped) this.stuntComplete('FLIP JUMP', 2500);
        else this.fail('CLEARED IT!', 'now add a flip (R, F or B)', FIX.noFlip);
      } else {
        this.award(kickflipped ? 'TRUCK KICKFLIP' : 'TRUCK JUMP', kickflipped ? 2500 : 1200, { bank: true, kind: 'good', big: kickflipped });
        this.fx.burst('truck');
      }
    } else if (air.kicker && truckStep) {
      this.fail('TOO SHORT', 'more speed off the kicker', FIX.slow);
    } else if (this.easy && truckStep && air.from === 'kicker') {
      this.fail(FIX.slow[0], '', FIX.slow); // rolled off the ramp too slowly to count as a launch
    }
    if (air.wallLaunch) {
      const inZone = this.stunts.inZone('wall', v.pos);
      if (stepId === 'walllaunch') {
        if (inZone) this.stuntComplete('WALL LAUNCH', 2500);
        else this.fail('MISSED THE ZONE', 'hover back over the smoke zone');
      } else {
        this.award('WALL LAUNCH', inZone ? 2000 : 1200, { bank: true, kind: 'good', big: inZone });
        if (inZone) this.fx.burst('wall');
      }
    }
    if (this.loopInverted) {
      this.loopInverted = false;
      if (stepId === 'loop') this.stuntComplete('C-LOOP', 2500);
      else {
        this.award('C-LOOP', 1800, { bank: true, kind: 'good', big: true });
        this.fx.burst('loop');
      }
    }

    // launch show pad landing
    const onPad = Math.hypot(v.pos.x - PAD.x, v.pos.z - PAD.z) < this.padR;
    if (this.mode === 'show' && STEPS[this.step] && STEPS[this.step].id === 'land' && onPad) {
      this.award('PAD LANDING', 400, { bank: true, kind: 'good' });
      this.advance();
    } else if (this.mode === 'free' && onPad) {
      this.award('PAD LANDING', 300, { bank: true, kind: 'good' });
    }
    this.resetAir();
  }

  // beginner levels: why a landing crashed, as [title, what to do]
  landingFix(e, vy) {
    if (!this.easy) return null;
    if (vy > 16) return FIX.hard;
    const a = this.air;
    const done = a.tricks.filter((t) => FLIPS.includes(t)).length;
    if (a.started > done) {
      if (a.started > 1) return FIX.twoFlips;
      return this.mode === 'show' ? FIX.lowFlip : FIX.lateFlip;
    }
    return e.upright < 0.55 ? FIX.upside : FIX.side;
  }

  objectiveTarget() {
    if (this.state !== 'play') return null;
    if (this.mode === 'stunt') {
      const id = this.stepId;
      if (TRUCK_STEPS.has(id)) return this.air.kicker ? new THREE.Vector3(STUNTS.truck.land.x, 0.5, STUNTS.truck.land.z) : STUNTS.truck.kicker.origin.clone().setY(1.5);
      if (id === 'wallride') return STUNTS.wall.origin.clone().setY(STUNTS.wall.top);
      if (id === 'walllaunch') return new THREE.Vector3(STUNTS.wall.land.x, 0.5, STUNTS.wall.land.z);
      if (id === 'loop') return STUNTS.loop.origin.clone().setY(2);
      if (id === 'finale') return new THREE.Vector3(STUNTS.finale.center.x, 0.5, STUNTS.finale.center.z);
      return null;
    }
    if (this.mode !== 'show') return null;
    const s = STEPS[this.step];
    const id = s ? s.id : null;
    if (id === 'gate') return new THREE.Vector3(0, 1.5, GATE.z);
    if (id === 'rings') return this.arena.rings[this.ringIndex].pos;
    if (id === 'land' || id === 'donut') return new THREE.Vector3(PAD.x, 0.5, PAD.z);
    if (id === 'park') return new THREE.Vector3(STAGE.x, STAGE.h + 0.5, STAGE.z);
    return null;
  }

  // ------------------------------------------------------------------ beginner coach
  // The single next thing to do, as { text, sub?, tip?, urgent? } ([KEY] = keycap), or null.
  coachPrompt() {
    if (!this.easy || this.mode === 'attract') return null;
    if (this.state === 'countdown') return { text: 'GET READY — then HOLD [W]' };
    if (this.state !== 'play' || this.crashTimer > 0 || this.failTimer > 0 || this.nextTimer > 0) return null;
    const inp = this.inp || {};
    const p = this.mode === 'show' ? this.coachShow(inp) : this.coachJump(inp);
    if (p && this.tipTimer > 0 && this.tip) p.tip = this.tip;
    return p;
  }

  // 'A' / 'D' when the point (x, z) is well off the nose (with hysteresis so the prompt doesn't flicker), else null
  steerCue(x, z, enter = 0.7, exit = 0.35) {
    const v = this.vehicle;
    const dx = x - v.pos.x, dz = z - v.pos.z;
    const ahead = dx * v.fwd.x + dz * v.fwd.z;
    const side = dx * v.left.x + dz * v.left.z; // > 0: on the car's left
    const ang = Math.abs(Math.atan2(side, ahead));
    this.turning = this.turning ? ang > exit : ang > enter;
    return this.turning ? (side > 0 ? 'A' : 'D') : null;
  }

  coachJump(inp) {
    const v = this.vehicle;
    const a = this.air;
    const flipLevel = this.stepId === 'flipjump';
    const flipped = a.tricks.some((t) => FLIPS.includes(t));
    if (v.airborne) {
      if (flipLevel && !flipped) {
        if (a.started === 0 && !v.trick && a.kicker) return { text: 'PRESS [F] NOW!', urgent: true };
        if (a.started > 0) return { text: 'FLIPPING — hands off!' };
      }
      return { text: 'LAND IT!', sub: 'let go of the keys — the car levels itself' };
    }
    const K = STUNTS.truck.kicker.origin;
    const fwd = v.forwardSpeed;
    // on the ramp at launch speed: the trick buffer takes a press up to 0.6 s before take-off
    if (flipLevel && v.surface === 'kicker' && fwd > 12) return { text: 'PRESS [F] NOW!', sub: 'keep holding [W]', urgent: true };
    if (fwd < -0.5 && inp.brake > 0.5) return { text: 'Let go of [S] — HOLD [W]' };
    const k = v.pos.x > K.x + 4 ? this.steerCue(K.x - 3, K.z, 0.45, 0.2) : null;
    if (k) return { text: `STEER [${k}] — aim at the ramp`, sub: 'keep holding [W]' };
    if (this.wHeld && inp.throttle < 0.5) return { text: 'KEEP HOLDING [W]', urgent: true };
    return { text: 'HOLD [W] — full speed!', sub: flipLevel ? 'then press [F] as you leave the ramp' : 'don\'t let go until you\'re in the air' };
  }

  coachShow(inp) {
    const v = this.vehicle;
    const s = STEPS[this.step];
    if (!s) return null;
    const alt = v.altitude;
    const flying = v.armed || v.airborne;
    const dist = (x, z) => Math.hypot(x - v.pos.x, z - v.pos.z);
    const lowLever = v.armed && (inp.thrustLevel ?? 1) < 0.45;
    switch (s.id) {
      case 'gate': {
        if (alt > 3) return { text: 'HOLD [SHIFT] — drive through the gate first' };
        // aim at the nearest point of the gate opening, not its centre
        const gx = Math.max(-GATE.halfW + 2, Math.min(GATE.halfW - 2, v.pos.x));
        const k = Math.abs(GATE.z - v.pos.z) > 3 ? this.steerCue(gx, GATE.z) : null;
        if (k) return { text: `HOLD [W] + [${k}] — steer to the gate` };
        return { text: 'HOLD [W] — drive through the gate', sub: '[A] [D] to steer' };
      }
      case 'lift':
        if (lowLever && inp.lift > 0 && v.vel.y < 1) return { text: 'PRESS [4] — full thrust' };
        if (!v.armed) return { text: 'HOLD [SPACE] to lift off' };
        return { text: 'KEEP HOLDING [SPACE] — go up!', sub: 'up to 8 m' };
      case 'rings': {
        const r = this.arena.rings[this.ringIndex];
        const dy = r.pos.y - v.pos.y;
        // height cue with hysteresis (+1 climb, -1 descend, 0 level), updated every frame so it never goes stale
        if (this.heightCue > 0 && dy < 1.5) this.heightCue = 0;
        else if (this.heightCue < 0 && dy > -1.5) this.heightCue = 0;
        if (this.heightCue === 0) this.heightCue = dy > 3.2 ? 1 : dy < -3.2 ? -1 : 0;
        if (!flying) return { text: 'HOLD [SPACE] to fly' };
        const k = dist(r.pos.x, r.pos.z) > 8 ? this.steerCue(r.pos.x, r.pos.z) : null;
        if (k) return { text: `TURN [${k}] toward the ring` };
        if (this.heightCue > 0) return lowLever ? { text: 'PRESS [4] — full thrust' } : { text: 'HOLD [SPACE] — go higher' };
        if (this.heightCue < 0) return { text: 'HOLD [SHIFT] — go lower' };
        return { text: 'Fly through the ring — HOLD [W]', sub: '[A] [D] turn · [SPACE] up · [SHIFT] down' };
      }
      case 'flip':
        if (v.trick) this.lastTrickT = this.time;
        if (this.time - (this.lastTrickT ?? -9) < 0.6) return null; // flip in progress / just landed it
        if (!flying) return { text: 'HOLD [SPACE] to fly — then [F]' };
        if (alt < 3) return { text: 'HOLD [SPACE] — a bit higher' };
        return { text: 'PRESS [F] to flip' };
      case 'land': {
        const R = this.padR;
        if (!flying) return this.driveTo(PAD.x, PAD.z, R, 'pad');
        const d = dist(PAD.x, PAD.z);
        if (d > R + 6) {
          const k = this.steerCue(PAD.x, PAD.z);
          if (k) return { text: `TURN [${k}] toward the pad` };
          return { text: 'Fly to the pad — HOLD [W]', sub: 'follow the marker' };
        }
        // where would it touch down from here (descending ~5 m/s)? On the pad: go down. Overshooting or
        // drifting away: slow down. Short of it: turn to it / fly on.
        const t = Math.max(0, alt) / 5;
        const px = v.pos.x + v.vel.x * t - PAD.x, pz = v.pos.z + v.vel.z * t - PAD.z;
        if (Math.hypot(px, pz) < R - 1.5) return { text: 'HOLD [SHIFT] to land on the pad' };
        const dx = PAD.x - v.pos.x, dz = PAD.z - v.pos.z;
        const hs = Math.hypot(v.vel.x, v.vel.z);
        const closing = (v.vel.x * dx + v.vel.z * dz) / Math.max(d, 0.1);
        const past = px * dx + pz * dz > 0;
        if (hs > 3 && (past || closing < 1.5)) return v.forwardSpeed > 2 ? { text: 'HOLD [S] — slow down' } : { text: 'Let go of the keys — slow down' };
        const k = this.steerCue(PAD.x, PAD.z, 0.5, 0.25);
        if (k) return { text: `TURN [${k}] toward the pad` };
        return { text: 'Fly over the pad — HOLD [W]', sub: 'follow the marker' };
      }
      case 'donut':
        // jets still on and hovering (even a hand's width up): bring it down first
        if (v.armed && (v.airborne || alt > 0.6)) return { text: 'HOLD [SHIFT] to land' };
        if (v.airborne) return null;
        if (!v.burnout && Math.abs(v.forwardSpeed) > 6.5) return { text: 'HOLD [S] — slow down' };
        if (!v.burnout) return { text: 'HOLD [W] + [S] for a burnout' };
        if (Math.abs(inp.steer || 0) < 0.3) return { text: 'Now also HOLD [A] or [D]', sub: 'spin it round!' };
        return { text: 'KEEP SPINNING!' };
      case 'park':
        if (v.armed && (v.airborne || alt > 0.6)) return { text: 'HOLD [SHIFT] to land' };
        if (v.airborne) return null;
        return this.driveTo(STAGE.x, STAGE.z, this.parkR, 'stage');
      default:
        return null;
    }
  }

  // ground approach to a stop zone (pad / stage): drive, brake in time, slow down to turn, roll in, stop
  driveTo(x, z, R, name) {
    const v = this.vehicle;
    const inp = this.inp || {};
    const fwd = v.forwardSpeed;
    if (fwd < -0.8 && inp.brake > 0.5) return { text: 'Let go of [S]' };
    const d = Math.hypot(x - v.pos.x, z - v.pos.z);
    if (d < R) return fwd > 1.2 ? { text: 'HOLD [S] to stop' } : { text: 'STOP — hold still…' };
    // brake early enough to stop in the zone, or before a tight turn (latched until slow, so the prompt doesn't flip W / S)
    const k = this.steerCue(x, z);
    const stopDist = fwd > 0 ? (fwd * fwd) / 18 + fwd * 0.5 : 0;
    if (this.braking) this.braking = fwd > 6;
    else this.braking = fwd > 7 && (d - R * 0.5 < stopDist + 6 || (!!k && fwd > 12));
    if (this.braking) return { text: 'HOLD [S] — slow down' };
    // turning: add W only when nearly stopped (latched, so it doesn't flip between "W + A" and "A")
    if (this.coasting) this.coasting = fwd > 3.5;
    else this.coasting = fwd > 8;
    if (k) return this.coasting ? { text: `HOLD [${k}] — turn to the ${name}` } : { text: `HOLD [W] + [${k}] — turn to the ${name}` };
    if (d < 30 && fwd > 2.5) return { text: `Let go — roll onto the ${name}` };
    return { text: `Drive onto the ${name} and stop`, sub: 'HOLD [W] · follow the marker' };
  }

  updateHud(dt) {
    const hud = this.hud;
    const v = this.vehicle;
    const L = this.level;
    hud.setScore(this.score, dt);
    hud.setViews(this.views, dt);
    hud.setPending(Math.round(this.pending), this.combo);
    hud.setEasy(this.easy && this.mode !== 'attract');
    hud.brief(this.state === 'brief' && L && L.brief ? L : null);
    hud.setCoach(this.coachPrompt());
    if (this.mode === 'show') {
      const n = Math.min(this.step + 1, STEPS.length);
      const s = STEPS[n - 1];
      const rings = this.ringCount, donuts = this.donutGoal;
      let prog = '';
      if (s.id === 'lift') prog = `ALTITUDE ${Math.max(0, v.altitude).toFixed(0)} / 8 M`;
      if (s.id === 'rings') prog = `${this.ringIndex} / ${rings} ${rings === 1 ? 'RING' : 'RINGS'}`;
      if (s.id === 'donut') prog = `${this.donuts} / ${donuts} ${donuts === 1 ? 'DONUT' : 'DONUTS'} · hold W + S, steer`;
      if (s.id === 'flip') prog = 'press F';
      if (s.id === 'gate') prog = 'hold W · A / D to steer';
      if (s.id === 'park') prog = this.parkTimer > 0 ? 'HOLD IT…' : 'stop on the stage';
      if (s.id === 'land') prog = 'hold SHIFT to go down';
      const head = L ? `LEVEL ${L.num} · STEP ${n} / ${STEPS.length}` : `STEP ${n} / ${STEPS.length}`;
      hud.setObjective(head, 0, s.text, prog);
      hud.setTimer(this.time);
    } else if (this.mode === 'stunt') {
      const s = this.tourStep;
      let prog = s.hint;
      if (s.id === 'wallride') prog = `HEIGHT ${Math.max(0, v.pos.y - 0.5).toFixed(0)} / ${STUNTS.wall.top - 3} M · ${s.hint}`;
      if (s.id === 'finale') prog = `${this.donuts} / 3 DONUTS · ${s.hint}`;
      if (TRUCK_STEPS.has(s.id) && v.airborne) {
        const flipped = this.air.tricks.some((t) => FLIPS.includes(t));
        if (s.id === 'flipjump' && flipped) prog = this.air.overTruck ? 'FLIPPED & CLEARED · land it clean' : 'FLIP DONE · now clear the truck';
        else if (this.air.overTruck) prog = s.id === 'truckjump' ? 'CLEARED · land it clean' : s.id === 'flipjump' ? 'CLEARED · FLIP NOW (R, F or B)' : 'CLEARED · KICKFLIP NOW (R)';
      }
      const multi = this.stuntGroups().length > 1;
      const head = L ? `LEVEL ${L.num} · ${multi ? s.title : L.title}` : s.title;
      hud.setObjective(head, 0, s.text, prog);
      hud.setTimer(this.time);
    } else if (this.mode === 'free') {
      hud.setObjective('FREE ROAM', 0, 'Rings · truck jump · Mega Wall · C-Loop', 'tricks bank when you land clean');
      hud.setTimer(null);
    }
  }
}
