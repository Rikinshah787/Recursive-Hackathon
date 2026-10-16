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
  { id: 'gate', text: 'Roll out — drive down the cone lane' },
  { id: 'lift', text: 'Lift off — hold SPACE to fire the thrusters' },
  { id: 'rings', text: 'Fly through the neon rings' },
  { id: 'flip', text: 'Show off — press F to flip' },
  { id: 'land', text: 'Touch down on the landing pad' },
  { id: 'donut', text: 'Burnout! Hold W + S and steer for donuts' },
  { id: 'park', text: 'Bring it home — park on the stage' },
];

// Stunt Tour: the roadmap from the kickflip + wall-ride videos
const TOUR = [
  { id: 'kickflip', group: 'truck', title: 'TRUCK KICKFLIP', text: 'Hit the kicker and KICKFLIP over the truck', hint: 'Full throttle · press R in the air' },
  { id: 'wallride', group: 'wall', title: 'MEGA WALL', text: 'Floor it straight up the Mega Wall', hint: 'Full throttle · keep it straight' },
  { id: 'walllaunch', group: 'wall', title: 'MEGA WALL', text: 'Launch off the top & jet-land in the smoke zone', hint: 'SPACE = thrusters · SHIFT = descend' },
  { id: 'loop', group: 'loop', title: 'THE C-LOOP', text: 'Run the C-Loop upside down & stick the landing', hint: 'Full throttle · SPACE to catch the drop' },
  { id: 'finale', group: 'finale', title: 'DONUT FINALE', text: 'Burn 3 donuts inside the laser grid', hint: 'Hold W + S and steer' },
];
const TOUR_STUNTS = 4;

export class Game {
  constructor({ vehicle, arena, stunts, hud, audio, rig, fx, onFinish }) {
    Object.assign(this, { vehicle, arena, stunts, hud, audio, rig, fx, onFinish });
    this.mode = 'attract';
    this.state = 'title';
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
    this.loopInverted = false;
    this.wallRidden = false;
    this.fading = false;
    this.resetAir();
  }

  resetAir() {
    this.acc = { pitch: 0, roll: 0, yaw: 0 };
    this.airPoints = 0;
    this.air = { from: null, tricks: [], overTruck: false, wallLaunch: false, kicker: false };
  }

  // ------------------------------------------------------------------ flow
  start(mode) {
    this.mode = mode;
    this.resetRun();
    this.arena.cones.reset();
    this.prevPos.copy(this.vehicle.pos);
    this.rig.snap = true;
    if (mode === 'stunt') {
      this.beginTourStep(0, true);
    } else {
      const spawn = mode === 'show' ? LAYOUT.spawnStage : LAYOUT.spawnFree;
      this.vehicle.reset(new THREE.Vector3(spawn.x, 0, spawn.z), spawn.heading);
      this.lastSafe.pos.set(spawn.x, 0, spawn.z);
      this.lastSafe.heading = spawn.heading;
      this.stunts.setActive(null);
      if (mode === 'show') {
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

  get controlsLive() {
    return this.state === 'play' && this.crashTimer <= 0 && this.failTimer <= 0;
  }

  get tourStep() {
    return this.mode === 'stunt' ? TOUR[Math.min(this.step, TOUR.length - 1)] : null;
  }

  groupStart(group) {
    return STUNTS[group].start;
  }

  beginTourStep(i, first = false) {
    const prev = first ? null : TOUR[this.step];
    this.step = i;
    const st = TOUR[i];
    this.stunts.setActive(st.group);
    if (!prev || prev.group !== st.group) {
      const s = this.groupStart(st.group);
      this.vehicle.reset(new THREE.Vector3(s.x, 0, s.z), s.heading);
      this.prevPos.copy(this.vehicle.pos);
      this.rig.snap = true;
      this.resetAir();
      this.loopInverted = false;
      this.state = 'card';
      this.cardTimer = 2.4;
      const n = TOUR.slice(0, i + 1).filter((t, k) => k === 0 || t.group !== TOUR[k - 1].group).length;
      this.fx.card(st.group === 'finale' ? 'FINALE' : `STUNT ${n} / ${TOUR_STUNTS}`, st.title, st.hint);
      this.audio.blip(520, 0.2, 0.1, 'triangle');
    }
    this.syncMarkers();
  }

  syncMarkers() {
    const show = this.mode === 'show' ? STEPS[this.step] : null;
    const id = show ? show.id : null;
    this.arena.setGateActive(id === 'gate');
    this.arena.setPadActive(id === 'land' || id === 'donut' || this.mode === 'free');
    this.arena.setParkActive(id === 'park');
    this.arena.rings.forEach((r, i) => {
      if (this.mode === 'free') r.setState('active');
      else if (id === 'rings') r.setState(i < this.ringIndex ? 'done' : i === this.ringIndex ? 'active' : 'idle');
      else r.setState(this.mode === 'show' && this.step > 2 ? 'done' : 'idle');
    });
  }

  advance() {
    this.audio.chime();
    this.arena.kick(0.5);
    if (this.mode === 'stunt') {
      this.nextTimer = TOUR[this.step + 1] && TOUR[this.step + 1].group === TOUR[this.step].group ? 0.01 : 2.4;
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
    this.award(name, pts, { bank: true, kind: 'good', big: true });
    this.addViews(380000 + Math.random() * 120000);
    this.audio.cheer(1.4);
    this.arena.kick(1.5);
    this.fx.burst(TOUR[this.step] ? TOUR[this.step].group : null);
    this.advance();
  }

  fail(msg, sub = 'try again') {
    if (this.failTimer > 0 || this.crashTimer > 0) return;
    this.hud.trick(msg, sub, 'bad');
    this.failTimer = 1.6;
    this.audio.blip(220, 0.3, 0.12, 'sawtooth');
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

  crash(reason = 'CRASHED') {
    if (this.crashTimer > 0) return;
    this.hud.trick(reason, this.pending > 0 ? 'tricks lost' : '', 'bad');
    this.pending = 0;
    this.combo = 0;
    this.resetAir();
    if (this.mode === 'show') this.score = Math.max(0, this.score - 300);
    this.crashTimer = 2.2;
    this.audio.thud(1.5);
    this.rig.addShake(1);
  }

  respawn() {
    if (this.mode === 'stunt') {
      const s = this.groupStart(TOUR[this.step].group);
      this.vehicle.reset(new THREE.Vector3(s.x, 0, s.z), s.heading);
    } else {
      this.vehicle.reset(this.lastSafe.pos, this.lastSafe.heading);
    }
    this.prevPos.copy(this.vehicle.pos);
    this.rig.snap = true;
    this.loopInverted = false;
    this.resetAir();
  }

  finish() {
    this.state = 'results';
    const t = this.time;
    const par = this.mode === 'stunt' ? 220 : 160;
    const bonus = Math.max(0, Math.round((par - t) * 40));
    const total = this.score + bonus;
    const grade = total >= 15000 ? 'S' : total >= 11000 ? 'A' : total >= 7000 ? 'B' : 'C';
    const key = this.mode === 'stunt' ? 'roadster-best-stunt' : 'roadster-best';
    let best = 0;
    try { best = Number(localStorage.getItem(key) || 0); } catch { /* storage unavailable */ }
    const isBest = total > best;
    if (isBest) {
      try { localStorage.setItem(key, String(total)); } catch { /* storage unavailable */ }
    }
    this.audio.cheer(1.4);
    this.arena.kick(1.5);
    this.onFinish({ mode: this.mode, time: t, tricks: this.score, bonus, total, grade, best: Math.max(best, total), isBest, views: this.views });
  }

  // ------------------------------------------------------------------ per frame
  update(dt, input) {
    const v = this.vehicle;
    const hud = this.hud;

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

    // next tour step after a success
    if (this.nextTimer > 0) {
      this.nextTimer -= dt;
      if (this.nextTimer <= 0) {
        if (this.pendingNext >= TOUR.length) {
          this.finish();
          return;
        }
        const sameGroup = TOUR[this.pendingNext].group === TOUR[this.step].group;
        if (!sameGroup) {
          hud.fade(true);
          setTimeout(() => {
            this.beginTourStep(this.pendingNext);
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
        if (e.surface === 'truck' && e.speed > 6) this.crash('HIT THE TRUCK');
        else if (!ramp && (e.speed > 15 || (e.speed > 11 && v.up.y < 0.4))) this.crash();
      }
    }
    v.events.length = 0;

    const touching = !v.airborne;
    // stunt surfaces
    if (touching && v.surface === 'cloop' && v.up.y < -0.45 && !this.loopInverted) {
      this.loopInverted = true;
      this.hud.trick('INVERTED', '', 'good');
      this.addViews(60000);
    }
    if (touching && v.surface === 'megawall' && v.pos.y > STUNTS.wall.top - 3 && !this.wallRidden) {
      this.wallRidden = true;
      if (this.mode === 'stunt' && this.tourStep.id === 'wallride') this.stuntComplete('WALL RIDE', 1500);
      else this.award('WALL RIDE', 1000, { bank: true, kind: 'good' });
    }
    if (touching && v.surface === 'ground') this.wallRidden = false;

    // tricks in the air
    if (!touching) {
      if (this.stunts.overTruck(v.pos)) this.air.overTruck = true;
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
      if (!v.armed && v.vel.y < -9 && v.altitude > 8 && !this.thrustHinted) {
        this.thrustHinted = true;
        hud.toast('SPACE — FIRE THE THRUSTERS!', 1.6);
      }
    } else this.thrustHinted = false;

    // stuck upside down
    if (touching && v.up.y < 0.25 && v.surface !== 'cloop' && v.surface !== 'megawall' && this.crashTimer <= 0) {
      this.upsideTimer += dt;
      if (this.upsideTimer > 1.4) this.crash('ROLLED OVER');
    } else this.upsideTimer = 0;

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
        const counts = this.mode !== 'stunt' || (this.tourStep.id === 'finale' && inGrid);
        if (counts) this.donuts++;
        this.award(inGrid ? 'GRID DONUT' : 'DONUT', inGrid ? 400 : 300, { bank: true });
        this.audio.cheer(0.7);
        this.arena.kick(0.5);
        if (inGrid) this.fx.burst('finale', 0.4);
        if (this.mode === 'stunt' && this.tourStep.id === 'finale' && this.donuts >= 3) this.stuntComplete('DONUT FINALE', 2000);
      }
    } else {
      this.burnYaw *= 1 - Math.min(1, dt * 0.5);
    }

    // cones
    const hits = this.arena.cones.update(dt, v);
    if (hits > 0) {
      if (this.mode === 'show') this.award('CONE', -100 * hits, { bank: true, kind: 'bad' });
      else this.award('CONE BOWLING', 50 * hits, { bank: true });
    }

    // gas warning
    if (v.gas < 0.02 && v.armed && !this.gasWarned) {
      this.gasWarned = true;
      hud.toast('THRUST GAS EMPTY — land to refill');
    }
    if (v.gas > 0.3) this.gasWarned = false;

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
    }

    this.prevPos.copy(cur);
    this.updateHud(dt);
  }

  updateShow(dt, cur) {
    const v = this.vehicle;
    const s = STEPS[this.step];
    switch (s.id) {
      case 'gate':
        if (this.prevPos.z < GATE.z && cur.z >= GATE.z && Math.abs(cur.x) < GATE.halfW + 0.5 && v.altitude < 3) {
          this.audio.whoosh();
          this.advance();
        }
        break;
      case 'lift':
        if (v.altitude > 8) this.advance();
        break;
      case 'rings': {
        const r = this.arena.rings[this.ringIndex];
        if (r.checkPass(this.prevPos, cur)) {
          r.flash = 1;
          this.award(`RING ${this.ringIndex + 1}`, 500, { bank: true, kind: 'good' });
          this.audio.whoosh();
          this.ringIndex++;
          if (this.ringIndex >= this.arena.rings.length) this.advance();
          else {
            this.audio.blip(990, 0.15, 0.08);
            this.syncMarkers();
          }
        }
        break;
      }
      case 'donut':
        if (this.donuts >= 2) this.advance();
        break;
      case 'park': {
        const d = Math.hypot(cur.x - STAGE.x, cur.z - STAGE.z);
        if (d < 3.4 && v.vel.length() < 0.9 && v.grounded >= 3) {
          this.parkTimer += dt;
          if (this.parkTimer > 1) this.advance();
        } else this.parkTimer = 0;
        break;
      }
      default:
        break;
    }
  }

  onLeave(e) {
    const v = this.vehicle;
    this.resetAir();
    this.air.from = e.surface;
    if (e.surface === 'kicker' && e.speed > 12) {
      this.air.kicker = true;
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
    void v;
  }

  trickDone(name, pts) {
    this.award(name, pts);
    this.air.tricks.push(name);
    this.audio.cheer(0.9);
    this.arena.kick(1);
    if (this.mode === 'show' && STEPS[this.step].id === 'flip') this.advance();
  }

  onLand(e) {
    const v = this.vehicle;
    const vy = Math.abs(e.vy || 0);
    this.audio.thud(vy / 5);
    this.rig.addShake(Math.min(1, vy / 14));
    const air = this.air;
    if (e.upright < 0.55 || (!e.onWheels && vy > 6) || vy > 16) {
      if (e.surface === 'cloop' || e.surface === 'megawall') return; // just touching the ramp again
      this.crash(vy > 16 ? 'BOTTOMED OUT' : 'CRASHED');
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
    const tour = this.tourStep;

    // stunt resolutions
    if (air.overTruck) {
      if (this.mode === 'stunt' && tour.id === 'kickflip') {
        if (kickflipped) this.stuntComplete('TRUCK KICKFLIP', 2500);
        else this.fail('CLEARED IT!', 'now add the KICKFLIP (R)');
      } else {
        this.award(kickflipped ? 'TRUCK KICKFLIP' : 'TRUCK JUMP', kickflipped ? 2500 : 1200, { bank: true, kind: 'good', big: kickflipped });
        this.fx.burst('truck');
      }
    } else if (air.kicker && this.mode === 'stunt' && tour.id === 'kickflip') {
      this.fail('TOO SHORT', 'more speed off the kicker');
    }
    if (air.wallLaunch) {
      const inZone = this.stunts.inZone('wall', v.pos);
      if (this.mode === 'stunt' && tour.id === 'walllaunch') {
        if (inZone) this.stuntComplete('WALL LAUNCH', 2500);
        else this.fail('MISSED THE ZONE', 'hover back over the smoke zone');
      } else {
        this.award('WALL LAUNCH', inZone ? 2000 : 1200, { bank: true, kind: 'good', big: inZone });
        if (inZone) this.fx.burst('wall');
      }
    }
    if (this.loopInverted) {
      this.loopInverted = false;
      if (this.mode === 'stunt' && tour.id === 'loop') this.stuntComplete('C-LOOP', 2500);
      else {
        this.award('C-LOOP', 1800, { bank: true, kind: 'good', big: true });
        this.fx.burst('loop');
      }
    }

    // launch show pad landing
    const onPad = Math.hypot(v.pos.x - PAD.x, v.pos.z - PAD.z) < PAD.r + 1.2;
    if (this.mode === 'show' && STEPS[this.step].id === 'land' && onPad) {
      this.award('PAD LANDING', 400, { bank: true, kind: 'good' });
      this.advance();
    } else if (this.mode === 'free' && onPad) {
      this.award('PAD LANDING', 300, { bank: true, kind: 'good' });
    }
    this.resetAir();
  }

  objectiveTarget() {
    if (this.state !== 'play') return null;
    if (this.mode === 'stunt') {
      const id = this.tourStep.id;
      if (id === 'kickflip') return this.air.kicker ? new THREE.Vector3(STUNTS.truck.land.x, 0.5, STUNTS.truck.land.z) : STUNTS.truck.kicker.origin.clone().setY(1.5);
      if (id === 'wallride') return STUNTS.wall.origin.clone().setY(STUNTS.wall.top);
      if (id === 'walllaunch') return new THREE.Vector3(STUNTS.wall.land.x, 0.5, STUNTS.wall.land.z);
      if (id === 'loop') return STUNTS.loop.origin.clone().setY(2);
      if (id === 'finale') return new THREE.Vector3(STUNTS.finale.center.x, 0.5, STUNTS.finale.center.z);
      return null;
    }
    if (this.mode !== 'show') return null;
    const id = STEPS[this.step].id;
    if (id === 'gate') return new THREE.Vector3(0, 1.5, GATE.z);
    if (id === 'rings') return this.arena.rings[this.ringIndex].pos;
    if (id === 'land' || id === 'donut') return new THREE.Vector3(PAD.x, 0.5, PAD.z);
    if (id === 'park') return new THREE.Vector3(STAGE.x, STAGE.h + 0.5, STAGE.z);
    return null;
  }

  updateHud(dt) {
    const hud = this.hud;
    const v = this.vehicle;
    hud.setScore(this.score, dt);
    hud.setViews(this.views, dt);
    hud.setPending(Math.round(this.pending), this.combo);
    if (this.mode === 'show') {
      const s = STEPS[Math.min(this.step, STEPS.length - 1)];
      let prog = '';
      if (s.id === 'lift') prog = `ALTITUDE ${Math.max(0, v.altitude).toFixed(0)} / 8 M`;
      if (s.id === 'rings') prog = `${this.ringIndex} / ${this.arena.rings.length} RINGS`;
      if (s.id === 'donut') prog = `${this.donuts} / 2 DONUTS`;
      if (s.id === 'flip') prog = 'B = backflip · R = kickflip';
      if (s.id === 'gate') prog = 'W to drive · A / D to steer';
      if (s.id === 'park') prog = this.parkTimer > 0 ? 'HOLD IT…' : 'stop inside the bay';
      if (s.id === 'land') prog = 'SHIFT to descend';
      hud.setObjective(Math.min(this.step + 1, STEPS.length), STEPS.length, s.text, prog);
      hud.setTimer(this.time);
    } else if (this.mode === 'stunt') {
      const s = this.tourStep;
      let prog = s.hint;
      if (s.id === 'wallride') prog = `HEIGHT ${Math.max(0, v.pos.y - 0.5).toFixed(0)} / ${STUNTS.wall.top - 3} M · ${s.hint}`;
      if (s.id === 'finale') prog = `${this.donuts} / 3 DONUTS · ${s.hint}`;
      hud.setObjective(s.title, 0, s.text, prog);
      hud.setTimer(this.time);
    } else if (this.mode === 'free') {
      hud.setObjective('FREE ROAM', 0, 'Rings · truck kickflip · Mega Wall · C-Loop', 'tricks bank when you land clean');
      hud.setTimer(null);
    }
  }
}
