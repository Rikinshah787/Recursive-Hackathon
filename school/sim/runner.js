// Runs one flight: a controller program drives the game's real Vehicle physics in the headless
// world. Produces a trace (what happened, for graders / spec checks / agents) and a replay
// (commands + keyframes, for the 3D viewer).
import * as THREE from 'three';
import { Vehicle } from '../../src/physics.js';
import { buildWorld, RINGS, ringPass } from './world.js';

const TAU = Math.PI * 2;
const CTRL_HZ = 60; // controller is called every 2 physics substeps (physics runs at 120 Hz)
const SUB = 2;
const KEY_EVERY = 6; // keyframe every 6 substeps (20 Hz) for the replay viewer
const SAMPLE_EVERY = 12; // trace sample every 12 substeps (10 Hz)
const TRICKS = new Set(['flip', 'backflip', 'roll']);

const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// sanitize whatever the controller returned into the exact input the physics reads
export function toInput(cmd) {
  const c = cmd && typeof cmd === 'object' ? cmd : {};
  return {
    throttle: r3(clamp(num(c.throttle), 0, 1)),
    brake: r3(clamp(num(c.brake), 0, 1)),
    steer: r3(clamp(num(c.steer), -1, 1)),
    lift: r3(clamp(num(c.lift), -1, 1)),
    pitch: r3(clamp(num(c.pitch), -1, 1)),
    roll: r3(clamp(num(c.roll), -1, 1)),
    handbrake: !!c.handbrake,
    thrustLevel: r3(clamp(num(c.thrustLevel, 0.6), 0.25, 1)),
    assist: c.assist !== false,
    trick: TRICKS.has(c.trick) ? c.trick : null,
  };
}

const _q = new THREE.Quaternion(), _w = new THREE.Vector3(), _prev = new THREE.Vector3();

function observe(v, t, events) {
  const fwd = v.fwd, up = v.up, left = v.left;
  return {
    t: r3(t),
    pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z },
    vel: { x: v.vel.x, y: v.vel.y, z: v.vel.z },
    speed: v.vel.length(),
    forwardSpeed: v.vel.dot(fwd),
    heading: Math.atan2(fwd.x, fwd.z),
    pitch: Math.asin(clamp(fwd.y, -1, 1)), // + = nose up
    bank: Math.asin(clamp(left.y, -1, 1)),
    up: { x: up.x, y: up.y, z: up.z },
    upY: up.y,
    altitude: v.altitude,
    airborne: v.airborne,
    wheelsOnGround: v.grounded,
    armed: v.armed,
    gas: v.gas,
    trickActive: !!v.trick,
    surface: v.surface,
    wallGrip: v.wallGrip,
    events,
  };
}

/**
 * @param {object} o
 * @param {object} o.task       task from tasks.js (start, fuel, maxT)
 * @param {Function} o.control  (obs, mem) => command; called at 60 Hz
 * @param {number} [o.maxT]
 */
export function runFlight({ task, control, maxT = task.maxT || 20 }) {
  const world = buildWorld();
  const v = new Vehicle(world);
  v.gasCap = task.fuel ?? 1;
  v.reset(new THREE.Vector3(task.start.x, 0, task.start.z), task.start.heading);

  const mem = {}; // controller scratch memory, persists between calls
  const samples = [], events = [], flights = [], rings = [], keys = [], tape = [];
  let cmd = toInput(null), ctrlError = null, crashed = null, crashT = null;
  let flight = null, upsideTimer = 0, step = 0, pendingEvents = [];
  const acc = { pitch: 0, roll: 0, yaw: 0 };
  let maxY = v.pos.y, maxAlt = 0, maxSpeed = 0;
  const fixedDt = v.fixedDt;
  const nSteps = Math.round(maxT / fixedDt);

  const ev = (e) => {
    const out = { t: r2(step * fixedDt), ...e };
    events.push(out);
    pendingEvents.push(out);
  };
  const crash = (reason) => {
    if (crashed) return;
    crashed = reason;
    crashT = step * fixedDt;
    ev({ type: 'crash', reason, x: r2(v.pos.x), y: r2(v.pos.y), z: r2(v.pos.z) });
  };

  for (step = 0; step < nSteps; step++) {
    const t = step * fixedDt;
    // --- controller tick
    if (step % SUB === 0) {
      const obs = observe(v, t, pendingEvents);
      pendingEvents = [];
      let raw = null;
      if (!ctrlError && !crashed) {
        try {
          raw = control(obs, mem);
        } catch (err) {
          ctrlError = { t: r2(t), message: String(err && err.message || err).slice(0, 300) };
        }
      }
      cmd = crashed ? toInput(null) : toInput(raw);
      tape.push(cmd);
      if (cmd.trick && !v.trick) {
        const ok = v.startTrick(cmd.trick);
        if (ok) ev({ type: 'trick', trick: cmd.trick, x: r2(v.pos.x), y: r2(v.pos.y), z: r2(v.pos.z), alt: r2(v.altitude) });
      }
    }
    if (step % KEY_EVERY === 0) {
      keys.push([step, ...[v.pos.x, v.pos.y, v.pos.z, v.quat.x, v.quat.y, v.quat.z, v.quat.w, v.vel.x, v.vel.y, v.vel.z, v.angVel.x, v.angVel.y, v.angVel.z].map((n) => Math.round(n * 1e5) / 1e5), Math.round(v.gas * 1e5) / 1e5]);
    }

    _prev.copy(v.pos);
    v.events.length = 0;
    v.prevPos.copy(v.pos);
    v.prevQuat.copy(v.quat);
    v.substep(cmd, fixedDt);
    const tNow = (step + 1) * fixedDt;

    // --- referee: same rules as the game (src/game.js)
    for (const e of v.events) {
      if (e.type === 'leave') {
        ev({ type: 'leave', surface: e.surface, speed: r2(e.speed), y: r2(e.y) });
      } else if (e.type === 'land') {
        const vy = Math.abs(e.vy || 0);
        const ramp = e.surface === 'cloop' || e.surface === 'megawall';
        const bad = e.upright < 0.55 || (!e.onWheels && vy > 6) || vy > 16;
        ev({ type: 'land', surface: e.surface, upright: r2(e.upright), onWheels: e.onWheels, vy: r2(vy), airTime: r2(e.airTime), x: r2(v.pos.x), z: r2(v.pos.z) });
        if (bad && !ramp) crash(vy > 16 ? 'BOTTOMED OUT' : e.upright < 0.55 ? 'LANDED UPSIDE DOWN' : 'LANDED ON ITS SIDE');
      } else if (e.type === 'impact') {
        const ramp = e.surface === 'megawall' || e.surface === 'cloop' || e.surface === 'kicker';
        if (e.surface === 'truck' && e.speed > 6) crash('HIT THE TRUCK');
        else if (!ramp && (e.speed > 15 || (e.speed > 11 && v.up.y < 0.4))) crash(`HIT ${String(e.surface || 'ground').toUpperCase()} AT ${e.speed.toFixed(1)} M/S`);
      }
    }
    const touching = !v.airborne;
    if (touching && v.up.y < 0.25 && v.surface !== 'cloop' && v.surface !== 'megawall') {
      upsideTimer += fixedDt;
      if (upsideTimer > 1.4) crash('ROLLED OVER');
    } else upsideTimer = 0;

    // rings
    RINGS.forEach((r, i) => {
      if (ringPass(r, _prev, v.pos)) {
        const last = rings.filter((x) => x.ring === i).pop();
        if (!last || tNow - last.t > 2) {
          rings.push({ ring: i, t: r2(tNow) });
          ev({ type: 'ring', ring: i });
        }
      }
    });

    // air segments + rotation accounting (body-frame angular velocity, like the game)
    if (!touching) {
      if (!flight) {
        flight = { t0: r2(tNow), from: v.surface, start: { x: r2(v.pos.x), y: r2(v.pos.y), z: r2(v.pos.z) }, maxY: v.pos.y, maxAlt: v.altitude, pitchDeg: 0, rollDeg: 0, yawDeg: 0, tricks: [], overTruck: false, minTruckClearance: Infinity };
        acc.pitch = acc.roll = acc.yaw = 0;
      }
      _q.copy(v.quat).invert();
      _w.copy(v.angVel).applyQuaternion(_q);
      flight.pitchDeg += (_w.x * fixedDt * 180) / Math.PI;
      flight.rollDeg += (_w.z * fixedDt * 180) / Math.PI;
      flight.yawDeg += (_w.y * fixedDt * 180) / Math.PI;
      acc.pitch += _w.x * fixedDt;
      acc.roll += _w.z * fixedDt;
      const full = TAU * 0.86;
      if (Math.abs(acc.pitch) > full) {
        flight.tricks.push(acc.pitch > 0 ? 'FRONT FLIP' : 'BACKFLIP');
        acc.pitch -= Math.sign(acc.pitch) * TAU;
      }
      if (Math.abs(acc.roll) > full) {
        flight.tricks.push('BARREL ROLL');
        acc.roll -= Math.sign(acc.roll) * TAU;
      }
      flight.maxY = Math.max(flight.maxY, v.pos.y);
      flight.maxAlt = Math.max(flight.maxAlt, v.altitude);
      // over the truck trailer footprint (x -53.35..-50.65, z 43.6..58.4, top 4.5 m)
      if (v.pos.x > -54.5 && v.pos.x < -49.5 && v.pos.z > 42.5 && v.pos.z < 59.5) {
        flight.overTruck = true;
        flight.minTruckClearance = Math.min(flight.minTruckClearance, v.pos.y - 0.45 - 4.5);
      }
    } else if (flight) {
      const dur = tNow - flight.t0;
      if (dur > 0.3) {
        const land = events.filter((e) => e.type === 'land').pop();
        flights.push({
          ...flight,
          t1: r2(tNow),
          duration: r2(dur),
          maxY: r2(flight.maxY), maxAlt: r2(flight.maxAlt),
          pitchDeg: Math.round(flight.pitchDeg), rollDeg: Math.round(flight.rollDeg), yawDeg: Math.round(flight.yawDeg),
          minTruckClearance: Number.isFinite(flight.minTruckClearance) ? r2(flight.minTruckClearance) : null,
          end: { x: r2(v.pos.x), y: r2(v.pos.y), z: r2(v.pos.z) },
          landSurface: v.surface,
          landUpright: r2(v.up.y),
          landVy: land && Math.abs(land.t - tNow) < 0.05 ? land.vy : null,
          crashedOnLanding: !!crashed && Math.abs(crashT - tNow) < 0.1,
        });
      }
      flight = null;
    }

    maxY = Math.max(maxY, v.pos.y);
    maxAlt = Math.max(maxAlt, v.altitude);
    maxSpeed = Math.max(maxSpeed, v.vel.length());
    if ((step + 1) % SAMPLE_EVERY === 0) {
      samples.push({
        t: r2(tNow), x: r2(v.pos.x), y: r2(v.pos.y), z: r2(v.pos.z),
        vx: r2(v.vel.x), vy: r2(v.vel.y), vz: r2(v.vel.z), speed: r2(v.vel.length()),
        heading: r2(Math.atan2(v.fwd.x, v.fwd.z)), alt: r2(v.altitude), upY: r2(v.up.y),
        airborne: v.airborne, wheels: v.grounded, armed: v.armed, gas: r2(v.gas), surface: v.surface,
        cmd: { th: cmd.throttle, br: cmd.brake, st: cmd.steer, li: cmd.lift, pi: cmd.pitch, ro: cmd.roll },
      });
    }
    // a crash ends the flight a moment later (the game respawns you)
    if (crashed && tNow - crashT > 1.0) {
      step++;
      break;
    }
  }

  const duration = r2(step * fixedDt);
  const trace = {
    task: task.id,
    duration,
    crashed: !!crashed,
    crashReason: crashed,
    controllerError: ctrlError,
    samples,
    events,
    flights,
    rings,
    maxY: r2(maxY),
    maxAlt: r2(maxAlt),
    maxSpeed: r2(maxSpeed),
    final: {
      t: duration,
      x: r2(v.pos.x), y: r2(v.pos.y), z: r2(v.pos.z),
      speed: r2(v.vel.length()), upY: r2(v.up.y), alt: r2(v.altitude), wheels: v.grounded,
      airborne: v.airborne, armed: v.armed, gas: r2(v.gas), surface: v.surface,
      heading: r2(Math.atan2(v.fwd.x, v.fwd.z)),
    },
  };
  const replay = {
    v: 1,
    task: task.id,
    start: task.start,
    fuel: task.fuel ?? 1,
    fixedDt,
    sub: SUB,
    keyEvery: KEY_EVERY,
    steps: step,
    tape: tape.map((c) => [c.throttle, c.brake, c.steer, c.lift, c.pitch, c.roll, c.handbrake ? 1 : 0, c.thrustLevel, c.assist ? 1 : 0, c.trick || 0]),
    keys,
  };
  return { trace, replay };
}
