// Headless copy of the game's collision world: same arena height field, same stunt colliders,
// no renderer. Everything here mirrors src/main.js + src/stunts.js so a flight flown in this
// simulator replays identically in the browser game.
import * as THREE from 'three';
import { World, CurveRamp, Box, arc, line } from '../../src/colliders.js';
import { Arena, LAYOUT } from '../../src/environment.js';
import { STUNTS } from '../../src/stunts.js';

// private constants of src/stunts.js (keep in sync)
const WALL_R1 = 13, WALL_H = 16, WALL_R2 = 10, WALL_LIP = 0.5;
const LOOP_R = 10;
const KICK_R = 14, KICK_A = 0.42;

export function buildWorld() {
  // Arena.height / normal only read LAYOUT, so the game's own functions run without a renderer
  const arena = { bounds: LAYOUT.bounds, height: Arena.prototype.height, normal: Arena.prototype.normal };
  const world = new World(arena);
  world.add(new Box({ id: 'backdrop', center: new THREE.Vector3(LAYOUT.stage.x, 8, LAYOUT.stage.z - 17), half: new THREE.Vector3(24, 8, 0.5) }));

  const T = STUNTS.truck;
  world.add(new CurveRamp({
    id: 'kicker', origin: T.kicker.origin, yaw: T.kicker.yaw, width: T.kicker.width, thickness: 2,
    segments: [arc(0, KICK_R, KICK_R, -Math.PI / 2, -Math.PI / 2 + KICK_A)],
  }));
  world.add(new Box({ id: 'truck', center: new THREE.Vector3(T.truck.x, 2.25, T.truck.z + 10.3), half: new THREE.Vector3(1.35, 2.25, 7.4) }));
  world.add(new Box({ id: 'truck', center: new THREE.Vector3(T.truck.x, 2.0, T.truck.z - 1.4), half: new THREE.Vector3(1.3, 2.0, 2.4) }));

  const W = STUNTS.wall;
  world.add(new CurveRamp({
    id: 'megawall', origin: W.origin, yaw: W.yaw, width: W.width, thickness: 1.2,
    segments: [
      arc(0, WALL_R1, WALL_R1, -Math.PI / 2, 0),
      line(WALL_R1, WALL_R1, WALL_R1, WALL_R1 + WALL_H, -1, 0),
      arc(WALL_R1 - WALL_R2, WALL_R1 + WALL_H, WALL_R2, 0, WALL_LIP),
    ],
  }));

  const L = STUNTS.loop;
  world.add(new CurveRamp({
    id: 'cloop', origin: L.origin, yaw: L.yaw, width: L.width, thickness: 1,
    segments: [arc(0, LOOP_R, LOOP_R, -Math.PI / 2, Math.PI / 2)],
  }));

  const F = STUNTS.finale;
  world.add(new Box({ id: 'lineup', center: new THREE.Vector3(F.center.x, 2.0, -64.5 + 1.0), half: new THREE.Vector3(1.3, 2.0, 3.6) }));
  for (const dx of [-9, 9]) {
    world.add(new Box({ id: 'lineup', center: new THREE.Vector3(F.center.x + dx, 0.6, -63.5), half: new THREE.Vector3(1.0, 0.6, 2.2) }));
  }
  return world;
}

// Flight rings, same geometry and pass test as FlightRing in src/environment.js
export const RINGS = LAYOUT.rings.map((d) => ({
  pos: new THREE.Vector3(...d.p),
  normal: new THREE.Vector3(...d.n).normalize(),
  radius: 5.5,
}));

const _p = new THREE.Vector3(), _s = new THREE.Vector3();
export function ringPass(ring, a, b) {
  const d0 = _p.subVectors(a, ring.pos).dot(ring.normal);
  const d1 = _s.subVectors(b, ring.pos).dot(ring.normal);
  if (d0 * d1 > 0 || d0 === d1) return false;
  const t = d0 / (d0 - d1);
  const hit = _p.copy(a).lerp(b, t);
  return hit.distanceTo(ring.pos) < ring.radius - 0.2;
}

export { LAYOUT, STUNTS };
