import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import { Arena, LAYOUT } from './environment.js';
import { World, Box } from './colliders.js';
import { StuntPark, STUNTS } from './stunts.js';
import { buildCar, CAR } from './car.js';
import { Vehicle } from './physics.js';
import { Particles } from './particles.js';
import { CameraRig, CAMERA_LABELS } from './camera.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { HUD } from './hud.js';
import { Game } from './game.js';
import { ClipRecorder } from './recorder.js';
import { makeSmokeTexture, makeGlowTexture, makeBlobShadowTexture } from './textures.js';
import { rng, clamp, damp, formatViews } from './util.js';

const QUALITY = {
  ultra: { pr: 2, reflect: 0.6, shadow: 4096, samples: 4, bloom: 1 },
  high: { pr: 1.5, reflect: 0.5, shadow: 2048, samples: 4, bloom: 1 },
  medium: { pr: 1, reflect: 0.35, shadow: 1024, samples: 2, bloom: 0.75 },
  low: { pr: 0.75, reflect: 0, shadow: 512, samples: 0, bloom: 0.5 },
};
const QUALITY_ORDER = ['ultra', 'high', 'medium', 'low'];

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.035 },
    uCA: { value: 0.0015 },
    uCine: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uRes;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uCA;
    uniform float uCine;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec2 off = d * (uCA + uCine * 0.004) * r2 * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      // slow-motion grade: a touch desaturated and contrasty
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, mix(vec3(l), col, 0.8) * 1.06, uCine);
      col *= 1.0 - (uVignette + uCine * 0.2) * smoothstep(0.08, 0.75, r2 * 2.0);
      float g = hash(vUv * uRes + fract(uTime * 13.7) * 100.0) - 0.5;
      col += g * uGrain;
      // cinematic letterbox during stunt shots
      float bar = 0.1 * uCine;
      if (vUv.y < bar || vUv.y > 1.0 - bar) col = vec3(0.0);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// Removes NaN/Inf pixels before bloom (a single bad pixel would otherwise smear into black blocks)
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(min(c.rgb, vec3(40.0)), c.a);
    }
  `,
};

// ------------------------------------------------------------------ setup
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

let qualityName = 'high';
try { qualityName = localStorage.getItem('roadster-quality') || 'high'; } catch { /* ignore */ }
if (!QUALITY[qualityName]) qualityName = 'high';
document.getElementById('quality').value = qualityName;
let Q = QUALITY[qualityName];
renderer.setPixelRatio(Math.min(window.devicePixelRatio, Q.pr));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const FOG = new THREE.FogExp2(0x04050c, 0.0058);
scene.fog = FOG;
scene.background = new THREE.Color(0x04050c);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1500);

const smokeTex = makeSmokeTexture();
const glowTex = makeGlowTexture();
const arena = new Arena(renderer, scene, smokeTex, glowTex);
scene.environment = arena.envMap;
scene.environmentIntensity = 0.9;

const world = new World(arena);
world.add(new Box({ id: 'backdrop', center: new THREE.Vector3(LAYOUT.stage.x, 8, LAYOUT.stage.z - 17), half: new THREE.Vector3(24, 8, 0.5) }));
const car = buildCar(arena.envMap);
scene.add(car.root);
const stunts = new StuntPark(scene, world, car, glowTex);
const vehicle = new Vehicle(world);

// contact shadow
const blob = new THREE.Mesh(
  new THREE.PlaneGeometry(2.6, 5.2),
  new THREE.MeshBasicMaterial({ map: makeBlobShadowTexture(), color: 0x000000, transparent: true, depthWrite: false, opacity: 0.85 }),
);
blob.rotation.order = 'YXZ';
blob.renderOrder = 2;
scene.add(blob);

const groundAt = (x, z) => arena.height(x, z);
const smoke = new Particles(5200, smokeTex, { rim: new THREE.Color(0.95, 0.22, 0.3), soft: 0.9, fog: FOG, groundFn: groundAt });
scene.add(smoke.mesh);
const haze = new Particles(160, smokeTex, { additive: true, soft: 2.5, fog: { color: new THREE.Color(0, 0, 0), density: 0.0035 }, rim: new THREE.Color(0.5, 0.05, 0.1) });
scene.add(haze.mesh);
{
  const r = rng(77);
  for (let i = 0; i < 60; i++) {
    const s = 26 + r() * 30;
    const x = (r() - 0.5) * 250;
    // keep the far-left corner (truck jump) out of the red wash
    haze.spawn(x, 2 + r() * 9, 72 + r() * 26, 0, 0, 0, { life: 1e9, size0: s, size1: s, alpha: x < -40 ? 0.12 : 0.36, color: [0.55, 0.035, 0.07], drag: 0, spin: 0.05 });
  }
  for (let i = 0; i < 45; i++) {
    const s = 16 + r() * 18;
    haze.spawn((r() - 0.5) * 220, 1.5 + r() * 4, -50 + r() * 120, 0, 0, 0, { life: 1e9, size0: s, size1: s, alpha: 0.25, color: [0.05, 0.06, 0.13], drag: 0, spin: 0.04 });
  }
  for (let i = 0; i < 14; i++) {
    const s = 12 + r() * 10;
    haze.spawn(LAYOUT.stage.x + (r() - 0.5) * 50, 2 + r() * 5, LAYOUT.stage.z - 8 + (r() - 0.5) * 14, 0, 0, 0, { life: 1e9, size0: s, size1: s, alpha: 0.3, color: [0.04, 0.07, 0.25], drag: 0, spin: 0.04 });
  }
}

const rig = new CameraRig(camera, canvas);
const input = new Input();
const audio = new AudioEngine();
const hud = new HUD();
const recorder = new ClipRecorder(canvas, audio);

// ------------------------------------------------------------------ post
let composer, bloomPass, gradePass;
function buildComposer() {
  if (composer) composer.dispose();
  const pr = renderer.getPixelRatio();
  const w = window.innerWidth, h = window.innerHeight;
  const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: Q.samples });
  composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new ShaderPass(SanitizeShader));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w * Q.bloom, h * Q.bloom), 0.55, 0.42, 1.6);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
  gradePass = new ShaderPass(GradeShader);
  gradePass.uniforms.uRes.value.set(w * pr, h * pr);
  composer.addPass(gradePass);
}

function applyQuality(name, announce) {
  qualityName = name;
  Q = QUALITY[name];
  try { localStorage.setItem('roadster-quality', name); } catch { /* ignore */ }
  document.getElementById('quality').value = name;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, Q.pr));
  renderer.setSize(window.innerWidth, window.innerHeight);
  arena.followLight.shadow.mapSize.set(Q.shadow, Q.shadow);
  if (arena.followLight.shadow.map) {
    arena.followLight.shadow.map.dispose();
    arena.followLight.shadow.map = null;
  }
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  arena.setReflectionScale(size.x, size.y, Q.reflect);
  buildComposer();
  if (announce) hud.toast(`GRAPHICS: ${name.toUpperCase()}`);
}
applyQuality(qualityName, false);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  arena.setReflectionScale(size.x, size.y, Q.reflect);
  gradePass.uniforms.uRes.value.set(size.x, size.y);
});

// ------------------------------------------------------------------ cinematic effects (used by the game)
let timeScale = 1, slowTimer = 0, cine = 0, cineTimer = 0;
let cinematic = true;

function burst(group, strength = 1) {
  const list = group && STUNTS[group] ? STUNTS[group].cannons : [];
  for (const [x, z] of list) {
    const n = Math.round(46 * strength);
    for (let i = 0; i < n; i++) {
      const sp = 13 + Math.random() * 10;
      smoke.spawn(x + (Math.random() - 0.5) * 0.3, 0.95, z + (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 2.4, sp, (Math.random() - 0.5) * 2.4,
        { life: 1.3 + Math.random() * 0.9, size0: 0.5, size1: 4 + Math.random() * 2.5, alpha: 0.42, color: [1.15, 1.16, 1.22], drag: 1.7, buoy: 0.4, spin: 0.8 });
    }
  }
  if (list.length) audio.boom();
}

const fx = {
  slowmo(dur) {
    if (!cinematic) return;
    slowTimer = Math.max(slowTimer, dur);
  },
  action(pos, dur) {
    if (!cinematic) return;
    rig.action(pos, dur);
    cineTimer = Math.max(cineTimer, dur);
  },
  burst,
  card(top, title, sub) {
    hud.card(top, title, sub);
  },
};

// ------------------------------------------------------------------ game + UI
const screens = {
  title: document.getElementById('title'),
  pause: document.getElementById('pause'),
  results: document.getElementById('results'),
};
const showScreen = (name) => {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== name);
};

const game = new Game({
  vehicle, arena, stunts, hud, audio, rig, fx,
  onFinish: (r) => {
    lastFinishedMode = r.mode;
    document.getElementById('res-title').textContent = r.mode === 'stunt' ? 'STUNT TOUR COMPLETE' : 'SHOW COMPLETE';
    document.getElementById('grade').textContent = r.grade;
    document.getElementById('res-views').textContent = `▶ ${formatViews(r.views)} VIEWS${r.views > 5e6 ? ' · GONE VIRAL' : ''}`;
    document.getElementById('res-time').textContent = `${r.time.toFixed(1)} s`;
    document.getElementById('res-tricks').textContent = r.tricks.toLocaleString();
    document.getElementById('res-bonus').textContent = r.bonus.toLocaleString();
    document.getElementById('res-total').textContent = r.total.toLocaleString();
    document.getElementById('res-best').textContent = r.isBest ? 'NEW BEST!' : `BEST ${r.best.toLocaleString()}`;
    setTimeout(() => { if (game.state === 'results') { showScreen('results'); hud.show(false); } }, 1800);
    updateBest();
  },
});

let assist = true;
let phoneFrame = false;
let phoneTime = 0;
let paused = false;
let lastFinishedMode = 'stunt';

function updateBest() {
  let best = 0, bestStunt = 0;
  try {
    best = Number(localStorage.getItem('roadster-best') || 0);
    bestStunt = Number(localStorage.getItem('roadster-best-stunt') || 0);
  } catch { /* ignore */ }
  const parts = [];
  if (bestStunt) parts.push(`TOUR ${bestStunt.toLocaleString()}`);
  if (best) parts.push(`SHOW ${best.toLocaleString()}`);
  document.getElementById('best').textContent = parts.length ? `BEST ${parts.join(' · ')}` : '';
}
updateBest();

function startMode(mode) {
  audio.init();
  showScreen(null);
  paused = false;
  slowTimer = 0;
  cineTimer = 0;
  rig.actionTimer = 0;
  hud.fade(true);
  setTimeout(() => {
    smoke.clear();
    game.start(mode);
    rig.setMode(rig.mode === 'spectator' && !phoneFrame ? 'chase' : rig.mode);
    hud.show(true);
    hud.setHelp(true);
    hud.setCamera(CAMERA_LABELS[rig.mode]);
    hud.setAssist(assist);
    hud.fade(false);
    setTimeout(() => hud.setHelp(false), 8000);
  }, 450);
}

function setPaused(p) {
  if (!['play', 'countdown', 'card'].includes(game.state)) return;
  paused = p;
  showScreen(p ? 'pause' : null);
  if (audio.ctx) p ? audio.ctx.suspend() : audio.ctx.resume();
}

function toTitle() {
  paused = false;
  if (recorder.recording) recorder.stop();
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  game.mode = 'attract';
  game.state = 'title';
  hud.show(false);
  hud.setPhone(false);
  hud.card(null);
  phoneFrame = false;
  document.body.classList.remove('phone-mode');
  hud.countdown('');
  stunts.setActive(null);
  vehicle.reset(new THREE.Vector3(LAYOUT.spawnStage.x, 0, LAYOUT.spawnStage.z), 0.5);
  game.syncMarkers();
  showScreen('title');
}

document.getElementById('btn-stunt').onclick = () => startMode('stunt');
document.getElementById('btn-show').onclick = () => startMode('show');
document.getElementById('btn-free').onclick = () => startMode('free');
document.getElementById('btn-resume').onclick = () => setPaused(false);
document.getElementById('btn-restart').onclick = () => startMode(game.mode);
document.getElementById('btn-quit').onclick = toTitle;
document.getElementById('btn-retry').onclick = () => startMode(lastFinishedMode);
document.getElementById('btn-tofree').onclick = () => startMode('free');
document.getElementById('btn-totitle').onclick = toTitle;
document.getElementById('btn-assist').onclick = () => {
  assist = !assist;
  document.getElementById('assist-label').textContent = `FLIGHT ASSIST: ${assist ? 'ON' : 'OFF'}`;
  hud.setAssist(assist);
};
document.getElementById('btn-cine').onclick = () => {
  cinematic = !cinematic;
  document.getElementById('cine-label').textContent = `SLOW-MO SHOTS: ${cinematic ? 'ON' : 'OFF'}`;
};
document.getElementById('btn-music').onclick = () => {
  audio.setMusic(!audio.musicOn);
  document.getElementById('music-label').textContent = `MUSIC: ${audio.musicOn ? 'ON' : 'OFF'}`;
};
document.getElementById('quality').onchange = (e) => applyQuality(e.target.value, false);

// ------------------------------------------------------------------ effects
const _v = new THREE.Vector3(), _u = new THREE.Vector3(), _w = new THREE.Vector3();
const nozzleLocal = CAR.nozzles.map((n) => n.clone().setY(n.y - CAR.comY));
const gripPorts = [[0.72, 0.5, 1.1], [-0.72, 0.5, 1.1], [0.72, 0.55, -1.2], [-0.72, 0.55, -1.2]].map(([x, y, z]) => new THREE.Vector3(x, y, z));
const emitAcc = { jets: [0, 0, 0, 0], ground: 0, tires: [0, 0, 0, 0], rcs: 0, grip: 0 };
const neutralInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, lift: 0, pitch: 0, roll: 0, assist: true };

function syncCar(dt, time) {
  const v = vehicle;
  car.root.position.copy(v.renderPos);
  car.root.quaternion.copy(v.renderQuat);
  v.wheels.forEach((w, i) => {
    const wm = car.wheels[i];
    wm.pivot.position.set(w.anchor.x, w.anchor.y - w.susp + CAR.comY, w.anchor.z);
    wm.pivot.rotation.y = -w.steer;
    wm.spin.rotation.x = w.spin;
  });
  const cmd = v.thrustCmd;
  const base = v.thrust;
  CAR.nozzles.forEach((n, i) => {
    let p = base > 0.01 ? base * 1.25 : 0;
    if (base > 0.01) p += (n.z < 0 ? 1 : -1) * cmd.x * 0.35 + Math.sign(n.x) * cmd.z * 0.35;
    p = clamp(p, 0, 1.6);
    const jet = car.jets[i];
    jet.power = p;
    jet.mat.uniforms.uPower.value = p * 0.55;
    jet.mat.uniforms.uTime.value = time;
    jet.mesh.scale.set(1, 0.3 + p * 0.85, 1);
    jet.mesh.visible = p > 0.01;
    jet.coreMat.color.setRGB(p * 3, p * 3.4, p * 4.2);
  });
  car.underGlow.intensity = base * 220;
  const brake = v.brakeLight;
  car.rearBarMat.color.setRGB(3.2 + brake * 6, 0.03 + brake * 0.05, 0.06 + brake * 0.08);

  const alt = Math.max(0, v.altitude);
  const gh = arena.height(v.renderPos.x, v.renderPos.z);
  blob.position.set(v.renderPos.x, gh + 0.02, v.renderPos.z);
  _v.set(0, 0, 1).applyQuaternion(v.renderQuat);
  blob.rotation.set(-Math.PI / 2, 0, 0);
  blob.rotation.y = Math.atan2(_v.x, _v.z);
  const s = 1 + alt * 0.12;
  blob.scale.set(s, s, 1);
  blob.material.opacity = clamp(0.9 - alt * 0.09, 0, 0.9) * (v.contactNormal.y > 0.7 || v.airborne ? 1 : 0);
}

function emitEffects(dt) {
  const v = vehicle;
  const up = _u.set(0, 1, 0).applyQuaternion(v.renderQuat);
  const vel = v.vel;
  // thruster vapour
  car.jets.forEach((jet, i) => {
    const p = jet.power || 0;
    if (p < 0.02) return;
    emitAcc.jets[i] += dt * 110 * p;
    while (emitAcc.jets[i] >= 1) {
      emitAcc.jets[i] -= 1;
      const pos = _v.copy(nozzleLocal[i]).applyQuaternion(v.renderQuat).add(v.renderPos);
      const sp = 20 + Math.random() * 9;
      const j = 1.6;
      smoke.spawn(pos.x, pos.y, pos.z,
        vel.x - up.x * sp + (Math.random() - 0.5) * j, vel.y - up.y * sp + (Math.random() - 0.5) * j, vel.z - up.z * sp + (Math.random() - 0.5) * j,
        { life: 0.5 + Math.random() * 0.4, size0: 0.25, size1: 2.6 + Math.random(), alpha: 0.42, color: [1.05, 1.08, 1.15], drag: 2.2, buoy: 0.4, splash: true, spin: 1.6 });
    }
  });
  // wall grip: side jets blast away from the wall and press the car onto it
  if (v.wallGrip > 0.2) {
    emitAcc.grip += dt * 70 * Math.min(1, v.wallGrip);
    while (emitAcc.grip >= 1) {
      emitAcc.grip -= 1;
      const port = gripPorts[(Math.random() * 4) | 0];
      const pos = _v.copy(port).applyQuaternion(v.renderQuat).add(v.renderPos);
      const sp = 16 + Math.random() * 8;
      smoke.spawn(pos.x, pos.y, pos.z,
        vel.x * 0.6 + up.x * sp + (Math.random() - 0.5) * 2, vel.y * 0.6 + up.y * sp + (Math.random() - 0.5) * 2, vel.z * 0.6 + up.z * sp + (Math.random() - 0.5) * 2,
        { life: 0.45 + Math.random() * 0.3, size0: 0.25, size1: 2.2, alpha: 0.45, color: [1.05, 1.1, 1.2], drag: 2.5, spin: 1.5 });
    }
  }
  // ground billow when hovering low
  const alt = v.altitude;
  if (v.thrust > 0.15 && alt < 5 && up.y > 0.5) {
    emitAcc.ground += dt * 70 * v.thrust * (1 - alt / 5);
    const gh = arena.height(v.pos.x, v.pos.z);
    while (emitAcc.ground >= 1) {
      emitAcc.ground -= 1;
      const a = Math.random() * Math.PI * 2;
      const r = 0.5 + Math.random() * 1.2;
      const sp = 5 + Math.random() * 6;
      smoke.spawn(v.pos.x + Math.cos(a) * r, gh + 0.3, v.pos.z + Math.sin(a) * r * 1.6,
        Math.cos(a) * sp + vel.x * 0.3, 0.4 + Math.random() * 0.8, Math.sin(a) * sp + vel.z * 0.3,
        { life: 1.6 + Math.random() * 1.2, size0: 1.2, size1: 5 + Math.random() * 3, alpha: 0.26, color: [1.05, 1.08, 1.15], drag: 1.3, buoy: 0.3, spin: 0.7 });
    }
  }
  // RCS side puffs during hard rotations
  const cmdMag = v.thrustCmd.length();
  if (v.thrust > 0.01 && cmdMag > 0.4) {
    emitAcc.rcs += dt * 60 * cmdMag;
    while (emitAcc.rcs >= 1) {
      emitAcc.rcs -= 1;
      const sx = Math.random() < 0.5 ? 1 : -1, sz = Math.random() < 0.5 ? 1 : -1;
      const pos = _v.set(sx * 0.95, 0.1, sz * 1.6).applyQuaternion(v.renderQuat).add(v.renderPos);
      const dir = _w.set(sx, (Math.random() - 0.5) * 0.6, sz * 0.3).normalize().applyQuaternion(v.renderQuat);
      const sp = 12 + Math.random() * 6;
      smoke.spawn(pos.x, pos.y, pos.z, vel.x + dir.x * sp, vel.y + dir.y * sp, vel.z + dir.z * sp,
        { life: 0.4 + Math.random() * 0.3, size0: 0.2, size1: 1.8, alpha: 0.5, color: [1.3, 1.35, 1.45], drag: 3, spin: 2 });
    }
  }
  // tyre smoke
  v.wheels.forEach((w, i) => {
    if (!w.contact || w.slip < 0.12) return;
    emitAcc.tires[i] += dt * (v.burnout ? 55 : 45) * w.slip;
    while (emitAcc.tires[i] >= 1) {
      emitAcc.tires[i] -= 1;
      const c = w.contactPoint;
      smoke.spawn(c.x + (Math.random() - 0.5) * 0.4, c.y + 0.35, c.z + (Math.random() - 0.5) * 0.4,
        vel.x * 0.25 + (Math.random() - 0.5) * 2.2, 0.5 + Math.random() * 1.0, vel.z * 0.25 + (Math.random() - 0.5) * 2.2,
        { life: 2.8 + Math.random() * 2.2, size0: 0.8, size1: 5.5 + Math.random() * 3, alpha: 0.24, color: [0.95, 0.96, 1.0], drag: 0.9, buoy: 0.3, spin: 0.6 });
    }
  });
}

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
let frameAvg = 1 / 60, slowTime = 0, elapsed = 0;
let prevState = game.state;
vehicle.reset(new THREE.Vector3(LAYOUT.spawnStage.x, 0, LAYOUT.spawnStage.z), 0.5);

function frame() {
  requestAnimationFrame(frame);
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 1 / 20);
  elapsed += dt;
  const inp = input.poll(dt);

  // slow motion + cinematic grade
  if (slowTimer > 0) slowTimer -= dt;
  if (cineTimer > 0) cineTimer -= dt;
  timeScale = damp(timeScale, slowTimer > 0 ? 0.32 : 1, slowTimer > 0 ? 10 : 4, dt);
  cine = damp(cine, cineTimer > 0 ? 1 : 0, 6, dt);
  audio.setSlowmo(1 - timeScale);
  const simDt = dt * timeScale;

  // global hotkeys
  const playing = ['play', 'countdown', 'card'].includes(game.state);
  if (inp.pause && game.mode !== 'attract') setPaused(!paused);
  if (playing) {
    if (inp.camera) hud.setCamera(CAMERA_LABELS[rig.next()]);
    if (inp.phone) {
      phoneFrame = !phoneFrame;
      hud.setPhone(phoneFrame);
      document.body.classList.toggle('phone-mode', phoneFrame);
      if (phoneFrame && rig.mode !== 'spectator') { rig.setMode('spectator'); hud.setCamera(CAMERA_LABELS.spectator); }
    }
    if (inp.help) hud.toggleHelp();
    if (inp.assistToggle) {
      assist = !assist;
      hud.setAssist(assist);
      hud.toast(assist ? 'FLIGHT ASSIST ON' : 'ACRO MODE — no auto-level');
      document.getElementById('assist-label').textContent = `FLIGHT ASSIST: ${assist ? 'ON' : 'OFF'}`;
    }
    if (inp.clip) {
      if (recorder.recording) {
        recorder.stop();
        hud.toast('CLIP SAVED — check your downloads', 2.5);
      } else if (recorder.start(phoneFrame)) {
        hud.toast(phoneFrame ? 'RECORDING VERTICAL CLIP — K to stop' : 'RECORDING CLIP — K to stop', 2);
      } else {
        hud.toast('CLIP RECORDING NOT SUPPORTED IN THIS BROWSER', 2.5);
      }
    }
  }
  if (inp.mute) {
    audio.setMuted(!audio.muted);
    hud.toast(audio.muted ? 'SOUND OFF' : 'SOUND ON', 1.2);
  }

  if (!paused) {
    const live = game.controlsLive;
    const ctl = live ? { ...inp, assist } : neutralInput;
    if (live) {
      if (inp.flip) vehicle.startTrick('flip');
      if (inp.backflip) vehicle.startTrick('backflip');
      if (inp.barrel) vehicle.startTrick('roll');
    }
    vehicle.lastThrottle = ctl.throttle;
    vehicle.step(ctl, simDt);
    game.update(simDt, inp);
    syncCar(simDt, elapsed);
    emitEffects(simDt);
    const beat = audio.ctx ? audio.beatPhase() : (elapsed * 124 / 60) % 1;
    arena.update(simDt, { carPos: vehicle.renderPos, beat });
    stunts.update(simDt, beat, camera);
    if (game.state !== 'title' && phoneFrame) phoneTime += dt;
  }
  if (prevState === 'card' && game.state === 'play') rig.snap = true;
  prevState = game.state;

  const attract = game.state === 'title' || game.state === 'results' || game.state === 'card';
  rig.update(dt, vehicle, { attract, groundAt });
  smoke.update(paused ? 0 : simDt, camera);
  haze.update(paused ? 0 : simDt, camera);

  if (game.state === 'play' || game.state === 'countdown') {
    const v = vehicle;
    const kmh = v.vel.length() * 3.6;
    hud.setTelemetry(kmh, Math.max(0, v.altitude), v.gas);
    let mode = 'DRIVE', cls = '';
    if (v.trick) { mode = 'TRICK'; cls = 'hot'; }
    else if (v.burnout) { mode = 'BURNOUT'; cls = 'hot'; }
    else if (v.wallGrip > 0.2) { mode = 'WALL RIDE'; cls = 'hot'; }
    else if (v.armed && v.airborne) { mode = 'FLIGHT'; cls = 'fly'; }
    else if (v.armed) { mode = 'HOVER'; cls = 'fly'; }
    else if (v.airborne) { mode = 'AIRBORNE'; cls = 'fly'; }
    if (timeScale < 0.6) { mode = 'SLOW-MO'; cls = 'hot'; }
    hud.setMode(mode, cls);
    const target = game.objectiveTarget();
    hud.setMarker(rig.actionTimer > 0 ? null : target, camera, target ? `${Math.round(target.distanceTo(v.pos))} M` : '');
  } else {
    hud.setMarker(null);
  }
  hud.update(dt, phoneTime, rig.zoom || 1);
  hud.setClip(recorder.recording, recorder.t);
  audio.update(vehicle, dt);
  input.endFrame();

  gradePass.uniforms.uTime.value = elapsed;
  gradePass.uniforms.uCine.value = cine;
  composer.render(dt);
  recorder.frame(dt, hud.recent, game.views);

  // adaptive quality: step down if we can't hold ~40fps
  frameAvg += (rawDt - frameAvg) * 0.05;
  if (!paused && game.state === 'play' && frameAvg > 1 / 38) {
    slowTime += rawDt;
    if (slowTime > 4) {
      slowTime = 0;
      const i = QUALITY_ORDER.indexOf(qualityName);
      if (i < QUALITY_ORDER.length - 1) {
        applyQuality(QUALITY_ORDER[i + 1], true);
        frameAvg = 1 / 60;
      }
    }
  } else slowTime = Math.max(0, slowTime - rawDt);
}

document.getElementById('loading').textContent = 'Ready';
frame();

// expose for debugging in the console
window.__game = { game, vehicle, arena, stunts, world, rig, camera, renderer, scene, car, smoke, haze, post: () => ({ composer, bloomPass, gradePass }) };
