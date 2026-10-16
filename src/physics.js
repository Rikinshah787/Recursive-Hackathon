import * as THREE from 'three';
import { clamp, TAU } from './util.js';
import { CAR } from './car.js';

const G = 9.81;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _n = new THREE.Vector3(), _r = new THREE.Vector3(), _f = new THREE.Vector3(), _vp = new THREE.Vector3();
const _wf = new THREE.Vector3(), _wl = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _qi = new THREE.Quaternion(), _dir = new THREE.Vector3(), _avgN = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

const REST_LEN = 0.28;
const SPRING_K = 36000;
const SPRING_C = 3400;
const MU = 1.3;
const ANCHOR_Y = 0.016; // relative to CoM

// Fuel: burn = (BASE_BURN + (1 - BASE_BURN) * thrust/max) per FULL_BURN_S while armed.
// Full power empties a full tank in ~14 s; hover (~0.42 of max) lasts ~29 s.
const FULL_BURN_S = 14;
const BASE_BURN = 0.1; // idle burn while the jets are armed
const REFUEL_RATE = 0.1; // tank fraction per second, only while parked
const LEVER_DEFAULT = 0.6;

// Collision probe points (relative to CoM)
// The bumper points sit higher than the belly (real overhang angles) so the car can ride curved ramps.
const BODY_POINTS = [
  [0.85, -0.05, 1.9], [-0.85, -0.05, 1.9], [0.85, -0.03, -1.9], [-0.85, -0.03, -1.9],
  [0.8, -0.25, 1.0], [-0.8, -0.25, 1.0], [0.8, -0.25, -1.0], [-0.8, -0.25, -1.0], [0, -0.27, 0],
  [0.9, 0.38, 1.85], [-0.9, 0.38, 1.85], [0.9, 0.42, -1.9], [-0.9, 0.42, -1.9],
  [0, 0.66, -0.1], [0.55, 0.55, -0.1], [-0.55, 0.55, -0.1], [0, 0.6, 0.45], [0, 0.6, -0.65],
  [0, 0.0, 2.18], [0, 0.1, -2.15], [0.97, 0.15, 0], [-0.97, 0.15, 0],
].map(([x, y, z]) => new THREE.Vector3(x, y, z));

export class Vehicle {
  constructor(world) {
    this.world = world;
    this.mass = 1600;
    this.inertia = new THREE.Vector3(2700, 3000, 760);
    this.maxThrust = this.mass * G * 2.4;
    this.gasCap = 1; // tank size for the current level (0..1); reset() fills to this
    this.thrustLevel = LEVER_DEFAULT; // mirrors the player's lever for the HUD

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.angVel = new THREE.Vector3();
    this.prevPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.renderPos = new THREE.Vector3();
    this.renderQuat = new THREE.Quaternion();
    this.contactNormal = new THREE.Vector3(0, 1, 0);

    this.force = new THREE.Vector3();
    this.torque = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.fwd = new THREE.Vector3(0, 0, 1);
    this.left = new THREE.Vector3(1, 0, 0);

    this.wheels = [
      [CAR.trackHalf, CAR.wheelZ, true], [-CAR.trackHalf, CAR.wheelZ, true],
      [CAR.trackHalf, -CAR.wheelZ, false], [-CAR.trackHalf, -CAR.wheelZ, false],
    ].map(([x, z, front]) => ({
      anchor: new THREE.Vector3(x, ANCHOR_Y, z),
      front,
      side: Math.sign(x),
      contact: false,
      contactPoint: new THREE.Vector3(),
      surface: 'ground',
      susp: REST_LEN,
      load: 0,
      slip: 0,
      spin: 0,
      spinRate: 0,
      steer: 0,
    }));

    this.accum = 0;
    this.fixedDt = 1 / 120;
    this.events = [];
    this.reset(new THREE.Vector3(0, 0, 0), 0);
  }

  reset(groundPos, heading) {
    const h = this.world.height(groundPos.x, groundPos.z);
    this.pos.set(groundPos.x, h + CAR.comY + 0.05, groundPos.z);
    this.quat.setFromAxisAngle(Y, heading);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.renderPos.copy(this.pos);
    this.renderQuat.copy(this.quat);
    this.armed = false;
    this.landedTimer = 0;
    this.gas = this.tankCap();
    this.thrust = 0;
    this.thrustCmd = new THREE.Vector3(); // pitch/yaw/roll command for visuals
    this.trick = null;
    this.burnout = false;
    this.grounded = 0;
    this.bodyContacts = 0;
    this.airborne = false;
    this.airTime = 0;
    this.heading = heading;
    this.steerAngle = 0;
    this.brakeLight = 0;
    this.wasAirborne = false;
    this.lastAirVy = 0;
    this.surface = 'ground';
    this.wallGrip = 0;
    this.contactNormal.set(0, 1, 0);
    for (const w of this.wheels) {
      w.contact = false;
      w.susp = REST_LEN - 0.1;
      w.spinRate = 0;
      w.slip = 0;
    }
    this.events.length = 0;
    this.updateAxes();
  }

  tankCap() {
    return Number.isFinite(this.gasCap) ? clamp(this.gasCap, 0, 1) : 1;
  }

  updateAxes() {
    this.up.copy(Y).applyQuaternion(this.quat);
    this.fwd.copy(Z).applyQuaternion(this.quat);
    this.left.copy(X).applyQuaternion(this.quat);
  }

  get altitude() {
    return this.pos.y - CAR.comY - this.world.height(this.pos.x, this.pos.z);
  }

  get forwardSpeed() {
    return this.vel.dot(this.fwd);
  }

  applyForceAt(f, p) {
    this.force.add(f);
    _r.subVectors(p, this.pos);
    this.torque.add(_c.crossVectors(_r, f));
  }

  pointVelocity(p, out) {
    _r.subVectors(p, this.pos);
    return out.crossVectors(this.angVel, _r).add(this.vel);
  }

  // Torque that produces angular acceleration `alpha` (world) given the body inertia.
  torqueForAlpha(alpha, out) {
    _qi.copy(this.quat).invert();
    out.copy(alpha).applyQuaternion(_qi);
    out.set(out.x * this.inertia.x, out.y * this.inertia.y, out.z * this.inertia.z);
    return out.applyQuaternion(this.quat);
  }

  startTrick(type) {
    const alt = this.altitude;
    if (this.trick || this.gas < 0.08) return false;
    const flying = this.armed && alt > 1.5;
    if (!flying && !(this.airborne && alt > 1.5)) return false;
    const axis = type === 'roll' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(type === 'backflip' ? -1 : 1, 0, 0);
    const dur = type === 'roll' ? 0.8 : 0.95;
    this.trick = { type, axis, rate: TAU / dur, remaining: TAU };
    // jets give a hop; a smaller one on unpowered ramp jumps so the arc stays predictable
    this.vel.y = Math.max(this.vel.y, 0) + (this.armed ? 5 : 1.5);
    this.gas = Math.max(0, this.gas - 0.06);
    return true;
  }

  step(input, dt) {
    this.accum += dt;
    let n = 0;
    while (this.accum >= this.fixedDt && n < 10) {
      this.prevPos.copy(this.pos);
      this.prevQuat.copy(this.quat);
      this.substep(input, this.fixedDt);
      this.accum -= this.fixedDt;
      n++;
    }
    if (n === 10) this.accum = 0;
    const alpha = this.accum / this.fixedDt;
    this.renderPos.lerpVectors(this.prevPos, this.pos, alpha);
    this.renderQuat.slerpQuaternions(this.prevQuat, this.quat, alpha);
  }

  substep(inp, dt) {
    const m = this.mass;
    this.updateAxes();
    this.force.set(0, -G * m, 0);
    this.torque.set(0, 0, 0);

    const speedF = this.vel.dot(this.fwd);
    const speed = this.vel.length();
    const up = this.up;

    // --- steering (speed sensitive, calmer on walls)
    const onWall = this.grounded >= 2 && this.contactNormal.y < 0.6;
    const maxSteer = (0.56 / (1 + Math.abs(speedF) * 0.045)) * (onWall ? 0.35 : 1);
    this.steerAngle = inp.steer * maxSteer;

    // --- burnout / handbrake state
    const groundedPrev = this.grounded;
    this.burnout = groundedPrev >= 3 && inp.throttle > 0.5 && inp.brake > 0.5 && Math.abs(speedF) < 7 && !this.armed && !onWall;
    const handbrake = inp.handbrake && groundedPrev >= 2 && !this.burnout && inp.lift <= 0 && !onWall;

    // --- wheels (sphere-traced against the collision world)
    let grounded = 0;
    _avgN.set(0, 0, 0);
    const surfaces = {};
    // on near-vertical surfaces the tyres can't push much: momentum carries you up the wall
    const steepK = this.grounded >= 2 ? clamp(this.contactNormal.y * 1.6 - 0.45, 0.05, 1) : 1;
    const driveTotal = inp.throttle * Math.min(17000, 520000 / Math.max(Math.abs(speedF), 1)) * steepK;
    const maxLen = REST_LEN + CAR.tireR;
    _dir.copy(up).negate();
    for (const w of this.wheels) {
      const anchorW = _a.copy(w.anchor).applyQuaternion(this.quat).add(this.pos);
      w.steer = w.front ? this.steerAngle : 0;
      w.contact = false;
      w.load = 0;
      w.slip = 0;
      const t = this.world.raycast(anchorW, _dir, maxLen, _n);
      if (t === Infinity) {
        w.susp = Math.min(REST_LEN, w.susp + dt * 2);
        continue;
      }
      const comp = maxLen - t;
      w.susp = Math.max(0.02, t - CAR.tireR);
      w.contact = true;
      w.surface = this.world.hitId;
      surfaces[w.surface] = (surfaces[w.surface] || 0) + 1;
      grounded++;
      _avgN.add(_n);
      const cp = w.contactPoint.copy(anchorW).addScaledVector(_dir, t);

      // apply forces a little above the contact patch (less roll-over, more arcade stability)
      const ap = _b.copy(cp).addScaledVector(up, 0.12);
      this.pointVelocity(ap, _vp);
      const compRate = -_vp.dot(up);
      let fs = SPRING_K * comp + SPRING_C * compRate;
      if (comp > REST_LEN * 0.85) fs += 800000 * (comp - REST_LEN * 0.85);
      fs = Math.max(0, fs);
      w.load = fs;

      // tyre frame
      const cs = Math.cos(w.steer), sn = Math.sin(w.steer);
      _wf.copy(this.fwd).multiplyScalar(cs).addScaledVector(this.left, -sn);
      _wf.addScaledVector(_n, -_wf.dot(_n)).normalize();
      _wl.crossVectors(_n, _wf);
      const vf = _vp.dot(_wf), vl = _vp.dot(_wl);
      const maxF = MU * fs;

      // longitudinal
      let fx = 0;
      const split = w.front ? 0.2 : 0.3;
      if (this.burnout) {
        fx = w.front ? -clamp(vf / 0.3, -1, 1) * maxF : 0.16 * maxF;
      } else if (handbrake && !w.front) {
        fx = -clamp(vf / 0.5, -1, 1) * 0.7 * maxF;
      } else if (inp.brake > 0 && speedF > 0.8) {
        fx = -clamp(vf / 0.5, -1, 1) * inp.brake * 0.95 * maxF;
      } else if (inp.brake > 0) {
        fx = speedF > -14 ? -inp.brake * 7000 * split : 0;
      } else if (inp.throttle > 0) {
        fx = driveTotal * split;
      } else if (Math.abs(speedF) < 1 && !onWall) {
        fx = -clamp(vf / 0.3, -1, 1) * 0.5 * maxF; // auto-hold
      } else {
        fx = -Math.sign(vf) * 180 - vf * 25; // regen + rolling resistance
      }

      // lateral
      let latGrip = 1;
      if (this.burnout && !w.front) latGrip = 0.18;
      else if (handbrake && !w.front) latGrip = 0.38;
      const alpha = Math.atan2(vl, Math.max(Math.abs(vf), 1.5));
      const peak = 0.12;
      let fy = -clamp(alpha / peak, -1, 1) * maxF * latGrip;
      if (Math.abs(alpha) > peak) fy *= 1 - Math.min(0.25, (Math.abs(alpha) - peak) * 0.6);

      // friction circle
      const tot = Math.hypot(fx, fy);
      if (tot > maxF && tot > 0) {
        const s = maxF / tot;
        fx *= s;
        fy *= s;
      }
      w.slip = clamp((Math.abs(vl) - 2.5) / 6, 0, 1);
      if (this.burnout && !w.front) w.slip = 1;

      _f.copy(_n).multiplyScalar(fs).addScaledVector(_wf, fx).addScaledVector(_wl, fy);
      this.applyForceAt(_f, ap);

      // wheel spin (visual)
      if (this.burnout && !w.front) w.spinRate = 75;
      else if (handbrake && !w.front) w.spinRate = 0;
      else w.spinRate = vf / CAR.tireR;
    }
    this.grounded = grounded;
    for (const w of this.wheels) {
      if (!w.contact) w.spinRate *= 1 - dt * 0.4;
      w.spin += w.spinRate * dt;
    }
    let bestSurf = null, bestCount = 0;
    for (const k in surfaces) if (surfaces[k] > bestCount) { bestCount = surfaces[k]; bestSurf = k; }
    if (grounded > 0) this.contactNormal.copy(_avgN.normalize());

    // --- wall grip: the side thrusters press the car onto steep / inverted surfaces
    this.wallGrip = 0;
    if (grounded >= 2) {
      const ny = this.contactNormal.y;
      if (ny < 0.72) {
        const k = Math.min(1.7, (0.72 - ny) * 2.3);
        this.wallGrip = k;
        this.force.addScaledVector(this.contactNormal, -m * G * k);
      }
      // aero downforce along the surface normal
      this.force.addScaledVector(this.contactNormal, -speed * speed * 0.55);
    }

    if (this.burnout) {
      // pivot around the locked front axle for donuts
      this.torque.addScaledVector(up, -inp.steer * 17000);
    }

    // --- body collision probes
    let bodyContacts = 0;
    let impact = 0;
    for (const p of BODY_POINTS) {
      const pw = _a.copy(p).applyQuaternion(this.quat).add(this.pos);
      const d = this.world.sdf(pw, _n);
      if (d >= 0) continue;
      const pen = -d;
      bodyContacts++;
      if (!bestSurf) bestSurf = this.world.lastId;
      this.pointVelocity(pw, _vp);
      const vn = _vp.dot(_n);
      impact = Math.max(impact, -vn);
      const fn = Math.max(0, 200000 * pen - 14000 * vn);
      _d.copy(_vp).addScaledVector(_n, -vn);
      const vt = _d.length();
      _f.copy(_n).multiplyScalar(fn);
      if (vt > 1e-4) _f.addScaledVector(_d, -Math.min(0.35 * fn, vt * 9000) / vt);
      this.applyForceAt(_f, pw);
    }
    this.bodyContacts = bodyContacts;

    // --- flight state
    const touching = grounded > 0 || bodyContacts > 0;
    const alt = this.altitude;
    if (inp.lift > 0.1 && this.gas > 0.02) this.armed = true;
    if (this.armed && grounded >= 3 && inp.lift <= 0 && this.vel.y < 0.6) {
      this.landedTimer += dt;
      if (this.landedTimer > 0.35) this.armed = false;
    } else this.landedTimer = 0;

    // --- thrust (collective), limited by the player's thrust lever
    const leverIn = inp.thrustLevel ?? LEVER_DEFAULT;
    const lever = Number.isFinite(leverIn) ? clamp(leverIn, 0.25, 1) : LEVER_DEFAULT;
    this.thrustLevel = lever;
    const available = this.maxThrust * lever;
    let T = 0;
    if (this.armed && this.gas > 0) {
      const upY = Math.max(up.y, 0.25);
      if (inp.assist) {
        // altitude hold asks for what it needs; a low lever can't deliver it, so you sink
        let vyT = inp.lift > 0 ? inp.lift * 7 : inp.lift * 6.5;
        if (vyT < 0) vyT = Math.max(vyT, -1.2 - alt * 0.75); // auto-flare near the ground
        const aReq = G + 3.6 * (vyT - this.vel.y);
        T = (m * aReq) / upY;
        if (this.trick) T = up.y > 0.25 ? (m * G) / Math.max(up.y, 0.5) : 0;
      } else {
        // acro: original collective feel (hands-off ~1 g), capped by the lever below
        T = m * G * (1 + inp.lift * 1.3);
      }
      T = clamp(T, 0, available);
      if (this.pos.y > 42) T *= clamp((50 - this.pos.y) / 8, 0, 1);
      this.force.addScaledVector(up, T);
      this.gas = Math.max(0, this.gas - ((BASE_BURN + (1 - BASE_BURN) * (T / this.maxThrust)) * dt) / FULL_BURN_S);
      if (inp.assist) {
        // drone-style horizontal drag so tilting gives controllable speed
        this.force.x -= this.vel.x * m * 0.3;
        this.force.z -= this.vel.z * m * 0.3;
      }
      if (this.gas <= 0) {
        // tank dry: jets cut out and the car drops
        this.gas = 0;
        this.armed = false;
        this.landedTimer = 0;
      }
    } else if (this.armed) {
      // armed with an empty tank (e.g. a tank-less level): no thrust, disarm
      this.armed = false;
      this.landedTimer = 0;
    }
    // refuel only when parked: jets off, on all wheels, (almost) stopped
    if (!this.armed && grounded >= 3 && speed < 1.5) {
      const cap = this.tankCap();
      if (this.gas < cap) this.gas = Math.min(cap, this.gas + REFUEL_RATE * dt);
    }
    this.thrust = T / this.maxThrust;

    // --- attitude control (RCS)
    const flying = (this.armed && grounded < 3) || !touching;
    this.thrustCmd.set(0, 0, 0);
    if (this.trick) {
      const tr = this.trick;
      const axisW = _b.copy(tr.axis).applyQuaternion(this.quat);
      const wDes = _c.copy(axisW).multiplyScalar(tr.rate);
      const alpha = _d.subVectors(wDes, this.angVel).multiplyScalar(22);
      if (alpha.length() > 45) alpha.setLength(45);
      this.torque.add(this.torqueForAlpha(alpha, _f));
      tr.remaining -= Math.abs(this.angVel.dot(axisW)) * dt;
      this.thrustCmd.copy(tr.axis);
      if (tr.remaining <= 0.25 || (touching && tr.remaining < TAU - 0.5)) this.trick = null;
    } else if (flying) {
      const gain = this.armed ? 1 : 0.45;
      let wDes;
      if (inp.assist) {
        if (up.y > 0.5) this.heading = Math.atan2(this.fwd.x, this.fwd.z);
        const pitchT = inp.pitch * 0.6;
        const rollT = inp.roll * 0.55 + inp.steer * 0.3;
        _q.setFromAxisAngle(Y, this.heading);
        _euler.set(pitchT, 0, rollT, 'YXZ');
        _q2.setFromEuler(_euler);
        _q.multiply(_q2);
        // error rotation (world frame)
        _q2.copy(this.quat).invert();
        _q.multiply(_q2);
        if (_q.w < 0) { _q.x *= -1; _q.y *= -1; _q.z *= -1; _q.w *= -1; }
        const s = Math.sqrt(Math.max(1e-9, 1 - _q.w * _q.w));
        const ang = 2 * Math.acos(clamp(_q.w, -1, 1));
        wDes = _c.set(_q.x / s, _q.y / s, _q.z / s).multiplyScalar(ang * 6);
        wDes.addScaledVector(Y, -inp.steer * 1.9 * (this.armed ? 1 : 0.3));
      } else {
        wDes = _c.set(inp.pitch * 3.5, -inp.steer * 2.6, inp.roll * 4.2).applyQuaternion(this.quat);
      }
      const alpha = _d.subVectors(wDes, this.angVel).multiplyScalar(9 * gain);
      if (alpha.length() > 16) alpha.setLength(16);
      this.torque.add(this.torqueForAlpha(alpha, _f));
      _qi.copy(this.quat).invert();
      this.thrustCmd.copy(alpha).applyQuaternion(_qi).multiplyScalar(1 / 16);
    }

    // --- aero
    this.force.addScaledVector(this.vel, -speed * 0.42);

    // --- arena bounds
    const B = this.world.bounds;
    const push = (over, axis, sign) => {
      if (over <= 0) return;
      this.force[axis] -= sign * (over * 30000 + Math.max(0, sign * this.vel[axis]) * 6000);
    };
    push(this.pos.x - B.maxX, 'x', 1);
    push(B.minX - this.pos.x, 'x', -1);
    push(this.pos.z - B.maxZ, 'z', 1);
    push(B.minZ - this.pos.z, 'z', -1);

    // --- integrate
    this.vel.addScaledVector(this.force, dt / m);
    this.pos.addScaledVector(this.vel, dt);
    _qi.copy(this.quat).invert();
    _a.copy(this.torque).applyQuaternion(_qi);
    _a.set(_a.x / this.inertia.x, _a.y / this.inertia.y, _a.z / this.inertia.z).applyQuaternion(this.quat);
    this.angVel.addScaledVector(_a, dt);
    this.angVel.multiplyScalar(1 / (1 + dt * (touching ? 0.6 : 0.25)));
    const w = this.angVel;
    _q.set(w.x * 0.5 * dt, w.y * 0.5 * dt, w.z * 0.5 * dt, 0).multiply(this.quat);
    this.quat.x += _q.x; this.quat.y += _q.y; this.quat.z += _q.z; this.quat.w += _q.w;
    this.quat.normalize();

    // --- events: landing, impacts, leaving a surface
    this.airborne = !touching;
    if (this.airborne) this.airTime += dt;
    if (touching && this.wasAirborne && this.airTime > 0.35) {
      this.events.push({ type: 'land', vy: this.lastAirVy, upright: up.y, onWheels: grounded >= 2, airTime: this.airTime, surface: bestSurf });
    }
    if (!touching && !this.wasAirborne) {
      this.events.push({ type: 'leave', surface: this.surface, speed, y: this.pos.y, upY: up.y });
    }
    if (!touching) this.lastAirVy = this.vel.y;
    if (touching) {
      this.airTime = 0;
      this.surface = bestSurf || this.surface;
    }
    if (impact > 7 && bodyContacts > 0) this.events.push({ type: 'impact', speed: impact, surface: bestSurf });
    this.wasAirborne = !touching;
    this.brakeLight = (inp.brake > 0 && speedF > 0.5) || handbrake ? 1 : 0;
  }
}
