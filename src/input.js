import { moveToward } from './util.js';

const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set();
    this.padPrev = [];
    this.steer = 0;
    this.usingPad = false;
    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    this.state = {
      throttle: 0, brake: 0, steer: 0, handbrake: false, lift: 0, pitch: 0, roll: 0,
      flip: false, backflip: false, barrel: false, camera: false, reset: false, pause: false,
      assistToggle: false, mute: false, help: false, phone: false, any: false,
    };
  }

  down(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  hit(...codes) {
    return codes.some((c) => this.pressed.has(c));
  }

  poll(dt) {
    const s = this.state;
    let throttle = this.down('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = this.down('KeyS', 'ArrowDown') ? 1 : 0;
    let steerT = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
    let lift = (this.down('Space') ? 1 : 0) - (this.down('ShiftLeft', 'ShiftRight') ? 1 : 0);
    let roll = (this.down('KeyE') ? 1 : 0) - (this.down('KeyQ') ? 1 : 0);
    let pitch = throttle - brake;
    let handbrake = this.down('ShiftLeft', 'ShiftRight', 'KeyX');
    let flip = this.hit('KeyF'), backflip = this.hit('KeyB'), barrel = this.hit('KeyR');
    let camera = this.hit('KeyC'), reset = this.hit('Enter', 'Backspace'), pause = this.hit('Escape', 'KeyP');
    let padAnalogSteer = null;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const ax = (i) => (Math.abs(p.axes[i] || 0) > 0.14 ? p.axes[i] : 0);
      const b = (i) => (p.buttons[i] ? p.buttons[i].value : 0);
      const prev = this.padPrev[p.index] || [];
      const edge = (i) => b(i) > 0.5 && !(prev[i] > 0.5);
      if (p.buttons.some((x) => x.pressed) || p.axes.some((a) => Math.abs(a) > 0.3)) this.usingPad = true;
      throttle = Math.max(throttle, b(7));
      brake = Math.max(brake, b(6));
      if (ax(0)) padAnalogSteer = ax(0);
      pitch += -ax(1) + (b(7) - b(6)) * 0;
      roll += ax(2);
      lift += b(0) - b(1) - ax(3) * 0.8;
      handbrake = handbrake || b(1) > 0.5;
      flip = flip || edge(2);
      barrel = barrel || edge(4);
      backflip = backflip || edge(5);
      camera = camera || edge(3);
      pause = pause || edge(9);
      reset = reset || edge(8);
      this.padPrev[p.index] = p.buttons.map((x) => x.value);
    }

    if (padAnalogSteer !== null) this.steer = padAnalogSteer;
    else this.steer = moveToward(this.steer, steerT, dt * (steerT === 0 || Math.sign(steerT) !== Math.sign(this.steer) ? 6 : 3.2));

    s.throttle = Math.min(1, throttle);
    s.brake = Math.min(1, brake);
    s.steer = this.steer;
    s.handbrake = handbrake;
    s.lift = Math.max(-1, Math.min(1, lift));
    s.pitch = Math.max(-1, Math.min(1, pitch));
    s.roll = Math.max(-1, Math.min(1, roll));
    s.flip = flip;
    s.backflip = backflip;
    s.barrel = barrel;
    s.camera = camera;
    s.reset = reset;
    s.pause = pause;
    s.assistToggle = this.hit('KeyT');
    s.mute = this.hit('KeyM');
    s.help = this.hit('KeyH');
    s.phone = this.hit('KeyV');
    s.clip = this.hit('KeyK');
    s.any = this.pressed.size > 0;
    return s;
  }

  endFrame() {
    this.pressed.clear();
  }
}
