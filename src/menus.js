// Title-screen level grid, leaderboard tables and small menu helpers.
// Pure DOM — no game state. Every user-provided string goes through textContent.
import { formatViews } from './util.js';

const STAR_PATH = 'M12 2.6l2.85 6.05 6.65.8-4.9 4.58 1.28 6.57L12 17.33 6.12 20.6l1.28-6.57-4.9-4.58 6.65-.8z';
const LOCK_PATH = 'M7 10V7a5 5 0 0 1 10 0v3h1.4A1.6 1.6 0 0 1 20 11.6v7.8A1.6 1.6 0 0 1 18.4 21H5.6A1.6 1.6 0 0 1 4 19.4v-7.8A1.6 1.6 0 0 1 5.6 10H7zm2 0h6V7a3 3 0 0 0-6 0v3z';
const svg = (path, cls) => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;

let compactFmt = null;
try {
  compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
} catch { /* old browser: fall back to formatViews */ }

/** 1234567 -> "1.2M", 15300 -> "15.3K" */
export function compactNumber(n) {
  const v = Number(n) || 0;
  return compactFmt ? compactFmt.format(v) : formatViews(v);
}

const fmtScore = (n) => (Math.round(Number(n) || 0)).toLocaleString();
const cleanName = (s) => (String(s ?? '').trim().slice(0, 16) || 'PLAYER');
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** Fill `container` with three stars, the first `n` lit. */
export function renderStars(container, n = 0) {
  if (!container) return;
  const lit = Math.max(0, Math.min(3, Math.round(Number(n) || 0)));
  container.classList.add('stars');
  container.setAttribute('role', 'img');
  container.setAttribute('aria-label', `${lit} of 3 stars`);
  let html = '';
  for (let i = 0; i < 3; i++) {
    html += `<span class="star${i < lit ? ' on' : ''}" style="--i:${i}">${svg(STAR_PATH, 'star-ico')}</span>`;
  }
  container.innerHTML = html;
}

/**
 * Level cards.
 * levels: LEVELS array, progress: { [id]: { done, best, stars } }, isUnlocked(id, progress) -> bool,
 * onSelect(id) on click of an unlocked card. Returns the "next up" card (first unlocked, not done) or null.
 */
export function renderLevels(container, levels, progress, isUnlocked, onSelect) {
  if (!container) return null;
  const prog = progress || {};
  container.textContent = '';
  container.classList.add('level-grid');
  let nextCard = null;

  (levels || []).forEach((lv, i) => {
    const p = prog[lv.id] || {};
    const unlocked = typeof isUnlocked === 'function' ? !!isUnlocked(lv.id, prog) : true;
    const done = !!p.done;
    const prev = levels[i - 1];

    const card = el('button', 'level-card');
    card.type = 'button';
    card.dataset.level = lv.id;
    if (lv.kind) card.dataset.kind = lv.kind;
    if (done) card.classList.add('done');
    if (!unlocked) {
      card.classList.add('locked');
      card.setAttribute('aria-disabled', 'true');
      card.title = prev ? `Clear ${prev.title} to unlock` : 'Locked';
    } else if (!done && !nextCard) {
      card.classList.add('next');
      nextCard = card;
    }

    const num = el('span', 'lv-num', String(lv.num ?? i + 1).padStart(2, '0'));
    const body = el('span', 'lv-body');
    body.append(el('b', 'lv-title', lv.title || lv.id), el('small', 'lv-sub', lv.subtitle || ''));

    const side = el('span', 'lv-side');
    if (unlocked) {
      const stars = el('span');
      renderStars(stars, p.stars || 0);
      side.append(stars);
      if (p.best > 0) side.append(el('small', 'lv-best', fmtScore(p.best)));
      else if (card === nextCard) side.append(el('small', 'lv-tag', 'PLAY'));
    } else {
      side.insertAdjacentHTML('beforeend', svg(LOCK_PATH, 'lv-lock'));
      side.append(el('small', 'lv-tag', 'LOCKED'));
    }

    card.append(num, body, side);
    card.setAttribute('aria-label',
      `Level ${lv.num ?? i + 1}: ${lv.title || lv.id}. ${unlocked ? `${p.stars || 0} of 3 stars${p.best ? `, best ${fmtScore(p.best)}` : ''}` : card.title}`);
    card.addEventListener('click', () => {
      if (!unlocked) {
        card.classList.remove('shake');
        void card.offsetWidth;
        card.classList.add('shake');
        return;
      }
      if (typeof onSelect === 'function') onSelect(lv.id);
    });
    container.append(card);
  });

  return nextCard;
}

/**
 * Top-10 leaderboard. rows: [{ name, score, views, time, created_at }] (null/undefined = loading).
 * highlight: rank number (1-based) or a player name (case-insensitive) to mark as "you".
 * offline: show the "scores on this device" note.
 */
export function renderLeaderboard(container, rows, { highlight, offline } = {}) {
  if (!container) return;
  container.textContent = '';
  container.classList.add('board-list');

  if (rows == null) {
    container.append(el('div', 'lb-empty lb-loading', 'LOADING…'));
    return;
  }

  const list = (Array.isArray(rows) ? rows : []).slice(0, 10);
  if (!list.length) {
    const empty = el('div', 'lb-empty');
    empty.append(el('b', '', 'NO RUNS YET'), el('small', '', offline ? 'Finish this level to set the first local score.' : 'Be the first name on the board.'));
    container.append(empty);
  } else {
    const head = el('div', 'lb-row lb-head');
    head.append(el('span', 'lb-rank', '#'), el('span', 'lb-name', 'PILOT'), el('span', 'lb-score', 'SCORE'), el('span', 'lb-views', 'VIEWS'));
    const ol = el('ol', 'lb');
    const hiName = typeof highlight === 'string' ? highlight.trim().toLowerCase() : null;
    let marked = false;
    list.forEach((r, i) => {
      const rank = i + 1;
      const name = cleanName(r.name);
      const li = el('li', `lb-row${rank <= 3 ? ` top top${rank}` : ''}`);
      const isMe = !marked && ((typeof highlight === 'number' && highlight === rank) || (hiName && name.toLowerCase() === hiName));
      if (isMe) {
        li.classList.add('me');
        marked = true;
      }
      li.append(el('span', 'lb-rank', String(rank)), el('span', 'lb-name', name), el('span', 'lb-score', fmtScore(r.score)), el('span', 'lb-views', compactNumber(r.views)));
      const tip = [];
      if (Number.isFinite(Number(r.time)) && r.time != null) tip.push(`${Number(r.time).toFixed(1)} s`);
      if (r.created_at) {
        const d = new Date(r.created_at);
        if (!Number.isNaN(d.getTime())) tip.push(d.toLocaleDateString());
      }
      if (tip.length) li.title = tip.join(' · ');
      ol.append(li);
    });
    container.append(head, ol);
  }

  if (offline) container.append(el('div', 'lb-note', 'OFFLINE · SCORES SAVED ON THIS DEVICE'));
}

/** Title-screen live pill (#audience): "● 12 ONLINE · 3 PLAYING". */
export function renderAudience(target, { online = 0, playing } = {}) {
  if (!target) return;
  const on = Math.max(0, Math.round(Number(online) || 0));
  let txt = `● ${on.toLocaleString()} ONLINE`;
  if (playing != null) txt += ` · ${Math.max(0, Math.round(Number(playing) || 0)).toLocaleString()} PLAYING`;
  target.textContent = txt;
  target.classList.toggle('live', on > 0);
}

/**
 * Wire #board-tabs (buttons with data-level). Calls onSelect(level) on click.
 * Returns select(level, fire = true) to switch tabs from code.
 */
export function bindBoardTabs(tabs, onSelect) {
  if (!tabs) return () => {};
  const select = (level, fire = true) => {
    let found = false;
    for (const b of tabs.querySelectorAll('[data-level]')) {
      const on = b.dataset.level === level;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) found = true;
    }
    if (found && fire && typeof onSelect === 'function') onSelect(level);
  };
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-level]');
    if (b && tabs.contains(b)) select(b.dataset.level);
  });
  return select;
}

/** #submit-status line. kind: '' | 'busy' | 'ok' | 'err' */
export function setSubmitStatus(target, text, kind = '') {
  if (!target) return;
  target.textContent = text || '';
  target.className = kind ? `status-${kind}` : '';
}
