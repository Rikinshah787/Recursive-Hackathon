// Runs model-written code (controllers, spec checks, skill libraries) in an isolated vm context
// with per-call time limits. Not a security boundary; it keeps runaway loops and typos contained.
import vm from 'node:vm';

const CALL_MS = 250; // one controller tick (wall clock: generous so GC pauses or a busy machine never blame the pilot)
const FLIGHT_BUDGET_MS = 8000; // all ticks of one flight together

// Models sometimes emit typographic minus signs, dashes and non-breaking spaces in code; they are
// syntax errors in JS. Mapping them to ASCII is safe even inside strings (it only changes detail text).
export function normalizeCode(code) {
  return String(code || '')
    .replace(/[−‐‑‒–—﹣－]/g, '-')
    .replace(/[       ]/g, ' ')
    .replace(/[​﻿]/g, '');
}

// "Unexpected token" alone is useless feedback: report the line and a caret
export function syntaxError(code, filename = 'code.js') {
  try {
    new vm.Script(code, { filename });
    return null;
  } catch (err) {
    const where = String(err.stack || '').split('\n').slice(0, 3).join('\n');
    return `${err.message}\n${where}`.slice(0, 500);
  }
}

function context() {
  const logs = [];
  const ctx = vm.createContext({ console: { log: (...a) => logs.length < 20 && logs.push(a.map(String).join(' ').slice(0, 200)) } });
  return { ctx, logs };
}

export function compileController(code, skills = '') {
  code = normalizeCode(code);
  skills = normalizeCode(skills);
  const { ctx, logs } = context();
  new vm.Script(`${skills || ''}\n;\n${code}\n;globalThis.__control = typeof control === 'function' ? control : null;`, { filename: 'pilot.js' })
    .runInContext(ctx, { timeout: 1000 });
  if (!ctx.__control) throw new Error('the code must define `function control(obs, mem)`');
  const call = new vm.Script('globalThis.__out = __control(__obs, __mem);');
  let spent = 0;
  const control = (obs, mem) => {
    ctx.__obs = obs;
    ctx.__mem = mem;
    const t0 = performance.now();
    call.runInContext(ctx, { timeout: CALL_MS });
    spent += performance.now() - t0;
    if (spent > FLIGHT_BUDGET_MS) throw new Error(`controller too slow: over ${FLIGHT_BUDGET_MS} ms of compute in one flight`);
    return ctx.__out;
  };
  return { control, logs };
}

// spec check: function check(trace) -> [{ name, pass, detail }]
export function runCheck(code, trace) {
  code = normalizeCode(code);
  const bad = syntaxError(code, 'spec.js');
  if (bad) return { error: `syntax error in check(): ${bad}`, results: [] };
  const { ctx } = context();
  try {
    new vm.Script(`${code}\n;globalThis.__check = typeof check === 'function' ? check : null;`, { filename: 'spec.js' }).runInContext(ctx, { timeout: 1000 });
    if (!ctx.__check) return { error: 'spec code must define `function check(trace)`', results: [] };
    ctx.__trace = JSON.parse(JSON.stringify(trace));
    new vm.Script('globalThis.__res = JSON.stringify(__check(__trace));').runInContext(ctx, { timeout: 500 });
    const res = JSON.parse(ctx.__res ?? 'null');
    const list = Array.isArray(res) ? res : res && Array.isArray(res.results) ? res.results : null;
    if (!list || !list.length) return { error: 'check(trace) must return a non-empty array of { name, pass, detail }', results: [] };
    const results = list.map((r, i) => ({ name: String(r?.name ?? `check ${i + 1}`).slice(0, 120), pass: r?.pass === true, detail: String(r?.detail ?? '').slice(0, 200) }));
    return { pass: results.every((r) => r.pass), results };
  } catch (err) {
    return { error: `spec check threw: ${String(err?.message || err).slice(0, 300)}`, results: [] };
  }
}

// skills library must at least compile on its own
export function lintSkills(skills) {
  try {
    new vm.Script(skills || '', { filename: 'skills.js' }).runInContext(context().ctx, { timeout: 500 });
    return null;
  } catch (err) {
    return String(err?.message || err);
  }
}
