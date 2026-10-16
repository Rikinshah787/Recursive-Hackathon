import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, clamp, smoothstep, damp, TAU } from './util.js';
import { makeFloorTextures, makePadTexture, makeParkTexture } from './textures.js';

export const LAYOUT = {
  stage: { x: 0, z: -52, r: 13, h: 0.5, slope: 2.6 },
  bounds: { minX: -116, maxX: 116, minZ: -70, maxZ: 80 },
  gate: { z: 16, halfW: 6.5 },
  pad: { x: 0, z: 34, r: 7 },
  rings: [
    { p: [0, 12, 60], n: [0, 0, 1] },
    { p: [48, 18, 42], n: [1, 0, -0.45] },
    { p: [-38, 15, 26], n: [-1, 0, -0.15] },
  ],
  spawnStage: { x: 0, z: -52, heading: 0 },
  spawnFree: { x: 0, z: -22, heading: 0 },
};

const Y = new THREE.Vector3(0, 1, 0);
const Zv = new THREE.Vector3(0, 0, 1);

export const hdr = (r, g, b, k = 1) => new THREE.Color(r * k, g * k, b * k);

// ---------------------------------------------------------------- shaders
const WetReflectorShader = {
  name: 'WetReflectorShader',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    tWet: { value: null },
    uStrength: { value: 0.85 },
    uBlur: { value: 0.0032 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
      #include <logdepthbuf_vertex>
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform sampler2D tWet;
    uniform float uStrength;
    uniform float uBlur;
    varying vec4 vUv;
    varying vec3 vWorld;
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec2 wuv = vec2((vWorld.x + 300.0) / 50.0, (300.0 - vWorld.z) / 50.0);
      vec4 wet = texture2D(tWet, wuv);
      vec4 grain = texture2D(tWet, wuv * 11.0);
      vec2 uv = vUv.xy / vUv.w;
      uv += (grain.bg - 0.5) * 0.005;
      float spread = uBlur * (1.0 + (1.0 - wet.r) * 2.5);
      vec3 acc = vec3(0.0);
      float ws = 0.0;
      for (int i = -5; i <= 5; i++) {
        float fi = float(i);
        float w = exp(-fi * fi / 10.0);
        acc += texture2D(tDiffuse, uv + vec2(fi * spread * 0.2, fi * spread)).rgb * w;
        ws += w;
      }
      vec3 refl = acc / ws;
      float k = mix(0.14, 1.0, wet.r) * uStrength;
      vec3 V = normalize(cameraPosition - vWorld);
      float fres = 0.2 + 0.8 * pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);
      float dist = length(cameraPosition - vWorld);
      gl_FragColor = vec4(refl * color * k * fres * exp(-dist * 0.004), 1.0);
    }
  `,
};

const beamVertex = /* glsl */ `
  varying float vAlong;
  varying vec3 vN;
  varying vec3 vV;
  varying float vDepth;
  void main() {
    vAlong = 1.0 - uv.y;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = normalize(-mv.xyz);
    vN = normalize(normalMatrix * normal);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
// Thin lines (lasers): simple glow along the length
const laserFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uFog;
  uniform float uFalloff;
  varying float vAlong;
  varying vec3 vN;
  varying vec3 vV;
  varying float vDepth;
  void main() {
    float fall = pow(clamp(1.0 - vAlong, 0.0, 1.0), uFalloff);
    float nearFade = smoothstep(1.5, 12.0, vDepth);
    float fog = exp(-uFog * vDepth);
    gl_FragColor = vec4(uColor * (fall * nearFade * fog * uIntensity), 1.0);
  }
`;

// Volumetric cone: closest approach between the view ray and the beam axis, so it looks right
// from any angle (including from inside the cone). Rendered with back faces only = one layer.
const beamVolVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const beamFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uFog;
  uniform float uFalloff;
  uniform vec3 uOrigin;
  uniform vec3 uAxis;
  uniform float uLength;
  uniform float uTan;
  varying vec3 vWorld;
  void main() {
    vec3 C = cameraPosition;
    vec3 D = normalize(vWorld - C);
    vec3 w0 = C - uOrigin;
    float b = dot(D, uAxis);
    float d = dot(D, w0);
    float e = dot(uAxis, w0);
    float denom = max(1.0 - b * b, 1e-4);
    float t = max((b * e - d) / denom, 0.0);
    t = min(t, length(vWorld - C));
    vec3 P = C + D * t;
    float s = dot(P - uOrigin, uAxis);
    if (s <= 0.0) discard;
    float r = 0.03 + s * uTan;
    float dist = length(P - (uOrigin + uAxis * s));
    float core = 1.0 - clamp(dist / r, 0.0, 1.0);
    core *= core;
    float along = clamp(s / uLength, 0.0, 1.0);
    float fall = pow(1.0 - along, uFalloff) * smoothstep(0.0, 0.012, along);
    float nearFade = smoothstep(0.3, 5.0, t);
    float fog = exp(-uFog * t);
    gl_FragColor = vec4(uColor * (core * fall * nearFade * fog * uIntensity), 1.0);
  }
`;

const discFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float rim = smoothstep(0.55, 1.0, d) * (1.0 - smoothstep(0.97, 1.0, d));
    float sweep = 0.5 + 0.5 * sin(d * 18.0 - uTime * 6.0);
    float a = (rim * 0.9 + 0.12 * sweep * smoothstep(0.2, 1.0, d)) * uIntensity;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`;
const discVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export function additiveShader(uniforms, vertexShader, fragmentShader) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------- env map
function buildEnvMap(renderer) {
  const env = new THREE.Scene();
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(100, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; void main(){
        float h = normalize(vP).y;
        vec3 c = mix(vec3(0.004,0.005,0.012), vec3(0.012,0.018,0.06), smoothstep(-0.3, 0.7, h));
        c += vec3(1.2, 0.06, 0.14) * exp(-pow((h - 0.03) / 0.07, 2.0)) * 0.7;
        c += vec3(0.1, 0.2, 1.6) * exp(-pow((h + 0.08) / 0.03, 2.0)) * 0.5;
        gl_FragColor = vec4(c, 1.0);
      }`,
    }),
  );
  env.add(sky);
  const panel = new THREE.MeshBasicMaterial({ color: hdr(5, 5, 5.6) });
  for (let i = 0; i < 7; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(36, 1.4), panel);
    p.position.set(-48 + i * 16, 45, -10 + (i % 2) * 18);
    p.rotation.x = Math.PI / 2;
    env.add(p);
  }
  const soft = new THREE.MeshBasicMaterial({ color: hdr(1.2, 1.3, 1.6) });
  const big = new THREE.Mesh(new THREE.PlaneGeometry(50, 18), soft);
  big.position.set(0, 30, 70);
  big.lookAt(0, 0, 0);
  env.add(big);
  const red = new THREE.MeshBasicMaterial({ color: hdr(8, 0.3, 0.6) });
  for (const x of [-30, 30]) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(6, 0.5, 8, 48, Math.PI * 1.3), red);
    r.position.set(x, 4, -60);
    env.add(r);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.02).texture;
  pmrem.dispose();
  return tex;
}

// ---------------------------------------------------------------- helpers
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _dir = new THREE.Vector3();

export function pushBar(list, a, b, t) {
  _dir.subVectors(b, a);
  const len = _dir.length();
  _q.setFromUnitVectors(Zv, _dir.normalize());
  _p.addVectors(a, b).multiplyScalar(0.5);
  _s.set(t, t, len);
  list.push(new THREE.Matrix4().compose(_p.clone(), _q.clone(), _s.clone()));
}

// Square lattice truss from a to b
export function truss(list, a, b, size = 0.6, rod = 0.05) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  d.normalize();
  const u = Math.abs(d.y) < 0.9 ? new THREE.Vector3().crossVectors(d, Y).normalize() : new THREE.Vector3(1, 0, 0);
  const v = new THREE.Vector3().crossVectors(d, u).normalize();
  const h = size / 2;
  const corners = [[h, h], [-h, h], [-h, -h], [h, -h]].map(([x, y]) => u.clone().multiplyScalar(x).addScaledVector(v, y));
  for (const c of corners) pushBar(list, a.clone().add(c), b.clone().add(c), rod);
  const n = Math.max(1, Math.round(len / size));
  for (let k = 0; k < n; k++) {
    const p0 = a.clone().addScaledVector(d, (k / n) * len);
    const p1 = a.clone().addScaledVector(d, ((k + 1) / n) * len);
    for (let f = 0; f < 4; f++) {
      const c0 = corners[f], c1 = corners[(f + 1) % 4];
      if (k % 2 === 0) pushBar(list, p0.clone().add(c0), p1.clone().add(c1), rod * 0.7);
      else pushBar(list, p0.clone().add(c1), p1.clone().add(c0), rod * 0.7);
    }
  }
}

export function instanced(geo, mat, matrices) {
  const m = new THREE.InstancedMesh(geo, mat, matrices.length);
  matrices.forEach((mx, i) => m.setMatrixAt(i, mx));
  m.instanceMatrix.needsUpdate = true;
  m.computeBoundingSphere();
  return m;
}

// ---------------------------------------------------------------- beams
const beamGeo = (() => {
  const g = new THREE.CylinderGeometry(0.02, 1, 1, 40, 1, true);
  g.translate(0, -0.5, 0);
  g.rotateX(-Math.PI / 2);
  return g;
})();
const laserGeo = (() => {
  const g = new THREE.CylinderGeometry(0.035, 0.035, 1, 6, 1, true);
  g.translate(0, -0.5, 0);
  g.rotateX(-Math.PI / 2);
  return g;
})();

class Beam {
  constructor(parent, origin, { color, length = 140, radius = 4, intensity = 0.25, falloff = 1.4, geo = beamGeo, head = true }) {
    this.origin = origin.clone();
    this.baseColor = color.clone();
    this.baseIntensity = intensity;
    this.volumetric = geo === beamGeo;
    this.mat = additiveShader(
      {
        uColor: { value: color.clone() },
        uIntensity: { value: intensity },
        uFog: { value: 0.0025 },
        uFalloff: { value: falloff },
        uOrigin: { value: origin.clone() },
        uAxis: { value: new THREE.Vector3(0, 0, -1) },
        uLength: { value: length },
        uTan: { value: radius / length },
      },
      this.volumetric ? beamVolVertex : beamVertex,
      this.volumetric ? beamFragment : laserFragment,
    );
    if (this.volumetric) this.mat.side = THREE.BackSide;
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.copy(origin);
    this.mesh.scale.set(radius, radius, length);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    parent.add(this.mesh);
    this.target = new THREE.Vector3(origin.x, 0, origin.z - 50);
    this.aim = this.target.clone();
    if (head) {
      this.head = new THREE.Group();
      const body = new THREE.Mesh(Beam.headGeo, Beam.headMat);
      const lens = new THREE.Mesh(Beam.lensGeo, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(4) }));
      lens.position.z = 0.26;
      this.lensMat = lens.material;
      this.head.add(body, lens);
      this.head.position.copy(origin);
      parent.add(this.head);
    }
  }

  update(dt, lambda = 2.5) {
    this.aim.x = damp(this.aim.x, this.target.x, lambda, dt);
    this.aim.y = damp(this.aim.y, this.target.y, lambda, dt);
    this.aim.z = damp(this.aim.z, this.target.z, lambda, dt);
    this.mesh.lookAt(this.aim);
    if (this.head) this.head.lookAt(this.aim);
    if (this.volumetric) {
      const u = this.mat.uniforms;
      u.uAxis.value.subVectors(this.aim, this.origin).normalize();
      u.uLength.value = this.mesh.scale.z;
      u.uTan.value = this.mesh.scale.x / this.mesh.scale.z;
    }
  }
}
Beam.headGeo = new THREE.BoxGeometry(0.45, 0.45, 0.5);
Beam.headMat = new THREE.MeshStandardMaterial({ color: 0x15171b, metalness: 0.6, roughness: 0.4 });
Beam.lensGeo = new THREE.CircleGeometry(0.16, 20);

// ---------------------------------------------------------------- rings
class FlightRing {
  constructor(parent, def, index) {
    this.index = index;
    this.pos = new THREE.Vector3(...def.p);
    this.normal = new THREE.Vector3(...def.n).normalize();
    this.radius = 5.5;
    this.group = new THREE.Group();
    this.group.position.copy(this.pos);
    this.group.lookAt(this.pos.clone().add(this.normal));
    this.mat = new THREE.MeshStandardMaterial({ color: 0x14030a, emissive: new THREE.Color(1, 0.06, 0.12), emissiveIntensity: 3, roughness: 0.3, metalness: 0.4 });
    const torus = new THREE.Mesh(new THREE.TorusGeometry(this.radius, 0.2, 16, 140), this.mat);
    this.group.add(torus);
    const bulbCount = 40;
    this.bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), bulbCount * 2);
    let k = 0;
    for (const side of [1, -1]) {
      for (let i = 0; i < bulbCount; i++) {
        const a = (i / bulbCount) * TAU;
        _m.makeTranslation(Math.cos(a) * this.radius, Math.sin(a) * this.radius, side * 0.22);
        this.bulbs.setMatrixAt(k, _m);
        this.bulbs.setColorAt(k, new THREE.Color(1, 1, 1));
        k++;
      }
    }
    this.bulbCount = bulbCount;
    this.group.add(this.bulbs);
    this.discMat = additiveShader({ uColor: { value: hdr(1, 0.25, 0.35) }, uIntensity: { value: 0 }, uTime: { value: 0 } }, discVertex, discFragment);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(this.radius - 0.15, 64), this.discMat);
    disc.renderOrder = 2;
    this.group.add(disc);
    parent.add(this.group);
    this.state = 'idle';
    this.flash = 0;
    this._c = new THREE.Color();
  }

  setState(s) {
    this.state = s;
  }

  checkPass(a, b) {
    const d0 = _p.subVectors(a, this.pos).dot(this.normal);
    const d1 = _s.subVectors(b, this.pos).dot(this.normal);
    if (d0 * d1 > 0 || d0 === d1) return false;
    const t = d0 / (d0 - d1);
    const hit = _p.copy(a).lerp(b, t);
    return hit.distanceTo(this.pos) < this.radius - 0.2;
  }

  update(t, dt) {
    this.flash = Math.max(0, this.flash - dt * 1.5);
    const active = this.state === 'active';
    const done = this.state === 'done';
    const pulse = 0.5 + 0.5 * Math.sin(t * 5);
    const base = active ? 5 + pulse * 3 : done ? 0.6 : 2.2;
    this.mat.emissiveIntensity = base + this.flash * 20;
    this.mat.emissive.setRGB(1, active ? 0.12 + 0.1 * pulse : 0.05, active ? 0.2 : 0.1);
    this.discMat.uniforms.uIntensity.value = (active ? 0.5 + 0.3 * pulse : 0) + this.flash * 2;
    this.discMat.uniforms.uTime.value = t;
    const n = this.bulbCount;
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < n; i++) {
        let v;
        if (active) v = (Math.sin(i * 0.9 - t * 12) > 0.4 ? 9 : 1.5);
        else if (done) v = 0.25;
        else v = 2.5 + Math.sin(i * 0.5 + t * 2) * 1.2;
        v += this.flash * 10;
        this._c.setRGB(v, v * (active ? 0.85 : 0.35), v * (active ? 0.8 : 0.4));
        this.bulbs.setColorAt(side * n + i, this._c);
      }
    }
    this.bulbs.instanceColor.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- cones
class Cones {
  constructor(parent, positions) {
    const bodyProfile = [[0.17, 0.04], [0.155, 0.1], [0.03, 0.72], [0.0, 0.73]].map(([x, y]) => new THREE.Vector2(x, y));
    const rAt = (y) => 0.155 + (0.03 - 0.155) * ((y - 0.1) / 0.62) + 0.004;
    const body = new THREE.LatheGeometry(bodyProfile, 24);
    const base = new THREE.BoxGeometry(0.42, 0.04, 0.42).toNonIndexed();
    base.translate(0, 0.02, 0);
    const bodyGeo = mergeGeometries([body.toNonIndexed(), base]);
    const bandGeo = mergeGeometries([
      new THREE.LatheGeometry([new THREE.Vector2(rAt(0.3), 0.3), new THREE.Vector2(rAt(0.44), 0.44)], 24),
      new THREE.LatheGeometry([new THREE.Vector2(rAt(0.52), 0.52), new THREE.Vector2(rAt(0.6), 0.6)], 24),
    ]);
    const n = positions.length;
    this.body = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0xff4612, roughness: 0.45 }), n);
    this.band = new THREE.InstancedMesh(bandGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x8899aa, emissiveIntensity: 0.5, roughness: 0.25 }), n);
    this.body.castShadow = true;
    this.body.frustumCulled = this.band.frustumCulled = false;
    parent.add(this.body, this.band);
    this.items = positions.map(([x, z]) => ({
      home: new THREE.Vector3(x, 0, z),
      pos: new THREE.Vector3(x, 0, z),
      quat: new THREE.Quaternion(),
      vel: new THREE.Vector3(),
      ang: new THREE.Vector3(),
      dynamic: false,
      cooldown: 0,
    }));
    this.reset();
  }

  reset() {
    for (const c of this.items) {
      c.pos.copy(c.home);
      c.quat.identity();
      c.vel.set(0, 0, 0);
      c.ang.set(0, 0, 0);
      c.dynamic = false;
      c.knocked = false;
    }
    this.writeAll();
  }

  writeAll() {
    this.items.forEach((c, i) => {
      _m.compose(c.pos, c.quat, _s.set(1, 1, 1));
      this.body.setMatrixAt(i, _m);
      this.band.setMatrixAt(i, _m);
    });
    this.body.instanceMatrix.needsUpdate = this.band.instanceMatrix.needsUpdate = true;
  }

  // returns number of cones newly knocked
  update(dt, v) {
    let hits = 0;
    const inv = new THREE.Quaternion().copy(v.quat).invert();
    const local = new THREE.Vector3();
    const up = new THREE.Vector3();
    let moved = false;
    for (const c of this.items) {
      c.cooldown = Math.max(0, c.cooldown - dt);
      const dx = c.pos.x - v.pos.x, dz = c.pos.z - v.pos.z;
      if (dx * dx + dz * dz < 16 && c.cooldown <= 0) {
        local.set(c.pos.x, c.pos.y + 0.3, c.pos.z).sub(v.pos).applyQuaternion(inv);
        if (Math.abs(local.x) < 1.15 && Math.abs(local.z) < 2.35 && local.y > -0.95 && local.y < 0.9) {
          const sp = v.vel.length();
          if (sp > 0.8 || v.thrust > 0.2) {
            const push = new THREE.Vector3(local.x, 0, local.z * 0.3).normalize().applyQuaternion(v.quat);
            c.vel.copy(v.vel).multiplyScalar(1.1 + Math.random() * 0.3).addScaledVector(push, 2 + sp * 0.15);
            c.vel.y = 1.5 + sp * 0.12 + Math.random();
            c.ang.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(4 + sp * 0.4);
            c.dynamic = true;
            c.cooldown = 0.4;
            if (!c.knocked) hits++;
            c.knocked = true;
          }
        }
      }
      // jet blast tips cones over
      if (!c.dynamic && v.thrust > 0.25 && v.altitude < 5 && dx * dx + dz * dz < 9) {
        c.vel.set(dx, 0, dz).normalize().multiplyScalar(3 + Math.random() * 2);
        c.vel.y = 2;
        c.ang.set(dz, 0, -dx).normalize().multiplyScalar(5);
        c.dynamic = true;
        if (!c.knocked) hits++;
        c.knocked = true;
      }
      if (!c.dynamic) continue;
      moved = true;
      c.vel.y -= 9.81 * dt;
      c.pos.addScaledVector(c.vel, dt);
      _q.set(c.ang.x * 0.5 * dt, c.ang.y * 0.5 * dt, c.ang.z * 0.5 * dt, 0).multiply(c.quat);
      c.quat.x += _q.x; c.quat.y += _q.y; c.quat.z += _q.z; c.quat.w += _q.w;
      c.quat.normalize();
      up.set(0, 1, 0).applyQuaternion(c.quat);
      const tilt = Math.acos(clamp(up.y, -1, 1));
      const floor = 0.17 * Math.sin(Math.min(tilt, Math.PI / 2)) + (tilt > Math.PI / 2 ? 0.1 : 0);
      if (c.pos.y < floor) {
        c.pos.y = floor;
        if (c.vel.y < 0) c.vel.y *= -0.25;
        c.vel.x *= 0.82; c.vel.z *= 0.82;
        c.ang.multiplyScalar(0.8);
        // settle onto its side
        if (tilt > 0.3 && tilt < 1.4) {
          const axis = new THREE.Vector3(up.z, 0, -up.x).normalize();
          c.ang.addScaledVector(axis, 8 * dt * 10);
        }
        if (c.vel.lengthSq() < 0.05 && c.ang.lengthSq() < 0.2) c.dynamic = false;
      }
    }
    if (moved) this.writeAll();
    return hits;
  }
}

// ---------------------------------------------------------------- arena
export class Arena {
  constructor(renderer, scene, smokeTex, glowTex) {
    this.scene = scene;
    this.glowTex = glowTex;
    this.bounds = LAYOUT.bounds;
    this.root = new THREE.Group();
    scene.add(this.root);
    const aniso = renderer.capabilities.getMaxAnisotropy();
    this.envMap = buildEnvMap(renderer);
    this.tex = makeFloorTextures(Math.min(16, aniso));
    this.time = 0;
    this.excitement = 0;

    this.buildFloor(renderer);
    this.buildStage();
    this.buildMarkings();
    this.buildBarriersAndCrowd();
    this.buildRig();
    this.buildLights();
    this.buildRings();
    this.cones = new Cones(this.root, this.conePositions());
    this.buildCeiling();
  }

  // ---- ground queries
  height(x, z) {
    const S = LAYOUT.stage;
    const d = Math.hypot(x - S.x, z - S.z);
    if (d <= S.r) return S.h;
    if (d >= S.r + S.slope) return 0;
    const t = (d - S.r) / S.slope;
    return S.h * (1 - t * t * (3 - 2 * t));
  }

  normal(x, z, out) {
    const e = 0.06;
    const hl = this.height(x - e, z), hr = this.height(x + e, z);
    const hd = this.height(x, z - e), hu = this.height(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  // ---- floor with wet reflections
  buildFloor(renderer) {
    const { albedo, normal, wet } = this.tex;
    albedo.repeat.set(150, 150);
    normal.repeat.set(150, 150);
    wet.repeat.set(12, 12);
    const floorMat = new THREE.MeshStandardMaterial({
      map: albedo,
      normalMap: normal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughnessMap: wet,
      roughness: 1,
      metalness: 0,
      envMapIntensity: 0.25,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.root.add(floor);

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.reflector = new Reflector(new THREE.PlaneGeometry(600, 600), {
      clipBias: 0.003,
      textureWidth: Math.max(256, size.x * 0.5),
      textureHeight: Math.max(256, size.y * 0.5),
      color: 0xffffff,
      shader: WetReflectorShader,
      multisample: 0,
    });
    this.reflector.material.uniforms.tWet.value = wet;
    this.reflector.material.transparent = true;
    this.reflector.material.blending = THREE.AdditiveBlending;
    this.reflector.material.depthWrite = false;
    this.reflector.rotation.x = -Math.PI / 2;
    this.reflector.position.y = 0.004;
    this.reflector.renderOrder = 1;
    this.root.add(this.reflector);
  }

  setReflectionScale(w, h, scale) {
    if (!scale) {
      this.reflector.visible = false;
      return;
    }
    this.reflector.visible = true;
    this.reflector.getRenderTarget().setSize(Math.max(256, Math.floor(w * scale)), Math.max(256, Math.floor(h * scale)));
  }

  buildStage() {
    const S = LAYOUT.stage;
    const pts = [];
    const steps = 14;
    for (let i = steps; i >= 0; i--) {
      const t = i / steps;
      pts.push(new THREE.Vector2(S.r + t * S.slope, S.h * (1 - t * t * (3 - 2 * t))));
    }
    pts.push(new THREE.Vector2(0.001, S.h));
    const stageMat = new THREE.MeshStandardMaterial({ color: 0x0b0c10, roughness: 0.32, metalness: 0.3, envMapIntensity: 0.6 });
    const stage = new THREE.Mesh(new THREE.LatheGeometry(pts, 128), stageMat);
    stage.position.set(S.x, 0, S.z);
    stage.receiveShadow = true;
    this.root.add(stage);

    const ledMat = new THREE.MeshBasicMaterial({ color: hdr(0.25, 0.55, 6) });
    this.stageLedMat = ledMat;
    const ring1 = new THREE.Mesh(new THREE.TorusGeometry(S.r + 0.05, 0.035, 8, 256), ledMat);
    ring1.rotation.x = Math.PI / 2;
    ring1.position.set(S.x, S.h + 0.01, S.z);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(S.r + S.slope + 0.05, 0.03, 8, 256), ledMat);
    ring2.rotation.x = Math.PI / 2;
    ring2.position.set(S.x, 0.03, S.z);
    this.root.add(ring1, ring2);

    // backdrop wall with LED strips
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x07080b, roughness: 0.6, metalness: 0.2 });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(48, 16, 1), wallMat);
    wall.position.set(S.x, 8, S.z - 17);
    this.root.add(wall);
    const stripMat = new THREE.MeshBasicMaterial({ color: hdr(0.3, 0.5, 4) });
    this.stripMat = stripMat;
    for (let i = -5; i <= 5; i++) {
      if (Math.abs(i) < 2) continue;
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.12, 14, 0.1), stripMat);
      s.position.set(S.x + i * 4, 8, S.z - 16.45);
      this.root.add(s);
    }

    // red neon sculptures (like the arcs next to the car in the video)
    const neonMat = new THREE.MeshBasicMaterial({ color: hdr(7, 0.25, 0.45) });
    this.neonMat = neonMat;
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1b0508, roughness: 0.5, metalness: 0.4 });
    for (const sx of [-1, 1]) {
      const g = new THREE.Group();
      for (let k = 0; k < 4; k++) {
        const R = 2.6 + k * 0.62;
        const arc = new THREE.Mesh(new THREE.TorusGeometry(R, 0.09, 10, 120, Math.PI * 1.32), neonMat);
        arc.rotation.z = -Math.PI * 0.16;
        g.add(arc);
        const back = new THREE.Mesh(new THREE.TorusGeometry(R, 0.2, 8, 80, Math.PI * 1.32), frameMat);
        back.rotation.z = -Math.PI * 0.16;
        back.position.z = -0.25;
        g.add(back);
      }
      g.position.set(S.x + sx * 15.5, 5.2, S.z - 9);
      g.rotation.y = -sx * 0.45;
      g.scale.x = sx;
      this.root.add(g);
      const pl = new THREE.PointLight(0xff1a35, 160, 40, 2);
      pl.position.set(S.x + sx * 14.5, 4, S.z - 7);
      this.root.add(pl);
    }
  }

  buildMarkings() {
    // lane dashes
    const dashGeo = new THREE.PlaneGeometry(0.16, 2.2);
    dashGeo.rotateX(-Math.PI / 2);
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xd8dce4, roughness: 0.55, emissive: 0x15171c });
    const mats = [];
    for (const x of [-7.2, 7.2, 0]) {
      for (let z = -34; z <= 14; z += 4.4) {
        _m.makeTranslation(x, 0.006, z);
        mats.push(_m.clone());
      }
    }
    const dashes = instanced(dashGeo, dashMat, mats);
    dashes.receiveShadow = true;
    this.root.add(dashes);

    // landing pad decal + lights
    const P = LAYOUT.pad;
    this.padMat = new THREE.MeshBasicMaterial({ map: makePadTexture(), color: hdr(0.5, 0.7, 1.4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(P.r * 2.3, P.r * 2.3), this.padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(P.x, 0.012, P.z);
    pad.renderOrder = 1;
    this.root.add(pad);
    const lightGeo = new THREE.CylinderGeometry(0.12, 0.14, 0.06, 12);
    this.padLights = new THREE.InstancedMesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), 28);
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * TAU;
      _m.makeTranslation(P.x + Math.cos(a) * (P.r * 1.2), 0.03, P.z + Math.sin(a) * (P.r * 1.2));
      this.padLights.setMatrixAt(i, _m);
      this.padLights.setColorAt(i, new THREE.Color(1, 1, 1));
    }
    this.root.add(this.padLights);

    // park bay on the stage
    const S = LAYOUT.stage;
    this.parkMat = new THREE.MeshBasicMaterial({ map: makeParkTexture(), color: hdr(0.5, 0.6, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const park = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 6.8), this.parkMat);
    park.rotation.x = -Math.PI / 2;
    park.position.set(S.x, S.h + 0.012, S.z);
    park.renderOrder = 1;
    this.root.add(park);

    // start gate
    const G = LAYOUT.gate;
    const postMat = new THREE.MeshStandardMaterial({ color: 0x15171c, metalness: 0.7, roughness: 0.35 });
    this.gateLedMat = new THREE.MeshBasicMaterial({ color: hdr(0.4, 0.6, 5) });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6.4, 0.5), postMat);
      post.position.set(s * (G.halfW + 0.6), 3.2, G.z);
      post.castShadow = true;
      this.root.add(post);
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.06, 6.0, 0.08), this.gateLedMat);
      led.position.set(s * (G.halfW + 0.33), 3.2, G.z);
      this.root.add(led);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(G.halfW * 2 + 1.7, 0.5, 0.5), postMat);
    bar.position.set(0, 6.4, G.z);
    this.root.add(bar);
    const barLed = new THREE.Mesh(new THREE.BoxGeometry(G.halfW * 2 + 0.6, 0.06, 0.1), this.gateLedMat);
    barLed.position.set(0, 6.13, G.z);
    this.root.add(barLed);
  }

  conePositions() {
    const list = [];
    for (let z = -32; z <= 14; z += 4) list.push([-5, z], [5, z]);
    const P = LAYOUT.pad;
    for (let i = 0; i < 12; i++) {
      const a = ((i + 0.5) / 12) * TAU;
      list.push([P.x + Math.cos(a) * 11.5, P.z + Math.sin(a) * 11.5]);
    }
    for (let x = -46; x <= 46; x += 3) if (Math.abs(x) > 9) list.push([x, -27]);
    for (let z = 0; z < 50; z += 5) list.push([30 + Math.cos(z) * 2, z]);
    return list;
  }

  buildBarriersAndCrowd() {
    const B = LAYOUT.bounds;
    const barrierMat = new THREE.MeshStandardMaterial({ color: 0x0c0d12, roughness: 0.5, metalness: 0.3 });
    const ledMat = new THREE.MeshBasicMaterial({ color: hdr(0.2, 0.4, 3.5) });
    this.barrierLedMat = ledMat;
    const addWall = (x, z, lx, lz) => {
      const w = new THREE.Mesh(new THREE.BoxGeometry(lx, 1.1, lz), barrierMat);
      w.position.set(x, 0.55, z);
      this.root.add(w);
      const l = new THREE.Mesh(new THREE.BoxGeometry(lx + 0.02, 0.05, lz + 0.02), ledMat);
      l.position.set(x, 1.12, z);
      this.root.add(l);
    };
    addWall(B.minX - 3.5, 5, 0.5, 156);
    addWall(B.maxX + 3.5, 5, 0.5, 156);
    addWall(0, B.maxZ + 3.5, 240, 0.5);
    addWall(-70, B.minZ - 2.5, 96, 0.5);
    addWall(70, B.minZ - 2.5, 96, 0.5);

    // bleachers + crowd silhouettes
    const r = rng(42);
    const body = new THREE.CapsuleGeometry(0.21, 0.78, 3, 7);
    body.translate(0, 0.62, 0);
    const head = new THREE.SphereGeometry(0.13, 8, 6);
    head.translate(0, 1.32, 0);
    const personGeo = mergeGeometries([body.toNonIndexed(), head.toNonIndexed()]);
    const people = [];
    const phones = [];
    const steps = [];
    const stepMat = new THREE.MeshStandardMaterial({ color: 0x08090c, roughness: 0.8 });
    const tier = (origin, along, out, length, rows) => {
      for (let row = 0; row < rows; row++) {
        const base = origin.clone().addScaledVector(out, row * 1.05);
        const y = row * 0.55;
        const mid = base.clone().addScaledVector(along, length / 2);
        const sx = Math.abs(along.x) > 0.5 ? length : 1.05;
        const sz = Math.abs(along.z) > 0.5 ? length : 1.05;
        steps.push(new THREE.Matrix4().compose(new THREE.Vector3(mid.x, y / 2, mid.z), new THREE.Quaternion(), new THREE.Vector3(sx, Math.max(0.05, y), sz)));
        for (let d = 0.5; d < length; d += 0.85) {
          if (r() > 0.6) continue;
          const p = base.clone().addScaledVector(along, d + (r() - 0.5) * 0.3).addScaledVector(out, (r() - 0.5) * 0.2);
          p.y = y;
          const face = Math.atan2(-out.x, -out.z) + (r() - 0.5) * 0.6;
          const sc = 0.9 + r() * 0.22;
          people.push(new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromAxisAngle(Y, face), new THREE.Vector3(sc, sc, sc)));
          if (r() < 0.2) {
            const ph = p.clone().addScaledVector(out, -0.32);
            ph.y += 1.45 * sc + r() * 0.25;
            phones.push(new THREE.Matrix4().compose(ph, new THREE.Quaternion().setFromAxisAngle(Y, face + Math.PI), new THREE.Vector3(1, 1, 1)));
          }
        }
      }
    };
    tier(new THREE.Vector3(B.minX - 5, 0, -64), new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), 140, 9);
    tier(new THREE.Vector3(B.maxX + 5, 0, -64), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), 140, 9);
    tier(new THREE.Vector3(-112, 0, B.minZ - 4), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), 86, 8);
    tier(new THREE.Vector3(26, 0, B.minZ - 4), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), 86, 8);

    const crowdMat = new THREE.MeshStandardMaterial({ color: 0x0b0c10, roughness: 0.75, metalness: 0.0 });
    this.root.add(instanced(personGeo, crowdMat, people));
    this.root.add(instanced(new THREE.BoxGeometry(1, 1, 1), stepMat, steps));
    const phoneGeo = new THREE.PlaneGeometry(0.075, 0.14);
    this.phoneMat = new THREE.MeshBasicMaterial({ color: hdr(2.2, 2.4, 3), side: THREE.DoubleSide });
    this.phones = instanced(phoneGeo, this.phoneMat, phones);
    this.root.add(this.phones);
  }

  buildRig() {
    const bars = [];
    const v = (x, y, z) => new THREE.Vector3(x, y, z);
    // back truss (behind the arena, where the beams come from)
    const zb = 92;
    for (const x of [-100, -50, 0, 50, 100]) truss(bars, v(x, 0, zb), v(x, 26, zb), 0.7);
    truss(bars, v(-104, 26.4, zb), v(104, 26.4, zb), 0.8);
    // side towers
    for (const x of [-121, 121]) for (const z of [-40, 20, 66]) truss(bars, v(x, 0, z), v(x, 22, z), 0.6);
    // overhead grid
    truss(bars, v(-64, 32, -20), v(64, 32, -20), 0.7);
    truss(bars, v(-64, 32, 50), v(64, 32, 50), 0.7);
    truss(bars, v(-64, 32, -20), v(-64, 32, 50), 0.7);
    truss(bars, v(64, 32, -20), v(64, 32, 50), 0.7);
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x3a3e46, metalness: 0.85, roughness: 0.35 });
    this.root.add(instanced(new THREE.BoxGeometry(1, 1, 1), trussMat, bars));

    // blinders on the back truss
    this.blinderMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0, 0) });
    for (let i = 0; i < 10; i++) {
      const b = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), this.blinderMat);
      b.position.set(-90 + i * 20, 24.6, zb - 0.6);
      b.rotation.y = Math.PI;
      this.root.add(b);
    }

    // volumetric beams
    this.beams = { top: [], floor: [], side: [], sweep: [], lasers: [] };
    const cool = hdr(0.85, 0.92, 1.0);
    for (let x = -84; x <= 84; x += 12) this.beams.top.push(new Beam(this.root, v(x, 25.6, zb - 0.8), { color: cool, length: 150, radius: 3.2, intensity: 0.22 }));
    for (let x = -90; x <= 90; x += 15) this.beams.floor.push(new Beam(this.root, v(x, 1.4, zb - 4), { color: hdr(0.8, 0.85, 1), length: 140, radius: 3.6, intensity: 0.3 }));
    for (const x of [-121, 121]) for (const z of [-40, 20, 66]) this.beams.side.push(new Beam(this.root, v(x * 0.985, 22.6, z), { color: hdr(0.5, 0.65, 1.0), length: 120, radius: 4.5, intensity: 0.16 }));
    for (const [x, z] of [[-32, -20], [32, -20], [-32, 50], [32, 50]]) this.beams.sweep.push(new Beam(this.root, v(x, 31.3, z), { color: hdr(0.9, 0.95, 1), length: 60, radius: 4.2, intensity: 0.12, falloff: 0.5 }));
    this.followBeam = new Beam(this.root, v(26, 30, -66), { color: hdr(1, 0.98, 0.95), length: 160, radius: 7, intensity: 0.07, falloff: 0.35 });
    // lasers
    const laserColor = hdr(5, 0.12, 0.2);
    for (const ox of [-55, 0, 55]) {
      for (let i = 0; i < 9; i++) {
        this.beams.lasers.push(new Beam(this.root, v(ox, 3.5, zb - 3), { color: laserColor, length: 190, radius: 1, intensity: 1.0, falloff: 0.6, geo: laserGeo, head: i === 0 }));
      }
    }
    this.laserGroups = 3;
  }

  buildLights() {
    this.root.add(new THREE.HemisphereLight(0x22305a, 0x040406, 0.55));
    for (const x of [-15, 45]) {
      const r = new THREE.PointLight(0xff1030, 9000, 160, 2);
      r.position.set(x, 7, 84);
      this.root.add(r);
    }
    this.sweepLights = this.beams.sweep.map((b) => {
      const l = new THREE.SpotLight(0xe6eeff, 5000, 80, 0.14, 0.55, 2);
      l.position.copy(b.origin);
      this.root.add(l, l.target);
      return l;
    });
    const f = new THREE.SpotLight(0xfff8f0, 9000, 260, 0.08, 0.6, 2);
    f.position.copy(this.followBeam.origin);
    f.castShadow = true;
    f.shadow.mapSize.set(2048, 2048);
    f.shadow.camera.near = 20;
    f.shadow.camera.far = 260;
    f.shadow.bias = -0.00015;
    f.shadow.normalBias = 0.03;
    this.root.add(f, f.target);
    this.followLight = f;

    const S = LAYOUT.stage;
    for (const sx of [-1, 1]) {
      const s = new THREE.SpotLight(0xbcd0ff, 900, 60, 0.42, 0.7, 2);
      s.position.set(S.x + sx * 18, 20, S.z + 14);
      s.target.position.set(S.x, 0, S.z);
      this.root.add(s, s.target);
    }
  }

  buildRings() {
    this.rings = LAYOUT.rings.map((d, i) => new FlightRing(this.root, d, i));
  }

  buildCeiling() {
    const r = rng(9);
    const pos = [];
    for (let i = 0; i < 600; i++) pos.push((r() - 0.5) * 260, 46 + r() * 8, -70 + r() * 160);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: hdr(2.4, 2.6, 3.6), size: 0.6, sizeAttenuation: true, map: this.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.root.add(new THREE.Points(g, m));
  }

  setPadActive(on) { this.padActive = on; }
  setParkActive(on) { this.parkActive = on; }
  setGateActive(on) { this.gateActive = on; }

  kick(amount = 1) {
    this.excitement = Math.min(1.5, this.excitement + amount);
  }

  update(dt, ctx) {
    const t = (this.time += dt);
    const ex = (this.excitement = Math.max(0, this.excitement - dt * 0.35));
    const beat = ctx.beat ?? (t * 2) % 1;
    const car = ctx.carPos;
    const pulse = Math.pow(1 - beat, 3);
    const look = Math.floor(t / 14) % 4;
    const focus = ex > 0.4 || look === 3;

    // top beams
    this.beams.top.forEach((b, i) => {
      const o = b.origin;
      if (focus && car) b.target.set(car.x + Math.sin(t * 3 + i) * 3, car.y, car.z + Math.cos(t * 2.3 + i) * 3);
      else if (look === 0) b.target.set(o.x * 0.7 + Math.sin(t * 0.45 + i * 0.6) * 30, 0, 10 + Math.cos(t * 0.35 + i * 0.9) * 40);
      else if (look === 1) b.target.set(Math.sin(t * 0.7) * 80 + i * 2, 0, 20 + Math.sin(t * 0.5) * 35);
      else b.target.set(o.x * -0.6 + Math.sin(t * 0.8 + (i % 2) * Math.PI) * 40, 0, -20 + (i % 3) * 25);
      b.update(dt);
      const k = 1 + ex * 1.5 + (look === 1 ? pulse * 0.6 : 0);
      b.mat.uniforms.uIntensity.value = b.baseIntensity * k;
      b.mat.uniforms.uColor.value.copy(b.baseColor).lerp(hdr(1, 0.12, 0.2), Math.min(1, ex * 0.8));
    });
    // floor beams: big diagonal fans over the arena (like the video)
    this.beams.floor.forEach((b, i) => {
      const o = b.origin;
      const fan = Math.sin(t * 0.35 + i * 0.45);
      b.target.set(o.x * 0.4 + fan * 70, 34 + Math.sin(t * 0.6 + i) * 18, -70 + Math.cos(t * 0.25 + i * 0.3) * 20);
      b.update(dt, 1.5);
      b.mat.uniforms.uIntensity.value = b.baseIntensity * (0.7 + 0.3 * Math.sin(t * 1.3 + i) + ex);
    });
    this.beams.side.forEach((b, i) => {
      if (car && (focus || i % 2 === 0)) b.target.set(car.x, car.y, car.z);
      else b.target.set(Math.sin(t * 0.5 + i) * 60, 0, Math.cos(t * 0.4 + i * 2) * 50 + 10);
      b.update(dt, 1.8);
      b.mat.uniforms.uIntensity.value = b.baseIntensity * (1 + ex);
    });
    this.beams.sweep.forEach((b, i) => {
      b.target.set(b.origin.x + Math.sin(t * 0.33 + i * 1.7) * 26, 0, b.origin.z + 12 + Math.cos(t * 0.29 + i * 2.1) * 26);
      b.update(dt, 1.2);
      const l = this.sweepLights[i];
      l.target.position.copy(b.aim);
      l.target.updateMatrixWorld();
    });
    if (car) {
      this.followBeam.target.copy(car);
      this.followBeam.update(dt, 6);
      const d = this.followBeam.origin.distanceTo(this.followBeam.aim);
      const ang = Math.atan(5.5 / d);
      this.followLight.angle = ang;
      this.followLight.intensity = 1.7 * d * d; // constant key light on the car wherever it is
      this.followBeam.mesh.scale.set(Math.tan(ang) * 160, Math.tan(ang) * 160, 160);
      this.followLight.target.position.copy(this.followBeam.aim);
      this.followLight.target.updateMatrixWorld();
    }
    // lasers
    const laserOn = look === 2 || ex > 0.6 || (look === 0 && Math.sin(t * 0.9) > 0.3);
    this.beams.lasers.forEach((b, i) => {
      const g = Math.floor(i / 9), k = (i % 9) / 8 - 0.5;
      const yaw = k * 1.1 + Math.sin(t * 0.8 + g * 2) * 0.35;
      const pitch = 0.03 + Math.sin(t * 1.4 + g) * 0.06;
      b.target.set(b.origin.x - Math.sin(yaw) * 100, b.origin.y + pitch * 100, b.origin.z - Math.cos(yaw) * 100);
      b.update(dt, 8);
      b.mat.uniforms.uIntensity.value = laserOn ? 1.2 + pulse * 0.8 : 0;
      b.mesh.visible = laserOn;
    });

    // blinders + LED pulses
    const blind = ex > 0.3 ? pulse * ex * 14 : 0;
    this.blinderMat.color.setRGB(blind, blind * 0.95, blind * 0.85);
    const ledK = 0.7 + pulse * 0.6;
    this.stageLedMat.color.setRGB(0.25 * ledK * 1.2, 0.55 * ledK * 1.2, 6 * ledK);
    this.stripMat.color.setRGB(0.3 + ex, 0.5 * ledK, 4 * ledK);
    this.neonMat.color.setRGB(7 + pulse * 2, 0.25, 0.45);
    this.phoneMat.color.setRGB(2.2 + ex * 3, 2.4 + ex * 3, 3 + ex * 3);

    // objective markers
    const pk = 0.5 + 0.5 * Math.sin(t * 4);
    this.padMat.color.setRGB(0.45 + (this.padActive ? 1.2 * pk : 0), 0.65 + (this.padActive ? 1.2 * pk : 0), 1.3 + (this.padActive ? 1.8 * pk : 0));
    for (let i = 0; i < 28; i++) {
      const on = this.padActive ? (Math.sin(i * 0.9 - t * 10) > 0.2 ? 8 : 1) : 2;
      this.padLights.setColorAt(i, _c.setRGB(on * 0.6, on * 0.8, on * 1.4));
    }
    this.padLights.instanceColor.needsUpdate = true;
    this.parkMat.color.setRGB(0.4 + (this.parkActive ? pk : 0), 0.5 + (this.parkActive ? pk : 0), 1 + (this.parkActive ? 2 * pk : 0));
    const gk = this.gateActive ? 3 + pk * 6 : 2;
    this.gateLedMat.color.setRGB(0.4 * gk / 3, 0.6 * gk / 3, gk * 1.6);

    for (const r of this.rings) r.update(t, dt);
  }
}
const _c = new THREE.Color();
