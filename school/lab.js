// The team's physics lab: short experiment flights the coach designs to measure how the car really
// behaves, and test flights that every skill must pass before it can enter the playbook.
import { runFlight } from './sim/runner.js';
import { compileController, runCheck } from './sandbox.js';
import { digest } from './digest.js';
import { STARTS } from './tasks.js';
import { endState } from './agents.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function flight(spec, skills) {
  const s = STARTS[spec.start] || STARTS.free;
  const task = { id: `lab-${spec.id || spec.name}`, start: s.start, fuel: 1, maxT: clamp(Number(spec.seconds) || 6, 1, 15) };
  try {
    const c = compileController(spec.code, skills);
    const { trace, replay } = runFlight({ task, control: c.control });
    // the verifier states the outcome up front so nobody has to dig it out of the timeline
    const f = trace.final;
    const outcome = `OUTCOME: ${endState(trace)} · at the end: wheels on ground ${f.wheels}, airborne ${f.airborne}, jets ${f.armed ? 'ON' : 'off'}, speed ${f.speed} m/s, upY ${f.upY}`;
    return { ok: !trace.controllerError, error: trace.controllerError?.message || null, trace, replay, digest: `${outcome}
${digest(trace, { every: 0.25, maxRows: 40 })}` };
  } catch (err) {
    return { ok: false, error: `compile error: ${String(err?.message || err).slice(0, 300)}`, trace: null, replay: null, digest: '' };
  }
}

export function runExperiment(exp, skills) {
  const r = flight(exp, skills);
  return { id: exp.id, question: exp.question, start: exp.start, seconds: exp.seconds, code: exp.code, ok: r.ok, error: r.error, digest: r.digest, trace: r.trace, replay: r.replay };
}

// a skill test passes only if its check() passes on the physical outcome of the flight
export function runSkillTest(test, skills) {
  const r = flight(test, skills);
  if (!r.trace) return { name: test.name, pass: false, error: r.error, results: [], digest: '' };
  const chk = runCheck(`${skills || ''}
;
${test.check || ''}`, r.trace); // checks may use the skill helpers too
  const error = r.error || chk.error || null;
  return { name: test.name, pass: !error && chk.pass === true, error, results: chk.results || [], digest: r.digest, replay: r.replay };
}

// Top-level `function name(...) { ... }` declarations of a skills library, with their source.
export function splitFunctions(src) {
  const out = [];
  const re = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', re.lastIndex);
    if (open < 0) break;
    let depth = 0, i = open, quote = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    out.push({ name: m[1], code: src.slice(m.index, i + 1) });
    re.lastIndex = i + 1;
  }
  return out;
}

/**
 * Keep only VERIFIED skills: a function survives if every test flight that calls it passed (and at least one
 * did), plus the helpers it depends on. Everything else falls back to the parent playbook's version, if any.
 * Returns { skills, kept: [...names], dropped: [...names] }.
 */
export function verifiedSkills(parentSrc, proposalSrc, tests, results) {
  const fns = splitFunctions(proposalSrc);
  const parent = splitFunctions(parentSrc || '');
  const names = fns.map((f) => f.name);
  const calls = (code) => names.filter((n) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\s*\\(`).test(code));
  const deps = new Map(fns.map((f) => [f.name, calls(f.code.slice(f.code.indexOf('{'))).filter((n) => n !== f.name)]));
  const status = new Map();
  tests.forEach((t, i) => {
    for (const n of calls(t.code || '')) {
      if (!results[i]?.pass) status.set(n, 'fail');
      else if (status.get(n) !== 'fail') status.set(n, 'pass');
    }
  });
  const keep = new Set();
  const stack = [...status].filter(([, v]) => v === 'pass').map(([n]) => n);
  while (stack.length) {
    const n = stack.pop();
    if (keep.has(n)) continue;
    keep.add(n);
    stack.push(...(deps.get(n) || []));
  }
  const byName = new Map(parent.map((f) => [f.name, f.code]));
  for (const f of fns) if (keep.has(f.name)) byName.set(f.name, f.code);
  const dropped = names.filter((n) => !keep.has(n));
  return { skills: [...byName.values()].join('\n\n'), kept: [...keep], dropped };
}

export function testSummary(t) {
  if (t.error) return `${t.name}: ERROR ${t.error}`;
  return `${t.name}: ${t.pass ? 'PASS' : 'FAIL'} [${t.results.map((r) => `${r.pass ? 'ok' : 'X'} ${r.name}${r.detail ? ` (${r.detail})` : ''}`).join('; ')}]`;
}
