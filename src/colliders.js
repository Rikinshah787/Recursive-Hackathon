import * as THREE from 'three';

// Signed-distance collision world. The vehicle raycasts its wheels by sphere tracing and checks its
// body probes against the combined SDF, so it can drive on any surface (walls, loops, ramps).

const _n = new THREE.Vector3();
const _p = new THREE.Vector3();

// Profile segments in a ramp's local 2D frame: u = along the approach direction, y = up.
// Arcs are concave (free space towards the centre); lines carry an explicit free-side normal.
export const arc = (cu, cy, r, a0, a1) => ({ type: 'arc', cu, cy, r, a0, a1 });
export const line = (u0, y0, u1, y1, nu, ny) => ({ type: 'line', u0, y0, u1, y1, nu, ny });

const cp = { u: 0, y: 0, nu: 0, ny: 0, d2: 0 };

function closest(seg, u, y, out) {
  if (seg.type === 'line') {
    const du = seg.u1 - seg.u0, dy = seg.y1 - seg.y0;
    let t = ((u - seg.u0) * du + (y - seg.y0) * dy) / (du * du + dy * dy);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out.u = seg.u0 + du * t;
    out.y = seg.y0 + dy * t;
    out.nu = seg.nu;
    out.ny = seg.ny;
  } else {
    const lo = Math.min(seg.a0, seg.a1), hi = Math.max(seg.a0, seg.a1);
    let a = Math.atan2(y - seg.cy, u - seg.cu);
    if (a < lo - 1e-9 || a > hi + 1e-9) {
      // pick whichever end of the arc is nearer
      const u0 = seg.cu + seg.r * Math.cos(lo), y0 = seg.cy + seg.r * Math.sin(lo);
      const u1 = seg.cu + seg.r * Math.cos(hi), y1 = seg.cy + seg.r * Math.sin(hi);
      a = (u - u0) ** 2 + (y - y0) ** 2 < (u - u1) ** 2 + (y - y1) ** 2 ? lo : hi;
    }
    out.u = seg.cu + seg.r * Math.cos(a);
    out.y = seg.cy + seg.r * Math.sin(a);
    out.nu = -Math.cos(a);
    out.ny = -Math.sin(a);
  }
  out.d2 = (u - out.u) ** 2 + (y - out.y) ** 2;
}

// Points along the riding surface in travel order: { u, y, nu, ny, s } (s = arc length)
export function sampleProfile(segments, step = 0.25) {
  const pts = [];
  let s = 0, last = null;
  const push = (u, y, nu, ny) => {
    if (last) {
      const d = Math.hypot(u - last.u, y - last.y);
      if (d < 1e-6) return;
      s += d;
    }
    last = { u, y, nu, ny, s };
    pts.push(last);
  };
  for (const seg of segments) {
    if (seg.type === 'line') {
      const len = Math.hypot(seg.u1 - seg.u0, seg.y1 - seg.y0);
      const n = Math.max(1, Math.ceil(len / step));
      for (let i = 0; i <= n; i++) push(seg.u0 + ((seg.u1 - seg.u0) * i) / n, seg.y0 + ((seg.y1 - seg.y0) * i) / n, seg.nu, seg.ny);
    } else {
      const n = Math.max(2, Math.ceil((Math.abs(seg.a1 - seg.a0) * seg.r) / step));
      for (let i = 0; i <= n; i++) {
        const a = seg.a0 + ((seg.a1 - seg.a0) * i) / n;
        push(seg.cu + seg.r * Math.cos(a), seg.cy + seg.r * Math.sin(a), -Math.cos(a), -Math.sin(a));
      }
    }
  }
  return pts;
}

// A curved ramp (kicker, quarter-pipe wall, loop): a shell of `thickness` behind a riding profile,
// extruded `width` metres sideways. yaw follows the vehicle heading convention: u-axis = (sin, 0, cos).
export class CurveRamp {
  constructor({ id, origin, yaw, width, thickness = 1, segments }) {
    this.id = id;
    this.origin = origin.clone();
    this.yaw = yaw;
    this.a = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    this.w = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    this.width = width;
    this.T = thickness;
    this.segments = segments;
    const pts = sampleProfile(segments, 0.5);
    const box = new THREE.Box3();
    for (const q of pts) for (const sw of [-1, 1]) box.expandByPoint(this.toWorld(q.u, q.y, (sw * width) / 2, _p));
    box.expandByScalar(thickness + 0.5);
    const c = box.getCenter(new THREE.Vector3());
    this.sphere = { x: c.x, y: c.y, z: c.z, r: box.getSize(_p).length() / 2 };
  }

  toWorld(u, y, w, out) {
    return out.set(
      this.origin.x + this.a.x * u + this.w.x * w,
      this.origin.y + y,
      this.origin.z + this.a.z * u + this.w.z * w,
    );
  }

  // world direction from local (u, y, w) components
  dirToWorld(nu, ny, nw, out) {
    return out.set(this.a.x * nu + this.w.x * nw, ny, this.a.z * nu + this.w.z * nw);
  }

  sdf(p, out) {
    const rx = p.x - this.origin.x, ry = p.y - this.origin.y, rz = p.z - this.origin.z;
    const u = rx * this.a.x + rz * this.a.z;
    const w = rx * this.w.x + rz * this.w.z;
    const y = ry;
    let best = Infinity, bu = 0, by = 0, bnu = 0, bny = 1;
    for (const s of this.segments) {
      closest(s, u, y, cp);
      if (cp.d2 < best) {
        best = cp.d2; bu = cp.u; by = cp.y; bnu = cp.nu; bny = cp.ny;
      }
    }
    const dist = Math.sqrt(best);
    const du = u - bu, dy = y - by;
    const side = du * bnu + dy * bny >= 0 ? 1 : -1;
    let gu = bnu, gy = bny;
    if (dist > 1e-5) {
      gu = (du / dist) * side;
      gy = (dy / dist) * side;
    }
    const h = this.T / 2;
    const k = side * dist + h >= 0 ? 1 : -1;
    const d2 = Math.abs(side * dist + h) - h;
    gu *= k;
    gy *= k;
    const dw = Math.abs(w) - this.width / 2;
    const sw = w >= 0 ? 1 : -1;
    let d, nu = gu, ny = gy, nw = 0;
    if (d2 > 0 && dw > 0) {
      d = Math.hypot(d2, dw);
      nu = (gu * d2) / d;
      ny = (gy * d2) / d;
      nw = (sw * dw) / d;
    } else if (dw > d2) {
      d = dw;
      nu = 0; ny = 0; nw = sw;
    } else d = d2;
    this.dirToWorld(nu, ny, nw, out);
    return d;
  }
}

// Oriented box (rotation about Y only, same convention as Object3D.rotation.y)
export class Box {
  constructor({ id, center, half, yaw = 0 }) {
    this.id = id;
    this.c = center.clone();
    this.h = half.clone();
    this.cos = Math.cos(yaw);
    this.sin = Math.sin(yaw);
    this.sphere = { x: center.x, y: center.y, z: center.z, r: half.length() };
  }

  sdf(p, out) {
    const rx = p.x - this.c.x, ry = p.y - this.c.y, rz = p.z - this.c.z;
    const qx = rx * this.cos - rz * this.sin;
    const qz = rx * this.sin + rz * this.cos;
    const qy = ry;
    const dx = Math.abs(qx) - this.h.x, dy = Math.abs(qy) - this.h.y, dz = Math.abs(qz) - this.h.z;
    const ox = Math.max(dx, 0), oy = Math.max(dy, 0), oz = Math.max(dz, 0);
    const ol = Math.hypot(ox, oy, oz);
    let lx, ly, lz, d;
    if (ol > 0) {
      d = ol;
      lx = (ox * Math.sign(qx)) / ol; ly = (oy * Math.sign(qy)) / ol; lz = (oz * Math.sign(qz)) / ol;
    } else {
      d = Math.max(dx, dy, dz);
      lx = ly = lz = 0;
      if (d === dx) lx = Math.sign(qx) || 1;
      else if (d === dy) ly = Math.sign(qy) || 1;
      else lz = Math.sign(qz) || 1;
    }
    // local -> world (inverse of the rotation above)
    out.set(lx * this.cos + lz * this.sin, ly, -lx * this.sin + lz * this.cos);
    return d;
  }
}

export class World {
  constructor(arena) {
    this.arena = arena;
    this.bounds = arena.bounds;
    this.colliders = [];
    this.lastId = 'ground';
    this.hitId = 'ground';
  }

  height(x, z) {
    return this.arena.height(x, z);
  }

  normal(x, z, out) {
    return this.arena.normal(x, z, out);
  }

  add(c) {
    this.colliders.push(c);
    return c;
  }

  sdf(p, out) {
    let best = p.y - this.arena.height(p.x, p.z);
    let id = 'ground';
    for (const c of this.colliders) {
      const s = c.sphere;
      const dc = Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) - s.r;
      if (dc > best) continue;
      const d = c.sdf(p, _n);
      if (d < best) {
        best = d;
        out.copy(_n);
        id = c.id;
      }
    }
    if (id === 'ground') this.arena.normal(p.x, p.z, out);
    this.lastId = id;
    return best;
  }

  // Sphere-traced ray cast. Returns hit distance (0 if starting inside) or Infinity.
  raycast(origin, dir, maxT, outN) {
    let t = 0;
    for (let i = 0; i < 40; i++) {
      _p.copy(origin).addScaledVector(dir, t);
      const d = this.sdf(_p, outN);
      if (d < 0.004) {
        this.hitId = this.lastId;
        return t;
      }
      t += Math.max(d * 0.92, 0.002);
      if (t > maxT) return Infinity;
    }
    return Infinity;
  }
}
