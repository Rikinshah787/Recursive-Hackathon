import * as THREE from 'three';
import { profile } from './util.js';
import { makeWheelTexture } from './textures.js';

// Car coordinates: +Z forward, +Y up, +X left. Meshes are modelled with the ground at y = 0
// and placed under an `inner` group shifted down by the centre-of-mass height.
export const CAR = {
  comY: 0.5,
  tireR: 0.335,
  wheelZ: 1.33,
  trackHalf: 0.83,
  // thruster nozzles (ground coords)
  nozzles: [
    new THREE.Vector3(0.42, 0.13, 0.98),
    new THREE.Vector3(-0.42, 0.13, 0.98),
    new THREE.Vector3(0.42, 0.13, -0.98),
    new THREE.Vector3(-0.42, 0.13, -0.98),
  ],
};

const Z0 = -2.15, Z1 = 2.2;
const halfW = profile([[-2.15, 0.84], [-1.95, 0.93], [-1.4, 0.99], [-0.7, 0.955], [0.3, 0.94], [1.25, 0.975], [1.8, 0.93], [2.2, 0.82]]);
const topY = profile([[-2.15, 0.79], [-1.98, 0.93], [-1.5, 0.955], [-1.0, 0.935], [0.0, 0.9], [0.8, 0.845], [1.4, 0.77], [1.9, 0.67], [2.2, 0.52]]);
const sillY = profile([[-2.15, 0.36], [-1.9, 0.24], [-1.6, 0.19], [1.6, 0.19], [1.95, 0.21], [2.2, 0.28]]);
const ARCH_R = 0.39;
const ARCH_INNER_X = 0.6;

function archY(z) {
  let y = -Infinity;
  for (const wz of [CAR.wheelZ, -CAR.wheelZ]) {
    const dz = z - wz;
    if (Math.abs(dz) < ARCH_R) y = Math.max(y, CAR.tireR + Math.sqrt(ARCH_R * ARCH_R - dz * dz));
  }
  return y;
}

function capFactor(z, z0, z1, er, ef) {
  let u = 0;
  if (z > z1 - ef) u = (z - (z1 - ef)) / ef;
  else if (z < z0 + er) u = (z0 + er - z) / er;
  u = Math.min(u, 1);
  return 1 - u * u;
}

const sectionCenter = (z) => {
  const yb = sillY(z);
  return yb + (topY(z) - yb) * 0.46;
};

// Point on the body shell. theta = 0 on the left (+X) side, PI/2 on top.
function bodyPoint(z, th, out) {
  const cap = capFactor(z, Z0, Z1, 0.2, 0.38);
  const cw = Math.pow(cap, z < 0 ? 0.3 : 0.42), ch = Math.pow(cap, z < 0 ? 0.4 : 0.5);
  const hw = halfW(z) * cw;
  const yt = topY(z), yb = sillY(z);
  const yc = yb + (yt - yb) * 0.46;
  const c = Math.cos(th), s = Math.sin(th);
  const upper = s >= 0;
  const rearSq = Math.min(1, Math.max(0, (-1.55 - z) / 0.5)); // squarer Kamm tail
  const ex = 2 / (upper ? 3.2 + 1.3 * rearSq : 4.4);
  const x = hw * Math.sign(c) * Math.pow(Math.abs(c), ex);
  let y = upper
    ? yc + (yt - yc) * ch * Math.pow(s, ex)
    : yc - (yc - yb) * ch * Math.pow(-s, ex);
  if (upper) {
    // sculpted fenders over the wheels
    const ax = Math.abs(x);
    const w = Math.pow(s, 0.6) * ch;
    const front = 0.12 * Math.exp(-Math.pow((z - 1.3) / 0.5, 2));
    const rear = 0.06 * Math.exp(-Math.pow((z + 1.4) / 0.6, 2));
    const fx = Math.exp(-Math.pow((ax - 0.76) / 0.2, 2));
    y += (front + rear) * fx * w;
  }
  return out.set(x, y, z);
}

const canTop = profile([[-1.05, 0.86], [-0.8, 1.02], [-0.4, 1.14], [0.0, 1.165], [0.35, 1.1], [0.62, 0.98], [0.92, 0.82]]);
const canW = profile([[-1.05, 0.5], [-0.75, 0.66], [-0.2, 0.69], [0.4, 0.66], [0.92, 0.5]]);
const CZ0 = -1.05, CZ1 = 0.92;

function canopyPoint(z, th, out) {
  const cap = capFactor(z, CZ0, CZ1, 0.22, 0.22);
  const hw = canW(z) * Math.pow(cap, 0.5);
  const base = topY(z) - 0.1;
  const top = Math.max(canTop(z), base + 0.02);
  const c = Math.cos(th), s = Math.sin(th);
  const upper = s >= 0;
  const ex = 2 / (upper ? 2.4 : 6);
  const x = hw * Math.sign(c) * Math.pow(Math.abs(c), ex);
  const y = upper ? base + (top - base) * Math.pow(cap, 0.5) * Math.pow(s, ex) : base - 0.04 * Math.pow(-s, ex);
  return out.set(x, y, z);
}

// Loft a closed surface: rings around Z, seam at the bottom centre.
export function loft(pointFn, z0, z1, nz, nt, colorFn) {
  const pos = [], col = [], idx = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= nz; i++) {
    const t = i / nz;
    const z = z0 + (z1 - z0) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    for (let j = 0; j <= nt; j++) {
      const th = -Math.PI / 2 + (j / nt) * Math.PI * 2;
      pointFn(z, th, p);
      const c = colorFn ? colorFn(p, z) : 1;
      pos.push(p.x, p.y, p.z);
      col.push(c, c, c);
    }
  }
  const row = nt + 1;
  for (let i = 0; i < nz; i++) {
    for (let j = 0; j < nt; j++) {
      const a = i * row + j, b = (i + 1) * row + j, c = i * row + j + 1, d = (i + 1) * row + j + 1;
      idx.push(a, c, b, c, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // the end rings collapse to a point: give those vertices a sane normal (zero normals -> NaN in shaders)
  const nrm = g.getAttribute('normal');
  const zMid = (z0 + z1) / 2;
  for (let i = 0; i < nrm.count; i++) {
    const l = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    if (!(l > 1e-4)) nrm.setXYZ(i, 0, 0, Math.sign(pos[i * 3 + 2] - zMid) || 1);
  }
  return g;
}

function bodyColor(p, z) {
  // wheel wells: clamp the lower outer shell up to the arch and paint it black
  const ay = archY(z);
  if (Math.abs(p.x) > ARCH_INNER_X && p.y < ay) {
    p.y = ay;
    return 0.02;
  }
  if (p.y < sillY(z) + 0.025) return 0.05; // underbody
  const yc = sectionCenter(z);
  if (z > 1.97 && p.y < yc - 0.02) return 0.05; // front intake / splitter
  if (z < -1.92 && p.y < yc + 0.02) return 0.05; // rear diffuser
  return 1;
}

// Light bar at a constant height: from the front it reads as one straight line across the nose.
function lightBarCurve(targetY, zStart, zTip, steps, outward) {
  const p = new THREE.Vector3();
  const right = [];
  for (let k = 0; k <= steps; k++) {
    const t = 1 - Math.pow(1 - k / steps, 2.5);
    const z = zStart + (zTip - zStart) * t;
    bodyPoint(z, Math.PI / 2, p);
    if (p.y < targetY + 0.004) break;
    let lo = 0, hi = Math.PI / 2;
    for (let it = 0; it < 28; it++) {
      const mid = (lo + hi) / 2;
      bodyPoint(z, mid, p);
      if (p.y < targetY) lo = mid;
      else hi = mid;
    }
    bodyPoint(z, Math.PI - lo, p);
    right.push(p.clone());
  }
  const last = right[right.length - 1];
  const tip = new THREE.Vector3(0, targetY, last.z + Math.sign(zTip) * Math.min(0.03, Math.abs(last.x) * 0.3));
  const left = right.map((q) => new THREE.Vector3(-q.x, q.y, q.z)).reverse();
  const pts = [...right, tip, ...left];
  const centre = new THREE.Vector3(0, 0, zTip - Math.sign(zTip) * 0.7);
  for (const q of pts) {
    centre.y = q.y;
    const d = q.clone().sub(centre).normalize();
    q.addScaledVector(d, outward);
  }
  return new THREE.CatmullRomCurve3(pts);
}

function buildWheel(side, mats) {
  const pivot = new THREE.Group();
  const spin = new THREE.Group();
  pivot.add(spin);
  const R = CAR.tireR, Rin = 0.245, W = 0.125;
  const prof = [
    [Rin, -W], [0.3, -W], [0.322, -W + 0.008], [R, -W + 0.035], [R + 0.002, 0],
    [R, W - 0.035], [0.322, W - 0.008], [0.3, W], [Rin, W],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const tireGeo = new THREE.LatheGeometry(prof, 56);
  tireGeo.rotateZ(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeo, mats.tire);
  tire.castShadow = true;
  spin.add(tire);

  const barrelGeo = new THREE.CylinderGeometry(Rin + 0.004, Rin + 0.004, W * 1.8, 40, 1, true);
  barrelGeo.rotateZ(Math.PI / 2);
  spin.add(new THREE.Mesh(barrelGeo, mats.rimDark));

  const faceGeo = new THREE.CircleGeometry(Rin + 0.004, 48);
  faceGeo.rotateY((side * Math.PI) / 2);
  const face = new THREE.Mesh(faceGeo, mats.rim);
  face.position.x = side * W * 0.55;
  spin.add(face);

  // brake caliper (does not spin)
  const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.09), mats.caliper);
  caliper.position.set(side * 0.02, 0.12, -0.12);
  pivot.add(caliper);
  return { pivot, spin };
}

const jetVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = -mv.xyz;
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`;
const jetFragment = /* glsl */ `
  uniform float uPower;
  uniform float uTime;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float along = 1.0 - vUv.y;
    float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
    float flick = 0.82 + 0.18 * sin(uTime * 70.0 + vUv.x * 37.0 + along * 20.0);
    float core = pow(1.0 - along, 2.4) * smoothstep(0.0, 0.04, along);
    gl_FragColor = vec4(uColor * (uPower * edge * core * flick), 1.0);
  }
`;

export function buildCar(envMap) {
  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.position.y = -CAR.comY;
  root.add(inner);

  const paint = new THREE.MeshPhysicalMaterial({
    color: 0xf3f4f6,
    metalness: 0.12,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.035,
    vertexColors: true,
    envMapIntensity: 1.1,
  });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x04060a,
    metalness: 0.2,
    roughness: 0.04,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    envMapIntensity: 1.6,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x07080a, roughness: 0.7, metalness: 0.2 });
  const mats = {
    tire: new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.82, metalness: 0 }),
    rimDark: new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.5, metalness: 0.6 }),
    rim: new THREE.MeshStandardMaterial({ map: makeWheelTexture(), roughness: 0.32, metalness: 0.75, envMapIntensity: 1.2 }),
    caliper: new THREE.MeshStandardMaterial({ color: 0xb0101c, roughness: 0.4, metalness: 0.3 }),
  };

  const bodyGeo = loft(bodyPoint, Z0, Z1, 190, 112, bodyColor);
  const body = new THREE.Mesh(bodyGeo, paint);
  body.castShadow = true;
  body.receiveShadow = true;
  inner.add(body);

  const canopy = new THREE.Mesh(loft(canopyPoint, CZ0, CZ1, 90, 72), glass);
  canopy.castShadow = true;
  inner.add(canopy);

  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.42, 3.6), dark);
  tub.position.set(0, 0.39, -0.02);
  inner.add(tub);

  // side mirrors
  const mirrorGeo = new THREE.SphereGeometry(1, 20, 12);
  for (const s of [1, -1]) {
    const m = new THREE.Mesh(mirrorGeo, paint);
    m.scale.set(0.05, 0.045, 0.1);
    m.position.set(s * 0.93, 0.93, 0.6);
    m.castShadow = true;
    inner.add(m);
    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.02, 0.04), dark);
    stalk.position.set(s * 0.86, 0.9, 0.6);
    inner.add(stalk);
  }

  // light bars
  const frontBarMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 7, 7.6) });
  const frontBar = new THREE.Mesh(new THREE.TubeGeometry(lightBarCurve(0.6, 1.76, Z1 - 0.004, 60, 0.004), 160, 0.012, 8), frontBarMat);
  inner.add(frontBar);
  const rearBarMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.03, 0.06) });
  const rearBar = new THREE.Mesh(new THREE.TubeGeometry(lightBarCurve(0.78, -1.75, Z0 + 0.004, 60, 0.004), 160, 0.014, 8), rearBarMat);
  inner.add(rearBar);

  // wheels
  const wheels = [];
  for (const [x, z] of [[CAR.trackHalf, CAR.wheelZ], [-CAR.trackHalf, CAR.wheelZ], [CAR.trackHalf, -CAR.wheelZ], [-CAR.trackHalf, -CAR.wheelZ]]) {
    const w = buildWheel(Math.sign(x), mats);
    w.pivot.position.set(x, CAR.tireR, z);
    inner.add(w.pivot);
    wheels.push(w);
  }

  // thruster nozzles + plume cones
  const nozzleGeo = new THREE.CylinderGeometry(0.075, 0.09, 0.08, 20);
  const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.9, roughness: 0.3 });
  const coreGeo = new THREE.CircleGeometry(0.06, 20);
  coreGeo.rotateX(Math.PI / 2);
  const jetGeo = new THREE.CylinderGeometry(0.06, 0.55, 3.2, 24, 1, true);
  jetGeo.translate(0, -1.6, 0);
  const jets = [];
  for (const n of CAR.nozzles) {
    const nz = new THREE.Mesh(nozzleGeo, nozzleMat);
    nz.position.copy(n);
    inner.add(nz);
    const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0, 0) });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.position.copy(n).add(new THREE.Vector3(0, -0.045, 0));
    inner.add(core);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uPower: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color(1.6, 1.75, 2.1) } },
      vertexShader: jetVertex,
      fragmentShader: jetFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const jet = new THREE.Mesh(jetGeo, mat);
    jet.position.copy(n).add(new THREE.Vector3(0, -0.05, 0));
    jet.renderOrder = 6;
    jet.frustumCulled = false;
    inner.add(jet);
    jets.push({ mesh: jet, mat, coreMat });
  }

  // headlights
  const headlights = [];
  for (const s of [1, -1]) {
    const l = new THREE.SpotLight(0xe8f0ff, 38, 70, 0.42, 0.75, 2);
    l.position.set(s * 0.55, 0.58, 1.95);
    l.target.position.set(s * 1.5, 0, 26);
    inner.add(l, l.target);
    headlights.push(l);
  }
  const underGlow = new THREE.PointLight(0xcfe0ff, 0, 14, 2);
  underGlow.position.set(0, -0.9, 0);
  inner.add(underGlow);

  root.traverse((o) => {
    if (o.isMesh && o.material && o.material.isMeshStandardMaterial && envMap) o.material.envMap = envMap;
  });

  return { root, inner, wheels, jets, headlights, underGlow, frontBarMat, rearBarMat, paint };
}

// Static copy of the car for display (carrier load, showcase lineup): no lights, no jets.
export function buildDisplayCar(car, paint) {
  const g = car.inner.clone(true);
  g.position.set(0, 0, 0);
  const remove = [];
  g.traverse((o) => {
    if (o.isLight) remove.push(o);
    else if (o.isMesh && o.material && o.material.isShaderMaterial) remove.push(o);
    else if (o.isMesh && paint && o.material === car.paint) o.material = paint;
  });
  remove.forEach((o) => o.parent.remove(o));
  return g;
}