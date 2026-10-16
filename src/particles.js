import * as THREE from 'three';

const vertexShader = /* glsl */ `
  attribute vec3 aPos;
  attribute vec4 aData; // size, rotation, alpha, -
  attribute vec3 aColor;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vY;
  varying float vDepth;
  void main() {
    vUv = uv;
    float c = cos(aData.y), s = sin(aData.y);
    vec2 p = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aData.x;
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 wp = aPos + right * p.x + up * p.y;
    vY = wp.y;
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
    vAlpha = aData.z;
    vColor = aColor;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uRim;
  uniform float uSoft;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uAdditive;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vY;
  varying float vDepth;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    float a = t.a * vAlpha * smoothstep(0.0, uSoft, vY) * smoothstep(0.8, 4.0, vDepth);
    if (a < 0.002) discard;
    float lum = max(max(vColor.r, vColor.g), vColor.b);
    vec3 col = mix(uRim * lum, vColor, smoothstep(0.1, 0.85, t.a)) * (0.65 + 0.35 * t.r);
    float f = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
    if (uAdditive > 0.5) {
      gl_FragColor = vec4(col * a * (1.0 - f), 0.0);
    } else {
      col = mix(col, uFogColor, f);
      gl_FragColor = vec4(col * a, a);
    }
  }
`;

// CPU-simulated, GPU-billboarded particles. Premultiplied alpha so the same shader can do
// both normal (sorted) and additive blending.
export class Particles {
  constructor(max, texture, { additive = false, rim = new THREE.Color(1, 0.12, 0.2), soft = 0.8, fog, groundFn, sort = !additive } = {}) {
    this.max = max;
    this.sort = sort;
    this.groundFn = groundFn || (() => 0);
    this.head = 0;
    const f = () => new Float32Array(max);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f();
    this.s0 = f(); this.s1 = f(); this.rot = f(); this.rotV = f();
    this.a0 = f(); this.r = f(); this.g = f(); this.b = f();
    this.drag = f(); this.buoy = f(); this.splash = new Uint8Array(max);
    this.life.fill(0);
    this.age.fill(1);
    this.order = new Uint32Array(max);
    this.depth = new Float32Array(max);

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    for (const a of [this.aPos, this.aData, this.aColor]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aData', this.aData);
    geo.setAttribute('aColor', this.aColor);
    geo.instanceCount = 0;
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uRim: { value: rim },
        uSoft: { value: soft },
        uFogColor: { value: fog ? fog.color : new THREE.Color(0, 0, 0) },
        uFogDensity: { value: fog ? fog.density : 0 },
        uAdditive: { value: additive ? 1 : 0 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 4;
  }

  spawn(x, y, z, vx, vy, vz, o) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = o.life;
    this.s0[i] = o.size0;
    this.s1[i] = o.size1;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.rotV[i] = (Math.random() - 0.5) * (o.spin ?? 1);
    this.a0[i] = o.alpha;
    const c = o.color;
    this.r[i] = c[0]; this.g[i] = c[1]; this.b[i] = c[2];
    this.drag[i] = o.drag ?? 1;
    this.buoy[i] = o.buoy ?? 0;
    this.splash[i] = o.splash ? 1 : 0;
  }

  clear() {
    this.age.fill(1);
    this.life.fill(0);
  }

  update(dt, camera) {
    const cam = camera.position;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) continue;
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k;
      this.vy[i] += this.buoy[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      const gy = this.groundFn(this.px[i], this.pz[i]) + 0.12;
      if (this.py[i] < gy) {
        this.py[i] = gy;
        if (this.splash[i] && this.vy[i] < 0) {
          // jet hits the floor: spread radially
          const sp = -this.vy[i] * 0.8;
          let hx = this.vx[i], hz = this.vz[i];
          let l = Math.hypot(hx, hz);
          if (l < 0.3) { const a = Math.random() * Math.PI * 2; hx = Math.cos(a); hz = Math.sin(a); l = 1; }
          this.vx[i] += (hx / l) * sp;
          this.vz[i] += (hz / l) * sp;
          this.splash[i] = 0;
        }
        this.vy[i] = Math.max(this.vy[i], 0);
      }
      this.rot[i] += this.rotV[i] * dt;
      this.order[n] = i;
      this.depth[i] = (this.px[i] - cam.x) * dir.x + (this.py[i] - cam.y) * dir.y + (this.pz[i] - cam.z) * dir.z;
      n++;
    }
    const ord = this.order.subarray(0, n);
    if (this.sort && n > 1) {
      const depth = this.depth;
      ord.sort((a, b) => depth[b] - depth[a]);
    }
    const P = this.aPos.array, D = this.aData.array, C = this.aColor.array;
    for (let j = 0; j < n; j++) {
      const i = ord[j];
      const t = this.age[i] / this.life[i];
      const grow = 1 - (1 - t) * (1 - t);
      P[j * 3] = this.px[i]; P[j * 3 + 1] = this.py[i]; P[j * 3 + 2] = this.pz[i];
      D[j * 4] = this.s0[i] + (this.s1[i] - this.s0[i]) * grow;
      D[j * 4 + 1] = this.rot[i];
      D[j * 4 + 2] = this.a0[i] * Math.min(1, this.age[i] / 0.08) * Math.pow(1 - t, 1.4);
      C[j * 3] = this.r[i]; C[j * 3 + 1] = this.g[i]; C[j * 3 + 2] = this.b[i];
    }
    this.geometry.instanceCount = n;
    this.aPos.needsUpdate = this.aData.needsUpdate = this.aColor.needsUpdate = true;
    this.aPos.clearUpdateRanges?.();
    this.count = n;
  }
}
