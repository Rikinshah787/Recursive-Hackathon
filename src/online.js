// Online layer: Supabase leaderboard, realtime score feed and live audience (presence).
// Everything degrades to a local, offline leaderboard when Supabase is not configured
// (no VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY) or the network fails. No method throws.
import { createClient } from '@supabase/supabase-js';

const NAME_KEY = 'roadster-name';
const LOCAL_KEY = 'roadster-local-scores';
const LOCAL_MAX = 1000;          // cap on locally kept rows
const NET_TIMEOUT_MS = 8000;     // REST calls give up after this
const MAX_SCORE = 1000000;
const MAX_NAME = 16;
const MAX_LEVEL = 24;

// ---------------------------------------------------------------- helpers

const warned = new Set();
function warnOnce(tag, err) {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(`[online] ${tag}:`, err && err.message ? err.message : err);
}

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
}

// Unicode-aware truncation (Postgres char_length counts code points, not UTF-16 units)
function cut(str, n) {
  return Array.from(str).slice(0, n).join('');
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

export function sanitizeName(name, fallback = 'PLAYER') {
  let s = String(name ?? '').replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  s = cut(s, MAX_NAME).trim();
  return s || fallback;
}

function sanitizeLevel(level) {
  const s = cut(String(level ?? 'free').replace(CONTROL_CHARS, '').trim(), MAX_LEVEL);
  return s || 'free';
}

function toInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

function toTime(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function randomId() {
  try {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* insecure context */ }
  return 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// fetch with a hard timeout so a dead network never hangs the results screen
function timedFetch(input, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT_MS);
  if (init.signal) {
    if (init.signal.aborted) ctrl.abort();
    else init.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function readEnv() {
  let url = '';
  let key = '';
  try {
    url = String(import.meta.env.VITE_SUPABASE_URL || '').trim();
    key = String(import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();
  } catch { /* no env */ }
  // ignore the untouched placeholders from .env.example
  if (!/^https?:\/\//i.test(url) || /YOUR-PROJECT/i.test(url)) url = '';
  if (!key || key === 'your-anon-key') key = '';
  return { url, key };
}

// ---------------------------------------------------------------- Online

export class Online {
  constructor() {
    this.client = null;
    this.enabled = false;
    this.clientId = randomId();
    this.playerName = sanitizeName(lsGet(NAME_KEY));

    this.status = { playing: false, level: null };
    this.audience = null;          // last { online, playing } emitted
    this.connected = false;        // connect() called
    this.presenceReady = false;    // presence channel SUBSCRIBED

    this._audienceCbs = [];
    this._feedCbs = [];
    this._presence = null;
    this._scores = null;
    this._seenIds = new Set();
    this._lastTracked = '';
    this._audienceLocal = false;

    const { url, key } = readEnv();
    if (url && key) {
      try {
        this.client = createClient(url, key, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          realtime: { params: { eventsPerSecond: 10 } },
          global: { fetch: timedFetch },
        });
        this.enabled = true;
      } catch (err) {
        warnOnce('createClient failed', err);
        this.client = null;
        this.enabled = false;
      }
    }
  }

  // ------------------------------------------------------------ identity

  setPlayerName(name) {
    this.playerName = sanitizeName(name, this.playerName || 'PLAYER');
    lsSet(NAME_KEY, this.playerName);
    this._track();
    return this.playerName;
  }

  // ------------------------------------------------------------ realtime

  connect() {
    if (this.connected) return;
    this.connected = true;
    if (!this.enabled) {
      this._emitLocalAudience();
      return;
    }

    try {
      // Live audience: every open client joins one presence channel.
      this._presence = this.client.channel('roadster-audience', {
        config: { presence: { key: this.clientId } },
      });
      this._presence.on('presence', { event: 'sync' }, () => this._onPresenceSync());
      this._presence.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          this.presenceReady = true;
          this._lastTracked = '';
          this._track();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.presenceReady = false;
          if (status !== 'CLOSED') warnOnce(`presence ${status}`, err || status);
          if (!this.audience || this._audienceLocal) this._emitLocalAudience();
        }
      });
    } catch (err) {
      warnOnce('presence channel failed', err);
      this._emitLocalAudience();
    }

    try {
      // Live feed: new leaderboard rows from anyone (requires the table in supabase_realtime).
      this._scores = this.client.channel('roadster-scores');
      this._scores.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'scores' },
        (payload) => this._onScoreInsert(payload && payload.new),
      );
      this._scores.subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') warnOnce(`score feed ${status}`, err || status);
      });
    } catch (err) {
      warnOnce('score feed failed', err);
    }
  }

  setStatus({ playing, level } = {}) {
    this.status = {
      playing: !!playing,
      level: level == null ? null : sanitizeLevel(level),
    };
    if (!this.enabled || !this.presenceReady) {
      // offline (or not yet joined): we are the whole audience
      if (!this.enabled || !this.audience || this._audienceLocal) this._emitLocalAudience();
      return;
    }
    this._track();
  }

  onAudience(cb) {
    if (typeof cb !== 'function') return () => {};
    this._audienceCbs.push(cb);
    if (this.audience) this._safe(cb, this.audience);
    return () => { this._audienceCbs = this._audienceCbs.filter((f) => f !== cb); };
  }

  onFeed(cb) {
    if (typeof cb !== 'function') return () => {};
    this._feedCbs.push(cb);
    return () => { this._feedCbs = this._feedCbs.filter((f) => f !== cb); };
  }

  _track() {
    if (!this.enabled || !this.presenceReady || !this._presence) return;
    const payload = { name: this.playerName, playing: this.status.playing, level: this.status.level };
    const sig = JSON.stringify(payload);
    if (sig === this._lastTracked) return; // nothing changed, skip the round trip
    this._lastTracked = sig;
    try {
      Promise.resolve(this._presence.track(payload)).catch((err) => {
        this._lastTracked = '';
        warnOnce('presence track failed', err);
      });
    } catch (err) {
      this._lastTracked = '';
      warnOnce('presence track failed', err);
    }
  }

  _onPresenceSync() {
    try {
      const state = this._presence.presenceState() || {};
      const keys = Object.keys(state);
      let playing = 0;
      for (const k of keys) {
        const metas = state[k] || [];
        if (metas.some((m) => m && m.playing === true)) playing++;
      }
      // we are always at least one viewer, even before our own track lands
      const online = Math.max(1, keys.length);
      this._emitAudience({ online, playing: Math.min(playing, online) });
    } catch (err) {
      warnOnce('presence sync failed', err);
    }
  }

  _onScoreInsert(row) {
    if (!row) return;
    if (row.id != null) {
      if (this._seenIds.has(row.id)) return;
      this._seenIds.add(row.id);
      if (this._seenIds.size > 500) this._seenIds = new Set([...this._seenIds].slice(-200));
    }
    const item = {
      name: sanitizeName(row.name, '???'),
      level: sanitizeLevel(row.level),
      score: toInt(row.score, 0, MAX_SCORE),
    };
    for (const cb of this._feedCbs) this._safe(cb, item);
  }

  _emitLocalAudience() {
    this._emitAudience({ online: 1, playing: this.status.playing ? 1 : 0 }, true);
  }

  _emitAudience(a, local = false) {
    this._audienceLocal = local;
    const prev = this.audience;
    if (prev && prev.online === a.online && prev.playing === a.playing) return;
    this.audience = a;
    for (const cb of this._audienceCbs) this._safe(cb, a);
  }

  _safe(cb, arg) {
    try { cb(arg); } catch (err) { warnOnce('callback error', err); }
  }

  // ------------------------------------------------------------ leaderboard

  async submitScore({ name, level, score, views, time } = {}) {
    const row = {
      name: sanitizeName(name, this.playerName || 'PLAYER'),
      level: sanitizeLevel(level),
      score: toInt(score, 0, MAX_SCORE),
      views: toInt(views, 0, Number.MAX_SAFE_INTEGER),
      time: toTime(time),
      created_at: new Date().toISOString(),
    };

    // always keep a local copy (offline board + fallback)
    let localRank = null;
    try {
      localRank = this._localRank(row.level, row.score);
      this._saveLocal(row);
    } catch (err) {
      warnOnce('local save failed', err);
    }

    if (!this.enabled) return { ok: true, rank: localRank, offline: true };

    try {
      const { error } = await this.client.from('scores').insert({
        name: row.name,
        level: row.level,
        score: row.score,
        views: row.views,
        time_s: row.time,
      });
      if (error) throw error;
    } catch (err) {
      warnOnce('submitScore failed', err);
      return { ok: false, rank: null, localRank, offline: true, error: errMsg(err) };
    }

    try {
      const { count, error } = await this.client
        .from('scores')
        .select('id', { count: 'exact', head: true })
        .eq('level', row.level)
        .gt('score', row.score);
      if (error) throw error;
      return { ok: true, rank: 1 + (count || 0) };
    } catch (err) {
      // the score is saved; we just could not work out the rank
      warnOnce('rank lookup failed', err);
      return { ok: true, rank: null, localRank };
    }
  }

  async topScores(level, limit = 10) {
    const lvl = sanitizeLevel(level);
    const n = toInt(limit, 1, 100);
    if (this.enabled) {
      try {
        const { data, error } = await this.client
          .from('scores')
          .select('name, score, views, time_s, created_at')
          .eq('level', lvl)
          .order('score', { ascending: false })
          .order('created_at', { ascending: true })
          .limit(n);
        if (error) throw error;
        return (data || []).map((r) => ({
          name: r.name,
          score: r.score,
          views: Number(r.views) || 0,
          time: r.time_s == null ? null : Number(r.time_s),
          created_at: r.created_at,
        }));
      } catch (err) {
        warnOnce('topScores failed', err);
      }
    }
    return this._localTop(lvl, n);
  }

  async stats() {
    if (this.enabled) {
      try {
        const { count, error } = await this.client
          .from('scores')
          .select('id', { count: 'exact', head: true });
        if (error) throw error;
        return { runs: count || 0 };
      } catch (err) {
        warnOnce('stats failed', err);
      }
    }
    return { runs: this._loadLocal().length };
  }

  // ------------------------------------------------------------ local board

  _loadLocal() {
    try {
      const rows = JSON.parse(lsGet(LOCAL_KEY) || '[]');
      return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    } catch {
      return [];
    }
  }

  _saveLocal(row) {
    let rows = this._loadLocal();
    rows.push(row);
    if (rows.length > LOCAL_MAX) {
      // drop the lowest scores first, keep the rest in insertion order
      const keep = new Set(
        rows
          .map((r, i) => ({ i, s: Number(r.score) || 0 }))
          .sort((a, b) => b.s - a.s || b.i - a.i)
          .slice(0, LOCAL_MAX)
          .map((x) => x.i),
      );
      rows = rows.filter((_, i) => keep.has(i));
    }
    lsSet(LOCAL_KEY, JSON.stringify(rows));
  }

  _localRank(level, score) {
    let better = 0;
    for (const r of this._loadLocal()) if (r.level === level && (Number(r.score) || 0) > score) better++;
    return better + 1;
  }

  _localTop(level, limit) {
    return this._loadLocal()
      .filter((r) => r.level === level)
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0)
        || String(a.created_at || '').localeCompare(String(b.created_at || '')))
      .slice(0, limit)
      .map((r) => ({
        name: sanitizeName(r.name),
        score: toInt(r.score, 0, MAX_SCORE),
        views: Number(r.views) || 0,
        time: r.time == null ? null : Number(r.time),
        created_at: r.created_at || null,
      }));
  }
}

function errMsg(err) {
  if (!err) return 'unknown error';
  if (err.name === 'AbortError') return 'network timeout';
  return String(err.message || err.details || err.hint || err.code || err);
}
