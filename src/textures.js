import * as THREE from 'three';
import { rng, clamp, smoothstep } from './util.js';

// Tileable value noise on a size x size grid with `cells` lattice cells per side.
function tileNoise(size, cells, seed) {
  const r = rng(seed);
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
    const y1 = (y0 + 1) % cells;
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
      const x1 = (x0 + 1) % cells;
      const a = lat[y0 * cells + x0], b = lat[y0 * cells + x1];
      const c = lat[y1 * cells + x0], d = lat[y1 * cells + x1];
      const top = a + (b - a) * sx, bot = c + (d - c) * sx;
      out[y * size + x] = top + (bot - top) * sy;
    }
  }
  return out;
}

export function fbm(size, baseCells, octaves, seed, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = Math.min(baseCells << o, size);
    const n = tileNoise(size, cells, seed + o * 101);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function dataTexture(data, size, { srgb = false, repeat = true, aniso = 1 } = {}) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = aniso;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Asphalt floor: fine grain albedo + normal map, and a large-scale "wetness" map.
// wet.r = wetness (puddle patches), wet.g = roughness, wet.b = grain
export function makeFloorTextures(aniso) {
  const S = 512;
  const g = fbm(S, 8, 6, 11);
  const r = rng(5);
  const height = new Float32Array(S * S);
  const albedo = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const v = clamp((g[i] - 0.5) * 2.2 + 0.5, 0, 1);
    const sp = r();
    const pebble = sp > 0.92 ? (sp - 0.92) * 7 : 0;
    height[i] = v * 0.45 + pebble + r() * 0.18;
    const c = 40 + v * 26 + pebble * 60;
    albedo[i * 4] = c;
    albedo[i * 4 + 1] = c * 1.02;
    albedo[i * 4 + 2] = Math.min(255, c * 1.12);
    albedo[i * 4 + 3] = 255;
  }
  const nrm = new Uint8Array(S * S * 4);
  const k = 2.2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const xl = y * S + ((x - 1 + S) % S), xr = y * S + ((x + 1) % S);
      const yu = ((y - 1 + S) % S) * S + x, yd = ((y + 1) % S) * S + x;
      const nx = -(height[xr] - height[xl]) * k;
      const ny = -(height[yd] - height[yu]) * k;
      const l = Math.hypot(nx, ny, 1);
      nrm[i * 4] = (nx / l * 0.5 + 0.5) * 255;
      nrm[i * 4 + 1] = (ny / l * 0.5 + 0.5) * 255;
      nrm[i * 4 + 2] = (1 / l * 0.5 + 0.5) * 255;
      nrm[i * 4 + 3] = 255;
    }
  }

  const W = 256;
  const w = fbm(W, 4, 5, 23);
  const g2 = fbm(W, 16, 3, 77);
  const wet = new Uint8Array(W * W * 4);
  for (let i = 0; i < W * W; i++) {
    const wv = smoothstep(0.47, 0.6, w[i]);
    const rough = 0.66 - wv * 0.5 + (g2[i] - 0.5) * 0.12;
    wet[i * 4] = wv * 255;
    wet[i * 4 + 1] = clamp(rough, 0.06, 1) * 255;
    wet[i * 4 + 2] = g2[i] * 255;
    wet[i * 4 + 3] = 255;
  }

  return {
    albedo: dataTexture(albedo, S, { srgb: true, aniso }),
    normal: dataTexture(nrm, S, { aniso }),
    wet: dataTexture(wet, W, { aniso }),
  };
}

// Billowy smoke puff: rgb = shading, a = density
export function makeSmokeTexture() {
  const S = 128;
  const n = fbm(S, 4, 5, 3);
  const n2 = fbm(S, 8, 3, 9);
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const dx = ((x + 0.5) / S) * 2 - 1, dy = ((y + 0.5) / S) * 2 - 1;
      const d = Math.hypot(dx, dy);
      const fall = clamp(1 - d, 0, 1);
      const dens = fall * fall * (3 - 2 * fall);
      const turb = (n[i] - 0.5) * 2.2 + (n2[i] - 0.5) * 0.8;
      let a = clamp(dens * 1.35 + turb * 0.6 * dens - 0.12, 0, 1);
      a = a * a * (3 - 2 * a);
      const lum = clamp(0.7 + (n[i] - 0.5) * 0.9 + (1 - d) * 0.18, 0, 1);
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = lum * 255;
      data[i * 4 + 3] = a * 255;
    }
  }
  return dataTexture(data, S, { repeat: false });
}

export function makeGlowTexture() {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const dx = ((x + 0.5) / S) * 2 - 1, dy = ((y + 0.5) / S) * 2 - 1;
      const d = Math.hypot(dx, dy);
      const a = clamp(Math.exp(-d * d * 5) - 0.01, 0, 1) * clamp(1 - d, 0, 1);
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
      data[i * 4 + 3] = a * 255;
    }
  }
  return dataTexture(data, S, { repeat: false });
}

export function makeBlobShadowTexture() {
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const dx = ((x + 0.5) / S) * 2 - 1, dy = ((y + 0.5) / S) * 2 - 1;
      const d = Math.pow(Math.pow(Math.abs(dx), 2.6) + Math.pow(Math.abs(dy), 2.6), 1 / 2.6);
      const a = 1 - smoothstep(0.35, 1.0, d);
      data[i * 4 + 3] = a * 255;
    }
  }
  return dataTexture(data, S, { repeat: false });
}

function canvasTexture(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function makePadTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.translate(512, 512);
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  const ring = (r, w, dash) => {
    g.beginPath();
    g.setLineDash(dash || []);
    g.lineWidth = w;
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.stroke();
  };
  ring(496, 12);
  ring(462, 4);
  ring(380, 22, [46, 34]);
  ring(150, 10);
  g.setLineDash([]);
  g.lineWidth = 8;
  for (let a = 0; a < 4; a++) {
    g.save();
    g.rotate((a * Math.PI) / 2);
    g.beginPath();
    g.moveTo(0, 170);
    g.lineTo(0, 340);
    g.stroke();
    // chevrons
    g.beginPath();
    g.moveTo(-40, 410);
    g.lineTo(0, 440);
    g.lineTo(40, 410);
    g.stroke();
    g.restore();
  }
  g.font = '600 120px Rajdhani, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('LAND', 0, 4);
  return canvasTexture(c);
}

export function makeParkTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 1024;
  const g = c.getContext('2d');
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineWidth = 12;
  g.strokeRect(16, 16, 480, 992);
  g.setLineDash([30, 22]);
  g.lineWidth = 6;
  g.strokeRect(56, 56, 400, 912);
  g.setLineDash([]);
  g.font = '700 150px Rajdhani, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  g.translate(256, 512);
  g.rotate(Math.PI);
  g.fillText('PARK', 0, 0);
  g.restore();
  return canvasTexture(c);
}

// Aero turbine wheel cover
export function makeWheelTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.translate(256, 256);
  const grd = g.createRadialGradient(0, 0, 10, 0, 0, 256);
  grd.addColorStop(0, '#22252b');
  grd.addColorStop(0.8, '#15171b');
  grd.addColorStop(1, '#3a3e46');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(0, 0, 256, 0, Math.PI * 2);
  g.fill();
  // turbine blades
  for (let i = 0; i < 10; i++) {
    g.save();
    g.rotate((i / 10) * Math.PI * 2);
    const bl = g.createLinearGradient(0, 40, 0, 240);
    bl.addColorStop(0, '#5a606a');
    bl.addColorStop(1, '#2b2f36');
    g.fillStyle = bl;
    g.beginPath();
    g.moveTo(-14, 60);
    g.quadraticCurveTo(40, 150, 30, 236);
    g.lineTo(62, 232);
    g.quadraticCurveTo(70, 140, 16, 58);
    g.closePath();
    g.fill();
    g.restore();
  }
  g.fillStyle = '#0c0d10';
  g.beginPath();
  g.arc(0, 0, 62, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#6b717c';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(0, 0, 58, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 10;
  g.strokeStyle = '#4a4f58';
  g.beginPath();
  g.arc(0, 0, 250, 0, Math.PI * 2);
  g.stroke();
  return canvasTexture(c);
}
