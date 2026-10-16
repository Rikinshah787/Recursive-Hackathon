import * as THREE from 'three';
import { formatTime, formatViews } from './util.js';

const $ = (id) => document.getElementById(id);
const _v = new THREE.Vector3();

// Fill `el` with text where every [KEY] becomes a keycap. Text only (no HTML).
function fillKeys(el, text) {
  el.textContent = '';
  String(text || '').split(/\[([^\]]+)\]/).forEach((part, i) => {
    if (!part) return;
    if (i % 2) {
      const k = document.createElement('kbd');
      k.className = part.length > 1 ? 'cap wide' : 'cap';
      k.textContent = part;
      el.append(k);
    } else el.append(document.createTextNode(part));
  });
}

// level ids -> short names for the live score ticker (unknown ids are shown upper-cased)
const LEVEL_LABELS = {
  reveal: 'LAUNCH SHOW', jump: 'CAR JUMP', flip: 'FLIP JUMP', wall: 'MEGA WALL',
  loop: 'C-LOOP', finale: 'DONUT FINALE', tour: 'STUNT TOUR', free: 'FREE ROAM',
};

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), mode: $('mode-badge'), assist: $('assist-badge'), cam: $('cam-badge'),
      objective: $('objective'), objStep: $('obj-step'), objText: $('obj-text'), objProgress: $('obj-progress'),
      timer: $('timer'), score: $('score'), pending: $('pending'), feed: $('trick-feed'), toast: $('toast'),
      speed: $('speed'), alt: $('alt'), gasFill: $('gas-fill'), gasPct: $('gas-pct'),
      marker: $('marker'), markerDist: $('marker-dist'), help: $('help'),
      phone: $('phone'), recTime: $('rec-time'), zoom: $('zoom'), countdown: $('countdown'), fade: $('fade'),
      views: $('views-count'), card: $('stunt-card'), cardTop: $('card-top'), cardTitle: $('card-title'), cardSub: $('card-sub'),
      likes: $('likes'), clip: $('clip-rec'), clipTime: $('clip-time'), railViews: $('rail-views'), railLikes: $('rail-likes'),
      audience: $('audience-badge'), audienceText: $('audience-text'), ticker: $('feed'),
      lever: $('thrust-lever'), leverFill: $('thrust-fill'), leverKnob: $('thrust-knob'), leverPct: $('thrust-pct'),
      brief: $('brief'), briefTop: $('brief-top'), briefTitle: $('brief-title'), briefGoal: $('brief-goal'), briefSteps: $('brief-steps'),
      coach: $('coach'), coachTip: $('coach-tip'), coachBox: $('coach-box'), coachMain: $('coach-main'), coachSub: $('coach-sub'),
    };
    fillKeys($('brief-keys'), 'or press [W] [SPACE] [ENTER]');
    this.cache = {};
    this.toastTimer = 0;
    this.scoreShown = 0;
    this.viewsShown = 0;
    this.recent = []; // recent call-outs, also burned into recorded clips
    this.guardTyping($('res-name'), $('btn-submit'));
  }

  // keep game keys (Space, R, F, Enter...) from firing while typing a name; Enter submits
  guardTyping(input, submitBtn) {
    if (!input) return;
    const stop = (e) => {
      e.stopPropagation();
      if (e.type !== 'keydown') return;
      if (e.key === 'Enter' && submitBtn && !submitBtn.disabled) {
        e.preventDefault();
        submitBtn.click();
      } else if (e.key === 'Escape') {
        input.blur();
      }
    };
    input.addEventListener('keydown', stop);
    input.addEventListener('keyup', stop);
  }

  // live audience badge under the views counter (hidden until the first call)
  setAudience({ online = 1, playing } = {}) {
    const on = Math.max(0, Math.round(Number(online) || 0));
    let txt = `LIVE ${on.toLocaleString()} ONLINE`;
    if (playing != null) txt += ` · ${Math.max(0, Math.round(Number(playing) || 0)).toLocaleString()} PLAYING`;
    if (!this.audienceShown) {
      this.audienceShown = true;
      this.el.audience.classList.remove('hidden');
    }
    this.set('audience', this.el.audienceText, txt);
  }

  // bottom-left ticker of new leaderboard scores from anyone; each line fades after ~6 s, max 3
  feed({ name, level, score } = {}) {
    const box = this.el.ticker;
    if (!box) return;
    const line = document.createElement('div');
    line.className = 'feed-line';
    const who = document.createElement('b');
    who.textContent = String(name ?? '').trim().slice(0, 16) || 'PLAYER';
    const pts = document.createElement('span');
    pts.textContent = `${Math.round(Number(score) || 0).toLocaleString()}`;
    const lv = document.createElement('small');
    lv.textContent = LEVEL_LABELS[level] || String(level ?? '').toUpperCase();
    line.append(who, document.createTextNode(' scored '), pts, lv);
    box.append(line);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => line.remove(), 6200);
  }

  // vertical thrust lever gauge next to the fuel bar (v = 0..1)
  setThrustLevel(v) {
    const pct = Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100);
    if (this.cache.lever === pct) return;
    this.cache.lever = pct;
    this.el.leverFill.style.height = pct + '%';
    this.el.leverKnob.style.bottom = pct + '%';
    this.el.leverPct.textContent = pct + '%';
    this.el.lever.classList.toggle('max', pct >= 99);
    this.el.lever.classList.toggle('low', pct <= 30);
  }

  setViews(n, dt) {
    this.viewsShown += (n - this.viewsShown) * Math.min(1, dt * 4);
    const txt = formatViews(this.viewsShown);
    this.set('views', this.el.views, txt);
    this.set('railViews', this.el.railViews, txt);
    this.set('railLikes', this.el.railLikes, formatViews(this.viewsShown * 0.083));
  }

  // floating hearts — more for bigger moments
  likes(n) {
    const count = Math.min(9, 1 + Math.floor(Math.log10(Math.max(10, n)) - 3));
    for (let i = 0; i < count; i++) {
      const h = document.createElement('div');
      h.className = 'heart';
      h.style.setProperty('--dx', `${(Math.random() - 0.5) * 70}px`);
      h.style.setProperty('--hue', `${340 + Math.random() * 30}`);
      h.style.animationDelay = `${i * 0.09}s`;
      this.el.likes.appendChild(h);
      setTimeout(() => h.remove(), 2600 + i * 90);
    }
  }

  card(top, title, sub) {
    const c = this.el.card;
    if (!top) {
      c.classList.remove('show');
      return;
    }
    this.el.cardTop.textContent = top;
    this.el.cardTitle.textContent = title;
    this.el.cardSub.textContent = sub || '';
    c.classList.remove('show');
    void c.offsetWidth;
    c.classList.add('show');
  }

  // beginner levels: lets the CSS move the toast out of the coach prompt's way
  setEasy(on) {
    if (this.cache.easy === on) return;
    this.cache.easy = on;
    document.body.classList.toggle('coaching', on);
  }

  // briefing card before an easy level (level = LEVELS entry with .brief), or null to hide
  brief(level) {
    if (this.cache.brief === level) return;
    this.cache.brief = level;
    const el = this.el.brief;
    if (!level) {
      el.classList.add('hidden');
      return;
    }
    const b = level.brief;
    this.el.briefTop.textContent = `LEVEL ${level.num} · EASY`;
    this.el.briefTitle.textContent = level.title;
    fillKeys(this.el.briefGoal, b.goal);
    const list = this.el.briefSteps;
    list.textContent = '';
    b.steps.slice(0, 3).forEach((text, i) => {
      const li = document.createElement('li');
      const n = document.createElement('span');
      n.className = 'step-n';
      n.textContent = String(i + 1);
      const body = document.createElement('span');
      body.className = 'step-body';
      fillKeys(body, text);
      li.append(n, body);
      list.append(li);
    });
    el.classList.remove('hidden');
  }

  // the big "do this now" prompt: { text, sub?, tip?, urgent? } or null. Touches the DOM only on change.
  setCoach(p) {
    const key = p ? `${p.text}|${p.sub || ''}|${p.tip || ''}|${p.urgent ? 1 : 0}` : '';
    if (this.cache.coach === key) return;
    this.cache.coach = key;
    const c = this.el.coach;
    if (!p) {
      c.classList.add('hidden');
      this.cache.coachText = null;
      return;
    }
    c.classList.remove('hidden');
    c.classList.toggle('urgent', !!p.urgent);
    if (this.cache.coachText !== p.text) {
      this.cache.coachText = p.text;
      fillKeys(this.el.coachMain, p.text);
      const box = this.el.coachBox;
      box.classList.remove('pop');
      void box.offsetWidth;
      box.classList.add('pop');
    }
    if (this.cache.coachSub !== (p.sub || '')) {
      this.cache.coachSub = p.sub || '';
      fillKeys(this.el.coachSub, this.cache.coachSub);
      this.el.coachSub.classList.toggle('hidden', !p.sub);
    }
    if (this.cache.coachTip !== (p.tip || '')) {
      this.cache.coachTip = p.tip || '';
      fillKeys(this.el.coachTip, this.cache.coachTip);
      this.el.coachTip.classList.toggle('hidden', !p.tip);
    }
  }

  setClip(on, t = 0) {
    this.el.clip.classList.toggle('hidden', !on);
    if (on) this.set('clipTime', this.el.clipTime, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`);
  }

  set(key, el, value, prop = 'textContent') {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    el[prop] = value;
  }

  show(on) {
    this.el.hud.classList.toggle('hidden', !on);
  }

  setHelp(on) {
    this.el.help.classList.toggle('hidden', !on);
  }

  toggleHelp() {
    this.el.help.classList.toggle('hidden');
  }

  setPhone(on) {
    this.el.phone.classList.toggle('hidden', !on);
  }

  setMode(text, cls) {
    this.set('mode', this.el.mode, text);
    if (this.cache.modeCls !== cls) {
      this.cache.modeCls = cls;
      this.el.mode.className = 'badge ' + (cls || '');
    }
  }

  setAssist(on) {
    this.set('assist', this.el.assist, on ? 'ASSIST ON' : 'ASSIST OFF · ACRO');
  }

  setCamera(label) {
    this.set('cam', this.el.cam, label);
  }

  setObjective(step, total, text, progress = '') {
    if (step == null) {
      this.el.objective.classList.add('hidden');
      return;
    }
    this.el.objective.classList.remove('hidden');
    this.set('objStep', this.el.objStep, total ? `STEP ${step} / ${total}` : step);
    if (this.cache.objText !== text) {
      this.el.objective.classList.remove('flash');
      void this.el.objective.offsetWidth;
      this.el.objective.classList.add('flash');
    }
    this.set('objText', this.el.objText, text);
    this.set('objProgress', this.el.objProgress, progress);
  }

  setTimer(t) {
    this.set('timer', this.el.timer, t == null ? '' : formatTime(t));
  }

  setScore(n, dt) {
    this.scoreShown += (n - this.scoreShown) * Math.min(1, dt * 8);
    if (Math.abs(n - this.scoreShown) < 1) this.scoreShown = n;
    this.set('score', this.el.score, Math.round(this.scoreShown).toLocaleString());
  }

  setPending(points, combo) {
    this.set('pending', this.el.pending, points > 0 ? `+${points.toLocaleString()}${combo > 1 ? `  x${combo}` : ''}` : '');
  }

  setTelemetry(kmh, alt, gas) {
    this.set('speed', this.el.speed, String(Math.round(kmh)));
    this.set('alt', this.el.alt, alt.toFixed(1));
    const pct = Math.round(gas * 100);
    this.set('gasPct', this.el.gasPct, pct + '%');
    if (this.cache.gasW !== pct) {
      this.cache.gasW = pct;
      this.el.gasFill.style.width = pct + '%';
      this.el.gasFill.classList.toggle('low', gas < 0.2);
    }
  }

  trick(title, sub, kind = '') {
    const d = document.createElement('div');
    d.className = 'trick ' + kind;
    d.innerHTML = `${title}${sub ? `<small>${sub}</small>` : ''}`;
    this.el.feed.prepend(d);
    while (this.el.feed.children.length > 3) this.el.feed.lastChild.remove();
    setTimeout(() => d.remove(), 1900);
    this.recent.unshift({ title, sub, kind, t: performance.now() });
    this.recent.length = Math.min(this.recent.length, 3);
  }

  toast(msg, secs = 2.2) {
    this.el.toast.textContent = msg;
    this.el.toast.classList.add('show');
    this.toastTimer = secs;
  }

  countdown(text) {
    this.el.countdown.innerHTML = text ? `<span class="num">${text}</span>` : '';
  }

  fade(on) {
    this.el.fade.classList.toggle('on', on);
  }

  // screen-space objective marker; clamps to the screen edge when off-screen
  setMarker(worldPos, camera, label) {
    const m = this.el.marker;
    if (!worldPos) {
      if (this.cache.marker !== false) {
        m.style.display = 'none';
        this.cache.marker = false;
      }
      return;
    }
    this.cache.marker = true;
    m.style.display = 'block';
    _v.copy(worldPos).project(camera);
    const behind = _v.z > 1;
    let x = _v.x, y = _v.y;
    if (behind) { x = -x; y = -y; }
    const off = behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.88;
    if (off) {
      const s = Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.85, 1e-3);
      x /= s; y /= s;
      if (behind && Math.abs(y) < 0.85) y = -0.85;
    }
    const W = window.innerWidth, H = window.innerHeight;
    m.style.left = ((x * 0.5 + 0.5) * W).toFixed(1) + 'px';
    m.style.top = ((-y * 0.5 + 0.5) * H).toFixed(1) + 'px';
    m.classList.toggle('edge', off);
    this.set('markerDist', this.el.markerDist, label);
  }

  update(dt, phoneTime, zoom) {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('show');
    }
    if (!this.el.phone.classList.contains('hidden')) {
      const s = Math.floor(phoneTime);
      this.set('rec', this.el.recTime, `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
      this.set('zoom', this.el.zoom, zoom.toFixed(1) + 'x');
    }
  }
}
