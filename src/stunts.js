import * as THREE from 'three';
import { CurveRamp, Box, arc, line, sampleProfile } from './colliders.js';
import { hdr, truss, instanced } from './environment.js';
import { loft, buildDisplayCar } from './car.js';
import { fbm, makePadTexture } from './textures.js';
import { profile } from './util.js';

// ------------------------------------------------------------------ layout (the stunt roadmap)
const WALL_R1 = 13, WALL_H = 16, WALL_R2 = 10, WALL_LIP = 0.5;
const LOOP_R = 10;
const KICK_R = 14, KICK_A = 0.42;

export const STUNTS = {
  truck: {
    name: 'TRUCK KICKFLIP',
    start: { x: 4, z: 50, heading: -Math.PI / 2 },
    kicker: { origin: new THREE.Vector3(-20, 0, 50), yaw: -Math.PI / 2, width: 6 },
    truck: { x: -52, z: 40.7 },
    over: { x: -52, z: 50, hx: 3, hz: 10, top: 4.6 },
    land: { x: -78, z: 50, r: 16 },
    shot: new THREE.Vector3(-96, 2.2, 64), // past the landing, looking back at the truck broadside
    cannons: [[-72, 36], [-72, 64], [-94, 42], [-94, 58]],
  },
  wall: {
    name: 'MEGA WALL',
    start: { x: 50, z: -20, heading: Math.PI / 2 },
    origin: new THREE.Vector3(86, 0, -20), yaw: Math.PI / 2, width: 9,
    top: WALL_R1 + WALL_H,
    land: { x: 70, z: -20, r: 10 },
    shot: new THREE.Vector3(60, 8, -54),
    cannons: [[60, -31], [60, -9], [80, -31], [80, -9]],
  },
  loop: {
    name: 'THE C-LOOP',
    start: { x: -80, z: 14, heading: Math.PI },
    origin: new THREE.Vector3(-80, 0, -42), yaw: Math.PI, width: 8,
    shot: new THREE.Vector3(-52, 4, -48),
    cannons: [[-71, -34], [-89, -34]],
  },
  finale: {
    name: 'DONUT FINALE',
    center: { x: 65, z: -44 }, r: 12,
    start: { x: 65, z: -27, heading: Math.PI },
    shot: new THREE.Vector3(65, 24, -30),
    cannons: [[52, -57], [78, -57], [51, -31], [79, -31]],
  },
};

const _v = new THREE.Vector3(), _n = new THREE.Vector3();

// ------------------------------------------------------------------ textures
function makeRampTexture() {
  const W = 256, H = 512;
  const n = fbm(512, 8, 5, 91);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let v = 168 + (n[y * 512 + x * 2] - 0.5) * 70 + (rand() - 0.5) * 18;
      const edge = Math.min(x, W - 1 - x);
      if (edge < 10) v *= 0.55 + edge * 0.04;
      if (Math.abs(x - W / 2) < 3.5) v = 236;
      img.data[i] = v * 0.97;
      img.data[i + 1] = v * 0.98;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // faint tyre streaks in the two wheel tracks, soft at both ends
  for (let k = 0; k < 8; k++) {
    const x = W / 2 + (k % 2 ? -1 : 1) * (52 + rand() * 14);
    const y0 = rand() * H, len = 120 + rand() * 260;
    const grd = g.createLinearGradient(0, y0, 0, y0 + len);
    const a = 0.035 + rand() * 0.04;
    grd.addColorStop(0, 'rgba(20,20,22,0)');
    grd.addColorStop(0.5, `rgba(20,20,22,${a})`);
    grd.addColorStop(1, 'rgba(20,20,22,0)');
    g.fillStyle = grd;
    g.fillRect(x - 7, y0, 14, len);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function makeStartTexture(label) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 1024, 18);
  g.fillRect(0, 238, 1024, 18);
  g.font = '700 130px Rajdhani, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 512, 132);
  for (const x of [90, 934]) {
    g.beginPath();
    g.moveTo(x - 40, 170);
    g.lineTo(x, 80);
    g.lineTo(x + 40, 170);
    g.lineWidth = 16;
    g.strokeStyle = '#fff';
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------ truck cab (semi)
const cabHW = profile([[0, 1.24], [2.7, 1.24], [3.25, 1.16], [3.5, 0.98]]);
const cabTop = profile([[0, 3.92], [1.5, 3.98], [2.15, 3.72], [2.85, 2.55], [3.25, 1.85], [3.5, 1.45]]);
function cabPoint(z, th, out) {
  let u = 0;
  if (z > 3.25) u = (z - 3.25) / 0.25;
  else if (z < 0.1) u = (0.1 - z) / 0.1;
  u = Math.min(u, 1);
  const cap = 1 - u * u;
  const hw = cabHW(z) * Math.pow(cap, 0.3);
  const yt = cabTop(z), yb = 0.95;
  const yc = yb + (yt - yb) * 0.5;
  const c = Math.cos(th), s = Math.sin(th);
  const ex = 2 / 6;
  const x = hw * Math.sign(c) * Math.pow(Math.abs(c), ex);
  const k = Math.pow(cap, 0.4);
  const y = s >= 0 ? yc + (yt - yc) * k * Math.pow(s, ex) : yc - (yc - yb) * k * Math.pow(-s, ex);
  return out.set(x, y, z);
}
function cabColor(p, z) {
  if (z > 2.0 && z < 3.02 && p.y > 2.2 && p.y < 3.78 && Math.abs(p.x) < 1.12) return 0.03; // windshield
  if (Math.abs(p.x) > 1.0 && p.y > 2.35 && p.y < 3.4 && z > 1.2 && z < 2.55) return 0.03; // side windows
  if (p.y < 1.2) return 0.1;
  return 1;
}

function buildSemi(mats, trailer, gold, car) {
  const g = new THREE.Group();
  const cab = new THREE.Mesh(loft(cabPoint, 0, 3.5, 70, 56, cabColor), mats.cabPaint);
  cab.castShadow = true;
  g.add(cab);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.045, 0.05), mats.whiteLed);
  bar.position.set(0, 1.72, 3.44);
  g.add(bar);
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.55, 7.2), mats.dark);
  chassis.position.set(0, 0.75, -0.2);
  g.add(chassis);
  const tireGeo = new THREE.CylinderGeometry(0.52, 0.52, 0.34, 28);
  tireGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.36, 20);
  hubGeo.rotateZ(Math.PI / 2);
  const wheel = (x, z, r = 1) => {
    const t = new THREE.Mesh(tireGeo, mats.tire);
    t.position.set(x, 0.52 * r, z);
    t.scale.setScalar(r);
    t.castShadow = true;
    const h = new THREE.Mesh(hubGeo, mats.metal);
    h.position.copy(t.position);
    h.scale.setScalar(r);
    g.add(t, h);
  };
  for (const z of [2.45, -2.0, -3.25]) for (const s of [-1, 1]) wheel(s * 1.02, z);
  if (trailer) {
    const neck = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.5, 2.6), mats.dark);
    neck.position.set(0, 1.45, -2.9);
    g.add(neck);
    const deckLo = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.25, 13), mats.steel);
    deckLo.position.set(0, 0.95, -10.3);
    deckLo.castShadow = deckLo.receiveShadow = true;
    const deckHi = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.18, 13), mats.steel);
    deckHi.position.set(0, 3.15, -10.3);
    deckHi.castShadow = true;
    g.add(deckLo, deckHi);
    for (const z of [-4.0, -10.3, -16.6]) {
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.2, 0.14), mats.steel);
        post.position.set(s * 1.24, 2.05, z);
        g.add(post);
      }
    }
    for (const y of [1.08, 3.25]) {
      for (const s of [-1, 1]) {
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.05, 13), mats.redLed);
        led.position.set(s * 1.31, y, -10.3);
        g.add(led);
      }
    }
    for (const z of [-13.6, -14.9, -16.2]) for (const s of [-1, 1]) wheel(s * 1.02, z, 0.86);
    // gold cars on both decks
    for (const [y, z] of [[1.08, -6.9], [1.08, -13.4], [3.24, -6.9], [3.24, -13.4]]) {
      const c = buildDisplayCar(car, gold);
      c.position.set(0, y, z);
      c.scale.setScalar(0.96);
      g.add(c);
    }
  }
  return g;
}

// ------------------------------------------------------------------ ramp visuals
function rampMeshes(ramp, mats, { leds = true } = {}) {
  const group = new THREE.Group();
  const pts = sampleProfile(ramp.segments, 0.35);
  const W = ramp.width, T = ramp.T;

  // riding surface ribbon (texture u across, v along arc length)
  const pos = [], nor = [], uv = [], idx = [];
  pts.forEach((q, i) => {
    for (const sw of [-1, 1]) {
      ramp.toWorld(q.u, q.y, (sw * W) / 2, _v);
      pos.push(_v.x, _v.y, _v.z);
      ramp.dirToWorld(q.nu, q.ny, 0, _n);
      nor.push(_n.x, _n.y, _n.z);
      uv.push(sw < 0 ? 0 : 1, q.s / 8);
    }
    if (i < pts.length - 1) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  });
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  rg.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  rg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  rg.setIndex(idx);
  const ride = new THREE.Mesh(rg, mats.concrete);
  ride.receiveShadow = true;
  ride.castShadow = true;
  group.add(ride);

  // solid shell behind the surface
  const shape = new THREE.Shape();
  pts.forEach((q, i) => {
    const u = q.u - q.nu * 0.03, y = q.y - q.ny * 0.03;
    if (i === 0) shape.moveTo(u, y);
    else shape.lineTo(u, y);
  });
  for (let i = pts.length - 1; i >= 0; i--) shape.lineTo(pts[i].u - pts[i].nu * T, pts[i].y - pts[i].ny * T);
  const sg = new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: false, curveSegments: 1, steps: 1 });
  const nw = ramp.w.clone().negate();
  const m = new THREE.Matrix4().makeBasis(ramp.a, new THREE.Vector3(0, 1, 0), nw);
  m.setPosition(ramp.origin.clone().addScaledVector(ramp.w, W / 2));
  sg.applyMatrix4(m);
  const shell = new THREE.Mesh(sg, mats.shell);
  shell.castShadow = true;
  group.add(shell);

  // LED edges
  if (leds) {
    for (const sw of [-1, 1]) {
      const cpts = pts.filter((_, i) => i % 2 === 0).map((q) => ramp.toWorld(q.u + q.nu * 0.05, q.y + q.ny * 0.05, sw * (W / 2 - 0.08), new THREE.Vector3()));
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(cpts), cpts.length * 2, 0.06, 6), mats.redLed);
      group.add(tube);
    }
  }
  return { group, pts };
}

// ------------------------------------------------------------------ the park
export class StuntPark {
  constructor(scene, world, car, glowTex) {
    this.scene = scene;
    this.world = world;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.time = 0;
    this.active = null;

    const rampTex = makeRampTexture();
    this.mats = {
      concrete: new THREE.MeshStandardMaterial({ map: rampTex, color: 0xc4c7cc, roughness: 0.78, metalness: 0.04, side: THREE.DoubleSide }),
      shell: new THREE.MeshStandardMaterial({ color: 0x24272d, roughness: 0.55, metalness: 0.45, side: THREE.DoubleSide }),
      redLed: new THREE.MeshBasicMaterial({ color: hdr(5, 0.08, 0.14) }),
      whiteLed: new THREE.MeshBasicMaterial({ color: hdr(6, 6, 6.4) }),
      truss: new THREE.MeshStandardMaterial({ color: 0x4a4f58, metalness: 0.85, roughness: 0.35 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 0.7, metalness: 0.3 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x5a5f68, roughness: 0.4, metalness: 0.85 }),
      metal: new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.25, metalness: 0.95 }),
      tire: new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.85 }),
      cabPaint: new THREE.MeshPhysicalMaterial({ color: 0xeef0f3, roughness: 0.3, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05, vertexColors: true }),
      gold: new THREE.MeshPhysicalMaterial({ color: 0xc9a062, roughness: 0.26, metalness: 0.9, clearcoat: 1, clearcoatRoughness: 0.05, vertexColors: true }),
      laser: new THREE.MeshBasicMaterial({ color: hdr(2.2, 2.4, 2.8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    };
    this.glowTex = glowTex;
    const bars = [];

    this.buildKickerAndTruck(car, bars);
    this.buildWall(bars);
    this.buildLoop(bars);
    this.buildFinale(car);
    this.buildStarts();
    this.root.add(instanced(new THREE.BoxGeometry(1, 1, 1), this.mats.truss, bars));
  }

  // ---- 1. kicker + semi truck with car carrier
  buildKickerAndTruck(car, bars) {
    const S = STUNTS.truck;
    const k = S.kicker;
    this.kicker = this.world.add(new CurveRamp({
      id: 'kicker', origin: k.origin, yaw: k.yaw, width: k.width, thickness: 2,
      segments: [arc(0, KICK_R, KICK_R, -Math.PI / 2, -Math.PI / 2 + KICK_A)],
    }));
    const { group } = rampMeshes(this.kicker, this.mats);
    this.root.add(group);
    // solid wedge under the kicker
    const end = sampleProfile(this.kicker.segments, 0.5);
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    end.forEach((q) => shape.lineTo(q.u, q.y - 0.02));
    shape.lineTo(end[end.length - 1].u, 0);
    const wg = new THREE.ExtrudeGeometry(shape, { depth: k.width, bevelEnabled: false });
    const m = new THREE.Matrix4().makeBasis(this.kicker.a, new THREE.Vector3(0, 1, 0), this.kicker.w.clone().negate());
    m.setPosition(k.origin.clone().addScaledVector(this.kicker.w, k.width / 2));
    wg.applyMatrix4(m);
    this.root.add(new THREE.Mesh(wg, this.mats.shell));

    const truck = buildSemi(this.mats, true, this.mats.gold, car);
    truck.position.set(S.truck.x, 0, S.truck.z);
    truck.rotation.y = Math.PI;
    this.root.add(truck);
    // colliders: trailer + load, cab
    this.world.add(new Box({ id: 'truck', center: new THREE.Vector3(S.truck.x, 2.25, S.truck.z + 10.3), half: new THREE.Vector3(1.35, 2.25, 7.4) }));
    this.world.add(new Box({ id: 'truck', center: new THREE.Vector3(S.truck.x, 2.0, S.truck.z - 1.4), half: new THREE.Vector3(1.3, 2.0, 2.4) }));

    this.landPad(S.land.x, S.land.z, 9);
    this.floodlight(new THREE.Vector3(-30, 0, 26), new THREE.Vector3(-52, 2, 50), 5200);
    this.cannonMeshes(S.cannons);
  }

  // ---- 2. Mega Wall
  buildWall(bars) {
    const S = STUNTS.wall;
    this.wall = this.world.add(new CurveRamp({
      id: 'megawall', origin: S.origin, yaw: S.yaw, width: S.width, thickness: 1.2,
      segments: [
        arc(0, WALL_R1, WALL_R1, -Math.PI / 2, 0),
        line(WALL_R1, WALL_R1, WALL_R1, WALL_R1 + WALL_H, -1, 0),
        arc(WALL_R1 - WALL_R2, WALL_R1 + WALL_H, WALL_R2, 0, WALL_LIP),
      ],
    }));
    const { group, pts } = rampMeshes(this.wall, this.mats);
    this.root.add(group);
    // steel tower behind the wall
    const r = this.wall;
    const uCol = WALL_R1 + 2.6;
    const top = WALL_R1 + WALL_H + 4;
    const wp = (u, y, w) => r.toWorld(u, y, w, new THREE.Vector3());
    for (const sw of [-1, 1]) {
      const w = sw * (S.width / 2 - 0.7);
      truss(bars, wp(uCol, 0, w), wp(uCol, top, w), 1.1, 0.07);
      truss(bars, wp(uCol + 6, 0, w), wp(uCol, top * 0.7, w), 0.8, 0.06);
      for (let i = 0; i < pts.length; i += 6) {
        const q = pts[i];
        if (q.y < 1.5) continue;
        const bu = q.u - q.nu * 1.2, by = q.y - q.ny * 1.2;
        if (bu > uCol - 0.3) continue;
        truss(bars, wp(bu, by, w), wp(uCol, by, w), 0.45, 0.05);
      }
    }
    for (const y of [6, 14, 22, top - 0.5]) truss(bars, wp(uCol, y, -S.width / 2 + 0.7), wp(uCol, y, S.width / 2 - 0.7), 0.8, 0.06);
    // lights on the wall
    const spot = new THREE.SpotLight(0xe8eeff, 4200, 110, 0.32, 0.6, 2);
    spot.position.set(52, 22, 4);
    spot.target.position.set(95, 14, -20);
    this.root.add(spot, spot.target);
    this.floodlight(new THREE.Vector3(56, 0, -46), new THREE.Vector3(92, 12, -20), 6500);
    this.landPad(S.land.x, S.land.z, S.land.r);
    this.cannonMeshes(S.cannons);
  }

  // ---- 3. C-Loop
  buildLoop(bars) {
    const S = STUNTS.loop;
    this.loop = this.world.add(new CurveRamp({
      id: 'cloop', origin: S.origin, yaw: S.yaw, width: S.width, thickness: 1,
      segments: [arc(0, LOOP_R, LOOP_R, -Math.PI / 2, Math.PI / 2)],
    }));
    const { group, pts } = rampMeshes(this.loop, this.mats);
    this.root.add(group);
    const r = this.loop;
    const wp = (u, y, w) => r.toWorld(u, y, w, new THREE.Vector3());
    const uCol = LOOP_R + 3;
    const top = LOOP_R * 2 + 3;
    for (const sw of [-1, 1]) {
      const w = sw * (S.width / 2 - 0.6);
      truss(bars, wp(uCol, 0, w), wp(uCol, top, w), 1.0, 0.07);
      truss(bars, wp(uCol, top, w), wp(-2, top, w), 0.8, 0.06); // canopy over the inverted section
      for (let i = 0; i < pts.length; i += 5) {
        const q = pts[i];
        if (q.y < 1) continue;
        const bu = q.u - q.nu * 1.0, by = q.y - q.ny * 1.0;
        if (q.y > LOOP_R + 1) truss(bars, wp(bu, by, w), wp(bu, top, w), 0.4, 0.045);
        else if (bu < uCol - 0.3) truss(bars, wp(bu, by, w), wp(uCol, by, w), 0.4, 0.045);
      }
    }
    for (const y of [5, 11, top]) truss(bars, wp(uCol, y, -S.width / 2 + 0.6), wp(uCol, y, S.width / 2 - 0.6), 0.7, 0.06);
    const spot = new THREE.SpotLight(0xe8eeff, 3000, 90, 0.42, 0.6, 2);
    spot.position.set(-60, 20, -24);
    spot.target.position.set(-80, 7, -46);
    this.root.add(spot, spot.target);
    this.cannonMeshes(S.cannons);
  }

  // ---- 4. showcase lineup + laser grid finale
  buildFinale(car) {
    const F = STUNTS.finale;
    const cab = buildSemi(this.mats, false, null, car);
    cab.position.set(F.center.x, 0, -64.5);
    this.root.add(cab);
    this.world.add(new Box({ id: 'lineup', center: new THREE.Vector3(F.center.x, 2.0, -64.5 + 1.0), half: new THREE.Vector3(1.3, 2.0, 3.6) }));
    for (const dx of [-9, 9]) {
      const c = buildDisplayCar(car, null);
      c.position.set(F.center.x + dx, 0, -63.5);
      this.root.add(c);
      this.world.add(new Box({ id: 'lineup', center: new THREE.Vector3(F.center.x + dx, 0.6, -63.5), half: new THREE.Vector3(1.0, 0.6, 2.2) }));
    }
    const strip = new THREE.Mesh(new THREE.BoxGeometry(34, 0.04, 0.14), this.mats.redLed);
    strip.position.set(F.center.x, 0.03, -59.2);
    const strip2 = strip.clone();
    strip2.position.z = -67.8;
    this.root.add(strip, strip2);

    // laser grid on the floor
    this.grid = new THREE.Group();
    this.grid.position.set(F.center.x, 0.02, F.center.z);
    const lineGeo = new THREE.PlaneGeometry(0.07, F.r * 2.4);
    lineGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const l = new THREE.Mesh(lineGeo, this.mats.laser);
      l.rotation.y = (i / 4) * Math.PI + 0.3;
      l.renderOrder = 2;
      this.grid.add(l);
    }
    const ring = new THREE.Mesh(new THREE.RingGeometry(F.r - 0.06, F.r, 128), this.mats.laser);
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = 2;
    this.grid.add(ring);
    this.root.add(this.grid);
    this.floodlight(new THREE.Vector3(40, 0, -66), new THREE.Vector3(65, 0, -44), 4200);
    this.cannonMeshes(F.cannons);
  }

  buildStarts() {
    const make = (s, label) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(7, 1.75), new THREE.MeshBasicMaterial({ map: makeStartTexture(label), color: hdr(0.9, 0.95, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      m.rotation.set(-Math.PI / 2, 0, 0);
      m.rotation.order = 'YXZ';
      m.rotation.y = s.heading + Math.PI;
      m.position.set(s.x + Math.sin(s.heading) * 3.5, 0.015, s.z + Math.cos(s.heading) * 3.5);
      m.renderOrder = 1;
      this.root.add(m);
    };
    make(STUNTS.truck.start, 'TRUCK JUMP');
    make(STUNTS.wall.start, 'MEGA WALL');
    make(STUNTS.loop.start, 'C-LOOP');
  }

  // ---- props
  landPad(x, z, r) {
    if (!this.padTex) this.padTex = makePadTexture();
    const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 2.3, r * 2.3), new THREE.MeshBasicMaterial({ map: this.padTex, color: hdr(0.35, 0.45, 0.9), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.013, z);
    m.renderOrder = 1;
    this.root.add(m);
  }

  cannonMeshes(list) {
    if (!this.cannonGeo) {
      this.cannonGeo = new THREE.BoxGeometry(0.7, 0.5, 0.7);
      this.nozzleGeo = new THREE.CylinderGeometry(0.12, 0.16, 0.5, 12);
    }
    for (const [x, z] of list) {
      const b = new THREE.Mesh(this.cannonGeo, this.mats.dark);
      b.position.set(x, 0.25, z);
      const n = new THREE.Mesh(this.nozzleGeo, this.mats.steel);
      n.position.set(x, 0.7, z);
      this.root.add(b, n);
    }
  }

  floodlight(base, target, intensity) {
    const H = 18;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, H, 12), this.mats.steel);
    pole.position.set(base.x, H / 2, base.z);
    this.root.add(pole);
    const head = new THREE.Group();
    head.position.set(base.x, H + 0.6, base.z);
    head.lookAt(target);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.2, 0.35), this.mats.dark);
    head.add(frame);
    const lampGeo = new THREE.CircleGeometry(0.28, 20);
    const lampMat = new THREE.MeshBasicMaterial({ color: hdr(9, 10, 9.6) });
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        const l = new THREE.Mesh(lampGeo, lampMat);
        l.position.set(-1.2 + i * 0.8, -0.65 + j * 0.65, 0.19);
        head.add(l);
      }
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: hdr(1.3, 1.6, 1.55), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.set(11, 11, 1);
    glow.position.z = 0.6;
    head.add(glow);
    this.root.add(head);
    head.updateMatrixWorld();
    // glare is only visible from in front of the lamps
    this.glares = this.glares || [];
    this.glares.push({ mat: glow.material, pos: head.position.clone(), dir: new THREE.Vector3(0, 0, 1).applyQuaternion(head.quaternion) });
    const spot = new THREE.SpotLight(0xdffff6, intensity, 150, 0.5, 0.65, 2);
    spot.position.copy(head.position);
    spot.target.position.copy(target);
    this.root.add(spot, spot.target);
  }

  // ---- queries used by the game
  overTruck(p) {
    const o = STUNTS.truck.over;
    return Math.abs(p.x - o.x) < o.hx && Math.abs(p.z - o.z) < o.hz && p.y > o.top;
  }

  inZone(name, p) {
    if (name === 'finale') {
      const F = STUNTS.finale;
      return Math.hypot(p.x - F.center.x, p.z - F.center.z) < F.r;
    }
    const L = STUNTS[name].land;
    return Math.hypot(p.x - L.x, p.z - L.z) < L.r;
  }

  cannonsFor(name) {
    return STUNTS[name].cannons;
  }

  setActive(name) {
    this.active = name;
  }

  update(dt, beat, camera) {
    this.time += dt;
    if (camera) {
      for (const g of this.glares) {
        const f = _v.subVectors(camera.position, g.pos).normalize().dot(g.dir);
        g.mat.opacity = Math.max(0, Math.min(1, (f - 0.05) * 1.6));
      }
    }
    const pulse = Math.pow(1 - (beat ?? 0), 2);
    this.grid.rotation.y += dt * (this.active === 'finale' ? 0.5 : 0.12);
    const k = this.active === 'finale' ? 1.6 + pulse * 1.4 : 0.9 + pulse * 0.4;
    this.mats.laser.color.setRGB(2.2 * k, 2.4 * k, 2.8 * k);
    const r = 4 + pulse * 2.5;
    this.mats.redLed.color.setRGB(r, 0.06 * r / 4, 0.12 * r / 4);
  }
}
