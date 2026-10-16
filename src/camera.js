import * as THREE from 'three';
import { clamp, damp, dampAngle, noise1 } from './util.js';

export const CAMERA_MODES = ['chase', 'spectator', 'drone', 'orbit', 'cockpit'];
export const CAMERA_LABELS = { chase: 'CHASE CAM', spectator: 'CROWD CAM', drone: 'DRONE CAM', orbit: 'CINEMATIC', cockpit: 'COCKPIT' };

// Spots in the crowd that the "phone video" camera films from
const SPECTATOR_SPOTS = [
  new THREE.Vector3(30, 2.3, -74.6),
  new THREE.Vector3(-34, 2.4, -71.5),
  new THREE.Vector3(-121, 4.2, 6),
  new THREE.Vector3(121, 4.6, 34),
  new THREE.Vector3(60, 3.4, -72),
];

const _v = new THREE.Vector3(), _t = new THREE.Vector3(), _q = new THREE.Quaternion();

export class CameraRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.mode = 'chase';
    this.heading = 0;
    this.pos = new THREE.Vector3(0, 4, -60);
    this.look = new THREE.Vector3();
    this.fov = 60;
    this.orbitYaw = 0;
    this.orbitPitch = 0;
    this.userDist = 0;
    this.lastMouse = -10;
    this.shake = 0;
    this.time = 0;
    this.spot = 0;
    this.spotTimer = 0;
    this.attractAngle = 0;
    this.zoom = 1;

    let dragging = false, lx = 0, ly = 0;
    dom.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; });
    window.addEventListener('pointerup', () => { dragging = false; });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.orbitYaw -= (e.clientX - lx) * 0.006;
      this.orbitPitch = clamp(this.orbitPitch + (e.clientY - ly) * 0.004, -0.35, 1.1);
      lx = e.clientX; ly = e.clientY;
      this.lastMouse = this.time;
    });
    dom.addEventListener('wheel', (e) => {
      this.userDist = clamp(this.userDist + Math.sign(e.deltaY) * 1.2, -3, 14);
    }, { passive: true });
  }

  setMode(m) {
    this.mode = m;
    this.snap = true;
  }

  next() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    return this.mode;
  }

  // stunt-film shot: a fixed camera position that tracks and zooms on the car for dur seconds
  action(pos, dur) {
    this.actionPos = pos.clone();
    this.actionTimer = dur;
  }

  addShake(a) {
    this.shake = Math.min(1.5, this.shake + a);
  }

  update(dt, v, opts = {}) {
    this.time += dt;
    const cam = this.camera;
    const carPos = v.renderPos;
    const speed = v.vel.length();
    const snap = this.snap;
    this.snap = false;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const k = snap ? 1e3 : 1;

    if (opts.attract) {
      // slow orbit for the title screen
      this.attractAngle += dt * 0.12;
      const a = this.attractAngle;
      _v.set(carPos.x + Math.sin(a) * 9.5, carPos.y + 1.0 + Math.sin(a * 0.7) * 0.6, carPos.z + Math.cos(a) * 9.5);
      this.pos.copy(_v);
      this.look.set(carPos.x, carPos.y + 0.1, carPos.z);
      cam.position.copy(this.pos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);
      this.applyFov(48, dt);
      return;
    }

    if (this.actionTimer > 0) {
      this.actionTimer -= dt;
      cam.up.set(0, 1, 0);
      cam.position.copy(this.actionPos);
      cam.position.y += noise1(this.time * 0.8) * 0.05;
      this.look.lerp(carPos, 1 - Math.exp(-9 * dt));
      cam.lookAt(this.look);
      const dist = this.actionPos.distanceTo(carPos);
      this.applyFov(clamp((2 * Math.atan(9 / dist) * 180) / Math.PI, 14, 62), dt, 4);
      if (this.actionTimer <= 0) this.snap = true;
      return;
    }

    const fwd = _v.set(0, 0, 1).applyQuaternion(v.renderQuat);
    const up = _t.set(0, 1, 0).applyQuaternion(v.renderQuat);
    if (up.y > 0.55 && !v.trick) {
      // follow velocity direction when moving fast, car heading otherwise
      let h = Math.atan2(fwd.x, fwd.z);
      const hv = Math.hypot(v.vel.x, v.vel.z);
      if (hv > 6 && v.forwardSpeed > 0) h = dampAngle(h, Math.atan2(v.vel.x, v.vel.z), 1, 0.4);
      this.heading = snap ? h : dampAngle(this.heading, h, 3.2, dt);
    }

    if (this.mode === 'chase') {
      if (this.time - this.lastMouse > 2.5) {
        this.orbitYaw = damp(this.orbitYaw, 0, 2, dt);
        this.orbitPitch = damp(this.orbitPitch, 0, 2, dt);
      }
      const yaw = this.heading + this.orbitYaw;
      const dist = 7.2 + Math.min(speed * 0.045, 3) + this.userDist + (v.armed ? 1.5 : 0);
      const height = 2.0 + this.orbitPitch * 5 + (v.armed ? 0.6 : 0);
      _v.set(carPos.x - Math.sin(yaw) * dist, carPos.y + height, carPos.z - Math.cos(yaw) * dist);
      this.pos.x = damp(this.pos.x, _v.x, 7 * k, dt);
      this.pos.y = damp(this.pos.y, _v.y, 5 * k, dt);
      this.pos.z = damp(this.pos.z, _v.z, 7 * k, dt);
      const floor = opts.groundAt ? opts.groundAt(this.pos.x, this.pos.z) + 0.35 : 0.35;
      this.pos.y = Math.max(this.pos.y, floor);
      _t.set(carPos.x + Math.sin(yaw) * 2.5, carPos.y + 0.7, carPos.z + Math.cos(yaw) * 2.5);
      this.look.lerp(_t, snap ? 1 : 1 - Math.exp(-10 * dt));
      cam.up.set(0, 1, 0);
      cam.position.copy(this.pos);
      cam.lookAt(this.look);
      this.applyFov(58 + clamp(speed * 0.28, 0, 22), dt);
    } else if (this.mode === 'orbit') {
      this.orbitYaw += dt * 0.25;
      const yaw = this.heading + this.orbitYaw + Math.PI * 0.75;
      const dist = 10 + this.userDist;
      _v.set(carPos.x - Math.sin(yaw) * dist, carPos.y + 1.2 + Math.sin(this.time * 0.3) * 1.2, carPos.z - Math.cos(yaw) * dist);
      this.pos.lerp(_v, snap ? 1 : 1 - Math.exp(-4 * dt));
      this.pos.y = Math.max(this.pos.y, 0.4);
      this.look.lerp(carPos, snap ? 1 : 1 - Math.exp(-8 * dt));
      cam.up.set(0, 1, 0);
      cam.position.copy(this.pos);
      cam.lookAt(this.look);
      this.applyFov(42, dt);
    } else if (this.mode === 'drone') {
      // top-down drone shot like the stunt video
      const yaw = this.heading + this.time * 0.05;
      _v.set(carPos.x - Math.sin(yaw) * 7, carPos.y + 24 + this.userDist, carPos.z - Math.cos(yaw) * 7);
      this.pos.lerp(_v, snap ? 1 : 1 - Math.exp(-2.5 * dt));
      this.look.lerp(carPos, snap ? 1 : 1 - Math.exp(-6 * dt));
      cam.up.set(Math.sin(yaw), 0, Math.cos(yaw));
      cam.position.copy(this.pos);
      cam.lookAt(this.look);
      this.applyFov(50, dt);
    } else if (this.mode === 'cockpit') {
      _v.set(0.36, 0.52, 0.05).applyQuaternion(v.renderQuat).add(carPos);
      cam.position.copy(_v);
      _t.set(0.36, 0.42, 10).applyQuaternion(v.renderQuat).add(carPos);
      cam.up.set(0, 1, 0).applyQuaternion(v.renderQuat);
      cam.lookAt(_t);
      this.applyFov(78, dt);
    } else {
      // handheld phone camera in the crowd, auto-zooming on the car
      this.spotTimer -= dt;
      if (this.spotTimer <= 0 || snap) {
        let best = this.spot, bestScore = Infinity;
        SPECTATOR_SPOTS.forEach((p, i) => {
          const d = p.distanceTo(carPos);
          const score = Math.abs(d - 38) + (i === this.spot ? -12 : 0);
          if (d > 10 && score < bestScore) { bestScore = score; best = i; }
        });
        if (best !== this.spot || snap) {
          this.spot = best;
          this.look.copy(carPos);
        }
        this.spotTimer = 2;
      }
      const p = SPECTATOR_SPOTS[this.spot];
      const tt = this.time;
      cam.position.set(p.x + noise1(tt * 0.6) * 0.06, p.y + noise1(tt * 0.7 + 9) * 0.05, p.z + noise1(tt * 0.5 + 3) * 0.06);
      this.look.lerp(carPos, snap ? 1 : 1 - Math.exp(-3.2 * dt));
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);
      // hand tremor
      cam.rotateY(noise1(tt * 1.7) * 0.006 + noise1(tt * 9) * 0.0015);
      cam.rotateX(noise1(tt * 1.3 + 5) * 0.005 + noise1(tt * 11 + 2) * 0.0012);
      cam.rotateZ(noise1(tt * 0.9 + 7) * 0.01);
      const dist = cam.position.distanceTo(carPos);
      const target = clamp((2 * Math.atan(5.5 / dist) * 180) / Math.PI, 7, 55);
      this.zoom = 55 / this.fov;
      this.applyFov(target, dt, 1.6);
    }

    if (this.shake > 0) {
      const s = this.shake * this.shake * 0.04;
      cam.rotateX(noise1(this.time * 31) * s);
      cam.rotateY(noise1(this.time * 27 + 4) * s);
    }
  }

  applyFov(target, dt, rate = 3) {
    this.fov = damp(this.fov, target, rate, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
