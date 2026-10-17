// Run directory: state.json (live, read by the dashboard), events.jsonl (full log), playbooks/, replays/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ledger, MODELS } from './llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUNS = process.env.STUNT_RUNS_DIR || path.join(HERE, 'runs');

export class RunLog {
  constructor(kind, config = {}) {
    const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}-${kind}`;
    this.id = id;
    this.dir = path.join(RUNS, id);
    fs.mkdirSync(path.join(this.dir, 'replays'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'playbooks'), { recursive: true });
    this.state = {
      runId: id, kind, startedAt: new Date().toISOString(), status: 'running', phase: kind,
      config: { ...config, models: MODELS },
      ledger: null, playbooks: [], rounds: [], live: {}, feed: [], eval: null, pings: [], log: [],
    };
    this.stream = fs.createWriteStream(path.join(this.dir, 'events.jsonl'), { flags: 'a' });
    this.saveTimer = null;
    fs.writeFileSync(path.join(RUNS, 'latest.json'), JSON.stringify({ runId: id }));
    const indexFile = path.join(RUNS, 'index.json');
    let index = [];
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { index = []; }
    index.unshift({ runId: id, kind, startedAt: this.state.startedAt, config });
    fs.writeFileSync(indexFile, JSON.stringify(index.slice(0, 200), null, 1));
    this.save(true);
  }

  log(kind, msg, data = {}) {
    const t = new Date().toISOString();
    this.stream.write(`${JSON.stringify({ t, kind, msg, ...data })}\n`);
    this.state.log.push({ t, kind, msg });
    if (this.state.log.length > 400) this.state.log.splice(0, this.state.log.length - 400);
    const tag = kind.padEnd(9);
    console.log(`${t.slice(11, 19)} ${tag} ${msg}`);
    this.save();
  }

  live(key, patch) {
    if (patch === null) delete this.state.live[key];
    else this.state.live[key] = { ...(this.state.live[key] || {}), ...patch, updated: Date.now() };
    this.save();
  }

  // every finished attempt, newest last: the 3D game's ?live mode plays these as they arrive
  feed(item) {
    this.state.feed.push({ t: new Date().toISOString(), ...item });
    if (this.state.feed.length > 300) this.state.feed.splice(0, this.state.feed.length - 300);
    this.save();
  }

  ping(task, message) {
    this.state.pings.push({ t: new Date().toISOString(), task, message });
    this.log('PING', `human attention: [${task}] ${message}`);
  }

  saveReplay(name, replay) {
    const rel = `replays/${name}.json`;
    fs.writeFileSync(path.join(this.dir, rel), JSON.stringify(replay));
    return `/school/runs/${this.id}/${rel}`;
  }

  savePlaybook(pb) {
    fs.writeFileSync(path.join(this.dir, 'playbooks', `v${pb.version}.json`), JSON.stringify(pb, null, 2));
  }

  save(now = false) {
    const write = () => {
      this.saveTimer = null;
      this.state.ledger = { calls: ledger.calls, promptTokens: ledger.promptTokens, completionTokens: ledger.completionTokens, byRole: ledger.byRole };
      const f = path.join(this.dir, 'state.json');
      const data = JSON.stringify(this.state);
      // Windows refuses to rename over a file another process (the dashboard, Vite) has open for a moment:
      // retry briefly, then fall back to a plain write. A failed save must never kill a run.
      for (let i = 0; i < 6; i++) {
        try {
          fs.writeFileSync(`${f}.tmp`, data);
          fs.renameSync(`${f}.tmp`, f);
          return;
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
      try { fs.writeFileSync(f, data); } catch { /* next save will catch up */ }
    };
    if (now) return write();
    if (!this.saveTimer) this.saveTimer = setTimeout(write, 400);
  }

  finish(status = 'done') {
    this.state.status = status;
    this.state.finishedAt = new Date().toISOString();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.save(true);
    this.stream.end();
  }
}

export function loadPlaybook(ref) {
  // "path/to/file.json" or "<runId>/vN" or "latest/vN"
  if (fs.existsSync(ref)) return JSON.parse(fs.readFileSync(ref, 'utf8'));
  const m = String(ref).match(/^(.+)\/v(\d+)$/);
  if (m) {
    const runId = m[1] === 'latest' ? JSON.parse(fs.readFileSync(path.join(RUNS, 'latest.json'), 'utf8')).runId : m[1];
    return JSON.parse(fs.readFileSync(path.join(RUNS, runId, 'playbooks', `v${m[2]}.json`), 'utf8'));
  }
  throw new Error(`playbook not found: ${ref}`);
}
