// Stunt School replays: re-flies an agent's recorded flight through the real game physics.
// The tape holds the controller commands (60 Hz); keyframes (20 Hz) pin the state so the
// browser run cannot drift from the headless simulator run.
import * as THREE from 'three';

const TRICKS = ['flip', 'backflip', 'roll'];

function toInput(row) {
  const [throttle, brake, steer, lift, pitch, roll, handbrake, thrustLevel, assist, trick] = row;
  return { throttle, brake, steer, lift, pitch, roll, handbrake: !!handbrake, thrustLevel, assist: !!assist, trick: TRICKS.includes(trick) ? trick : null };
}

export class ReplayDriver {
  constructor(vehicle, data) {
    this.v = vehicle;
    this.d = data;
    this.cmd = toInput([0, 0, 0, 0, 0, 0, 0, 0.6, 1, 0]);
    this.restart();
  }

  restart() {
    const { start, fuel } = this.d;
    this.v.gasCap = fuel ?? 1;
    this.v.reset(new THREE.Vector3(start.x, 0, start.z), start.heading);
    this.k = 0;
    this.acc = 0;
    this.endTimer = 0;
  }

  get done() {
    return this.k >= this.d.steps;
  }

  get time() {
    return this.k * this.d.fixedDt;
  }

  snap(key) {
    const v = this.v;
    v.pos.set(key[1], key[2], key[3]);
    v.quat.set(key[4], key[5], key[6], key[7]).normalize();
    v.vel.set(key[8], key[9], key[10]);
    v.angVel.set(key[11], key[12], key[13]);
    v.gas = key[14];
  }

  // advance by simDt of game time; returns true while the flight is still playing
  step(simDt) {
    const v = this.v, d = this.d, dt = d.fixedDt;
    this.acc += simDt;
    let n = 0;
    while (this.acc >= dt && n < 30) {
      if (this.k < d.steps) {
        if (this.k % d.sub === 0) {
          const row = d.tape[Math.floor(this.k / d.sub)];
          if (row) {
            this.cmd = toInput(row);
            if (this.cmd.trick && !v.trick) v.startTrick(this.cmd.trick);
          }
        }
        if (this.k % d.keyEvery === 0) {
          const key = d.keys[this.k / d.keyEvery];
          if (key) this.snap(key);
        }
      } else {
        this.cmd = toInput([0, 0, 0, 0, 0, 0, 0, 0.6, 1, 0]);
      }
      v.prevPos.copy(v.pos);
      v.prevQuat.copy(v.quat);
      v.substep(this.cmd, dt);
      this.k++;
      this.acc -= dt;
      n++;
    }
    if (n === 30) this.acc = 0;
    const alpha = this.acc / dt;
    v.renderPos.lerpVectors(v.prevPos, v.pos, alpha);
    v.renderQuat.slerpQuaternions(v.prevQuat, v.quat, alpha);
    return !this.done;
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ACTION_COLORS = { done: '#5dff9b', continue: '#c9ccd6', replan: '#c58bff', revert: '#ffc24b', stop: '#ff6b7a', escalate: '#ff9a4b' };

// overlay naming what is being replayed (one element, updated in place); returns a setter for the time line
export function replayBanner(meta, { live = false } = {}) {
  let el = document.getElementById('replay-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'replay-banner';
    el.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:50;padding:10px 18px;border-radius:12px;'
      + 'background:rgba(8,10,16,.72);color:#fff;font:600 14px/1.35 system-ui,sans-serif;text-align:center;letter-spacing:.02em;'
      + 'border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(6px);max-width:min(92vw,760px);pointer-events:none';
    document.body.appendChild(el);
  }
  if (!meta) {
    el.innerHTML = `<div style="font-size:11px;opacity:.7;letter-spacing:.14em">STUNT SCHOOL · LIVE</div><div style="margin-top:3px">Waiting for the agents' next flight…</div>`;
    return () => {};
  }
  if (meta.kind === 'lab') {
    el.innerHTML = `<div style="font-size:11px;opacity:.7;letter-spacing:.14em">${live ? '<span style="color:#ff2d55">● LIVE</span> · ' : ''}STUNT SCHOOL · <span style="color:#7fd4ff">LAB EXPERIMENT</span>${meta.version != null ? ` · FOR PLAYBOOK v${esc(meta.version)}` : ''}</div>`
      + `<div style="margin-top:3px">${esc(String(meta.goal || '').replace(/^LAB( EXPERIMENT)?:\s*/, ''))}</div>`
      + '<div style="margin-top:4px;font-size:12px;color:#7fd4ff">the coach is measuring how the car really behaves before it rewrites the playbook</div>'
      + '<div id="replay-time" style="margin-top:4px;font-size:11px;opacity:.65"></div>';
    return (text) => {
      const t = el.querySelector('#replay-time');
      if (t) t.textContent = text;
    };
  }
  const ok = meta.referee ? meta.referee.pass : null;
  const d = meta.decision;
  el.innerHTML = `<div style="font-size:11px;opacity:.7;letter-spacing:.14em">${live ? '<span style="color:#ff2d55">● LIVE</span> · ' : ''}STUNT SCHOOL · AGENT FLIGHT${meta.version != null ? ` · PLAYBOOK v${esc(meta.version)}` : ''}${meta.attempt ? ` · ATTEMPT ${esc(meta.attempt)}` : ''}</div>`
    + `<div style="margin-top:3px">${esc(meta.goal || meta.task)}</div>`
    + `<div style="margin-top:4px;font-size:12px">`
    + `<span style="color:${meta.selfCheck ? '#5dff9b' : '#ff6b7a'}">team self-check: ${meta.selfCheck ? 'DONE' : 'not done'}${meta.checks ? ` (${esc(meta.checks)})` : ''}</span>`
    + (ok == null ? '' : ` · <span style="color:${ok ? '#5dff9b' : '#ff6b7a'}">referee: ${ok ? 'PASS' : 'FAIL'}</span>`)
    + (meta.crash ? ` · <span style="color:#ff6b7a">${esc(meta.crash)}</span>` : '')
    + '</div>'
    + (d ? `<div style="margin-top:3px;font-size:12px;color:${ACTION_COLORS[d.action] || '#fff'}">watchdog: ${esc(String(d.action).toUpperCase())} · <span style="opacity:.85">${esc(d.reason)}</span></div>` : '')
    + '<div id="replay-time" style="margin-top:4px;font-size:11px;opacity:.65"></div>';
  return (text) => {
    const t = el.querySelector('#replay-time');
    if (t) t.textContent = text;
  };
}

// ?live: follow the newest Stunt School run and fly each attempt as soon as the agents finish it.
// play(data) starts a replay; call next() when the current one has finished.
export class LiveFeed {
  constructor(play, { base = '/school/runs', every = 2000 } = {}) {
    this.play = play;
    this.base = base;
    this.queue = [];
    this.seen = new Set();
    this.runId = null;
    this.playing = false;
    this.first = true;
    this.timer = setInterval(() => this.poll(), every);
    this.poll();
  }

  async poll() {
    try {
      const { runId } = await (await fetch(`${this.base}/latest.json?t=${Date.now()}`)).json();
      if (runId !== this.runId) {
        this.runId = runId;
        this.seen.clear();
        this.queue.length = 0;
        this.first = true;
      }
      const state = await (await fetch(`${this.base}/${runId}/state.json?t=${Date.now()}`)).json();
      const fresh = (state.feed || []).filter((f) => !this.seen.has(f.key));
      fresh.forEach((f) => this.seen.add(f.key));
      // on first contact only show the newest flight, not the whole history
      if (this.first) {
        this.first = false;
        if (fresh.length) this.queue.push(fresh[fresh.length - 1]);
      } else this.queue.push(...fresh);
      // agents can out-fly the projector: keep the backlog short, newest wins
      if (this.queue.length > 3) this.queue.splice(0, this.queue.length - 3);
      if (!this.playing) this.next();
    } catch {
      /* no runs yet */
    }
  }

  // returns false when there is nothing new (the caller then loops the current flight)
  async next() {
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      return false;
    }
    this.playing = true;
    try {
      const data = await (await fetch(item.replay)).json();
      data.meta = { ...(data.meta || {}), ...item };
      this.play(data);
    } catch {
      this.playing = false;
      return this.next();
    }
    return true;
  }
}
