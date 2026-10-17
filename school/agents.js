// The agent team. Each role is one Crusoe model call with its own prompt.
//   SPEC WRITER  goal -> executable definition of done (check(trace))
//   AUDITOR      independent model: hunts loopholes in the spec, sees probe-flight results
//   PILOT        writes the controller program that flies the car
//   COACH        after a training round, rewrites the team playbook (insights, skills, prompts)
import { chat, extractCode, extractJson } from './llm.js';
import { ARENA_MAP, STARTS } from './tasks.js';

// What a human player knows: the game's controls page, expressed as the program interface.
export const CONTROL_API = `You write a JavaScript controller:  function control(obs, mem) { ...; return cmd; }
It is called 60 times per simulated second. \`mem\` is a plain object that persists between calls
(use it for phases / state machines). No imports, no async, no Date/random; each call must be fast.

obs (metres, m/s, radians):
  t              seconds since the start
  pos {x,y,z}    car centre (a car parked on the floor has y ~ 0.49)
  vel {x,y,z}    velocity;  speed = |vel|;  forwardSpeed = velocity along the nose (negative = rolling backwards)
  heading        yaw: 0 faces +z, +PI/2 faces +x, -PI/2 faces -x, +-PI faces -z
  pitch          nose angle (+ = nose up);  bank = sideways tilt
  up {x,y,z}     the car's up vector; upY = up.y (1 upright, < 0 upside down)
  altitude       height of the car's underside above the floor/surface below it
  airborne       true when nothing touches the car
  wheelsOnGround 0..4 wheels touching a surface
  armed          true while the jet thrusters are on
  gas            jet fuel 0..1 (burns while the jets are on)
  trickActive    true while a flip / roll trick is in progress
  surface        last surface touched: 'ground' | 'kicker' | 'truck' | 'megawall' | 'cloop' | 'lineup' | 'backdrop'
                 ('ground' is the whole floor INCLUDING the stage and the landing pad: use positions to tell them apart)
  wallGrip       > 0 while riding a steep surface (the side jets press the car onto it)
  events         physics events since the previous call, e.g. {type:'leave', surface:'kicker', speed},
                 {type:'land', upright, onWheels, vy}, {type:'impact'}, {type:'trick'}, {type:'ring', ring}, {type:'crash', reason}

cmd (missing fields count as 0 / false):
  throttle 0..1      drive forward (W key). Needs wheels on a surface.
  brake 0..1         brake; once (nearly) stopped it reverses (S key)
  steer -1..1        +1 turns RIGHT (heading decreases), -1 turns LEFT. Works on the ground and in the air.
  lift -1..1         jet thrusters (SPACE/SHIFT). Positive fires the jets and climbs; with flight assist the car
                     holds its altitude when lift is 0; negative descends.
  pitch -1..1        in the air: +1 tilts the nose down (fly forward), -1 tilts it up (slow down / back up)
  roll -1..1         in the air: bank / strafe sideways
  handbrake bool     handbrake on the ground (drifts)
  thrustLevel 0.25..1  thrust lever: caps jet power (default 0.6)
  assist bool        flight assist (default true = self-levelling, altitude hold). false = acro mode
  trick              'flip' (front flip) | 'backflip' | 'roll' (barrel roll / kickflip): starts a 360° trick in the air
                     (you need to be in the air, a bit above the ground)

Game rules (the referee): hitting the truck faster than 6 m/s, hitting the floor/walls hard, landing upside down
or on the side, or lying on the roof for 1.4 s is a CRASH, and the run ends 1 s later.`;

export const TRACE_SCHEMA = `trace = {                // exact field names and TYPES; nothing else exists
  duration: number,            // seconds simulated (the run stops 1 s after a crash)
  crashed: boolean,            // the referee's crash call (same rules as the game); false when there was no crash
  crashReason: string | null,  // e.g. 'HIT THE TRUCK', 'LANDED UPSIDE DOWN'; null when crashed is false
  controllerError: null | { t: number, message: string },   // the pilot's program threw
  maxY: number, maxAlt: number, maxSpeed: number,
  final: { t, x, y, z, speed, upY, heading, alt, gas: number; wheels: integer 0..4; airborne: boolean; armed: boolean; surface: string },
  samples: [ { t, x, y, z, vx, vy, vz, speed, heading, alt, upY, gas: number; wheels: integer; airborne, armed: boolean; surface: string } ],  // 10 per second, may be empty
  events: [ { t: number, type: string, ... } ],
      // 'leave' {surface, speed, y} · 'land' {surface, upright: number (up.y at touchdown), onWheels: boolean, vy: number (impact speed, positive), airTime, x, z}
      // 'impact' · 'trick' {trick: 'flip'|'backflip'|'roll'} (a trick STARTED) · 'ring' {ring: 0|1|2} · 'crash' {reason}
  flights: [ {                 // every continuous stretch with nothing touching the car for > 0.3 s (may be empty)
    t0, t1, duration: number, from: string /*surface it left*/, start: {x,y,z}, end: {x,y,z} /*where it touched down*/, maxY, maxAlt: number,
    pitchDeg, rollDeg, yawDeg: number,   // total rotation in the air (pitchDeg > 0 = front flip direction)
    tricks: string[],          // completed rotations: 'FRONT FLIP' | 'BACKFLIP' | 'BARREL ROLL'
    overTruck: boolean, minTruckClearance: number | null,  // passed over the truck trailer; lowest clearance above its roof (m)
    landSurface: string, landUpright: number /*up.y at touchdown, 1 = upright*/, landVy: number | null, crashedOnLanding: boolean } ],
  rings: [ { ring: 0|1|2, t: number } ]   // flight rings passed through
}
Surface ids are ONLY: 'ground' | 'kicker' | 'truck' | 'megawall' | 'cloop' | 'lineup' | 'backdrop'.
'ground' is the whole floor INCLUDING the stage and the landing pad (there is no 'stage' or 'pad' surface): use x/z positions.
A car resting on the floor: y ~ 0.49 (~0.99 on the stage), upY ~ 1, wheels 4, speed ~ 0, airborne false, usually armed false.
A car still hovering on its jets just above the floor has airborne true and wheels 0: that is NOT landed.`;

const SPEC_SYSTEM = `You are the SPEC WRITER on an autonomous stunt-driving agent team. Before anyone flies, you turn a
one-line goal into an executable definition of done that the team can check WITHOUT a human:
a pure JavaScript function check(trace) over the flight trace below, returning an array of
{ name, pass, detail } — one entry per criterion. The flight counts as done only if every entry passes.

${TRACE_SCHEMA}

${ARENA_MAP}

Rules:
1. Check what the goal actually asks for, including the end state it implies ("land" = the car ends at rest
   upright on its wheels on the floor and did not crash; "park" = stopped).
2. A crashed flight never passes.
3. Do not invent requirements the goal does not imply (no time limits, no style points). Allow sensible
   tolerances for noise, but never so loose that the goal could be missed.
4. Put the measured values in each detail string ("final speed 3.2 m/s > 0.6") so the pilot can fix it.
5. Use only the fields documented above; guard against empty arrays; no globals, no randomness.
Answer with a short CRITERIA list (one line each), then exactly one \`\`\`js block with function check(trace).`;

export async function writeSpec(task, { guidance = '', feedback = null, previous = null } = {}) {
  const user = [`GOAL: ${task.goal}`, `START: (${task.start.x}, ${task.start.z}) heading ${task.start.heading.toFixed(3)}, jet fuel ${task.fuel}, time limit ${task.maxT} s`];
  if (guidance) user.push(`TEAM SPEC GUIDANCE (lessons from earlier runs):\n${guidance}`);
  if (previous) user.push(`YOUR PREVIOUS SPEC:\n\`\`\`js\n${previous}\n\`\`\``);
  if (feedback) user.push(`FIX THESE ISSUES:\n${feedback}`);
  const r = await chat({ role: 'spec', messages: [{ role: 'system', content: SPEC_SYSTEM }, { role: 'user', content: user.join('\n\n') }], maxTokens: 6000, temperature: 0.3 });
  const code = extractCode(r.text);
  const criteria = (r.text.split('```')[0].match(/^\s*(?:[-*]|\d+[.)])\s+.+$/gm) || []).map((s) => s.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).slice(0, 10);
  return { code, criteria, raw: r.text };
}

const AUDIT_SYSTEM = `You are the AUDITOR, an independent verifier on a stunt-driving agent team. A different model wrote a
definition of done (a check(trace) function) for a one-line goal. Your job is to stop the team from
declaring victory on a flight that did not really achieve the goal, and from failing one that did.

${TRACE_SCHEMA}

${ARENA_MAP}

Look for:
(a) LOOPHOLES: a flight that passes every check but clearly does not achieve the goal (missing end state,
    missing crash check, wrong object/ring/zone, tolerance far too loose, checks the wrong moment).
(b) OVER-STRICT checks: a flight that genuinely achieves the goal but fails (requirements the goal never
    asked for, wrong field names, wrong signs/units, impossible thresholds).
(c) BUGS: check EVERY field name, type and literal against the schema: booleans compared with null, numbers
    compared with true, surface ids that do not exist (there is no 'stage' or 'pad' surface), crashes on empty arrays.
    A check that can never pass for any flight is a bug.
You also get the results of running the spec on probe flights. A do-nothing flight must FAIL.
Reply with only JSON: {"verdict": "approve" | "revise", "issues": ["...", "..."]}. Approve if the issues are minor.`;

export async function auditSpec(task, spec, probes) {
  const user = [
    `GOAL: ${task.goal}`,
    `SPEC CRITERIA:\n${spec.criteria.map((c) => `- ${c}`).join('\n') || '(none listed)'}`,
    `SPEC CODE:\n\`\`\`js\n${spec.code}\n\`\`\``,
    `PROBE FLIGHTS (deterministic, run by the verifier):\n${probes.map((p) => `- ${p.name}: ${p.summary}\n  spec says: ${p.result.error ? `ERROR ${p.result.error}` : `${p.result.pass ? 'PASS' : 'FAIL'} [${p.result.results.map((r) => `${r.pass ? 'ok' : 'X'} ${r.name}`).join('; ')}]`}`).join('\n')}`,
  ];
  const r = await chat({ role: 'auditor', messages: [{ role: 'system', content: AUDIT_SYSTEM }, { role: 'user', content: user.join('\n\n') }], maxTokens: 3000, temperature: 0.2, json: true });
  const j = extractJson(r.text) || {};
  return { verdict: j.verdict === 'revise' ? 'revise' : 'approve', issues: Array.isArray(j.issues) ? j.issues.map(String).slice(0, 8) : [], raw: r.text };
}

const DISPUTE_SYSTEM = `You are the AUDITOR on a stunt-driving agent team. The PILOT disputes the team's definition of done.
Decide independently. Side with the pilot ONLY if the disputed check is actually wrong: it can never pass for any
flight, reads a field / surface / type that does not exist in the schema, or demands something the goal does not
imply. If the check is correct and the pilot simply has not achieved it yet, keep it.

${TRACE_SCHEMA}

${ARENA_MAP}

Reply with only JSON: {"verdict": "fix" | "keep", "issues": ["exact problems the spec writer must fix"]}`;

export async function reviewDispute(task, spec, issue, attempt) {
  const user = [
    `GOAL: ${task.goal}`,
    `SPEC CODE:\n\`\`\`js\n${spec.code}\n\`\`\``,
    `PILOT'S DISPUTE: ${issue}`,
    `RESULTS ON THE PILOT'S LAST FLIGHT:\n${attempt.check.results.map((r) => `${r.pass ? 'ok' : 'X'} ${r.name}: ${r.detail}`).join('\n')}`,
    `FLIGHT REPORT:\n${attempt.digest.split('\n').slice(0, 30).join('\n')}`,
  ];
  const r = await chat({ role: 'auditor', messages: [{ role: 'system', content: DISPUTE_SYSTEM }, { role: 'user', content: user.join('\n\n') }], maxTokens: 3000, temperature: 0.2, json: true });
  const j = extractJson(r.text) || {};
  return { verdict: j.verdict === 'fix' ? 'fix' : 'keep', issues: Array.isArray(j.issues) ? j.issues.map(String).slice(0, 6) : [] };
}

function playbookText(pb) {
  const parts = [];
  if (pb.insights?.length) parts.push(`TEAM INSIGHTS (learned from earlier flights):\n${pb.insights.map((i) => `- ${i.text}`).join('\n')}`);
  if (pb.skills?.trim()) parts.push(`SKILLS LIBRARY (these functions are already defined in your program's scope; call them, do not redefine them):\n\`\`\`js\n${pb.skills.trim()}\n\`\`\``);
  return parts.join('\n\n') || 'TEAM PLAYBOOK: (empty: this team has no experience yet)';
}

const PILOT_SYSTEM = (pb) => `You are the PILOT on an autonomous stunt-driving agent team. You fly a jet-powered roadster by
writing a controller program; the verifier runs it in a deterministic physics simulator and checks the
result against the team's definition of done.

${CONTROL_API}

${ARENA_MAP}

${playbookText(pb)}
${pb.pilotGuidance ? `\nTEAM GUIDANCE:\n${pb.pilotGuidance}\n` : ''}
Answer with PLAN: (2-5 short lines: the phases of your flight and what you change from earlier attempts),
then exactly one \`\`\`js block that defines function control(obs, mem). Keep it under 160 lines.
If you are convinced a check in the definition of done is WRONG (it can never pass, uses a field or surface that
does not exist, or contradicts the goal), add one line before the code: SPEC ISSUE: <what is wrong and why>.
An independent auditor reviews it. Checks are never relaxed just because the stunt is hard.`;

export async function pilot(task, spec, playbook, history, directive) {
  const user = [
    `GOAL: ${task.goal}`,
    `START: car at (${task.start.x}, 0, ${task.start.z}) heading ${task.start.heading.toFixed(3)} on its wheels, jet fuel ${task.fuel}, time limit ${task.maxT} s`,
    `DEFINITION OF DONE (the verifier runs exactly these checks):\n${spec.criteria.map((c) => `- ${c}`).join('\n')}\n\`\`\`js\n${spec.code}\n\`\`\``,
  ];
  if (history.length) {
    const lines = history.map((h, i) => {
      const fails = h.check.results.filter((r) => !r.pass).map((r) => `${r.name} (${r.detail})`).join('; ');
      return `attempt ${i + 1}: ${h.check.pass ? 'PASSED' : `failed: ${fails || h.check.error || 'unknown'}`}${h.trace.crashed ? ` · CRASH: ${h.trace.crashReason}` : ''}\n  plan: ${h.plan.replace(/\n/g, ' ').slice(0, 300)}`;
    });
    user.push(`EARLIER ATTEMPTS IN THIS EPISODE:\n${lines.join('\n')}`);
    const base = directive?.baseIndex != null ? history[directive.baseIndex] : history[history.length - 1];
    const label = directive?.baseIndex != null ? `attempt ${directive.baseIndex + 1} (your best so far)` : 'your last attempt';
    user.push(`FLIGHT REPORT of ${label}:\n${base.digest}`);
    user.push(`CODE of ${label}:\n\`\`\`js\n${base.code}\n\`\`\``);
  }
  if (directive?.message) user.push(`WATCHDOG: ${directive.message}`);
  const r = await chat({ role: 'pilot', messages: [{ role: 'system', content: PILOT_SYSTEM(playbook) }, { role: 'user', content: user.join('\n\n') }], maxTokens: 8000, temperature: 0.5 });
  const code = extractCode(r.text);
  const head = r.text.split('```')[0];
  const issue = head.match(/SPEC ISSUE:\s*(.+)/i);
  const plan = (head.replace(/SPEC ISSUE:.*$/im, '').replace(/^[\s\S]*?PLAN:?/i, '') || '').trim().slice(0, 800);
  const issueText = issue ? issue[1].trim() : '';
  const realIssue = issueText && !/^(none|n\/?a|no( spec)? issues?|nothing)\b/i.test(issueText) ? issueText.slice(0, 600) : null;
  return { code, plan, specIssue: realIssue, raw: r.text };
}

const START_LIST = Object.entries(STARTS).map(([k, s]) => `'${k}': ${s.label}`).join('; ');

const COACH_RULES = `The playbook has:
- insights: short, concrete facts or rules about the car, controls and arena, each backed by evidence
  (an experiment result or a flight report; cite which),
- skills: a small JavaScript library of helper functions placed in every pilot program's scope
  (pure functions of (obs, mem, ...args) returning numbers or cmd objects),
- skillTests: test flights that PROVE each skill does what its name says, judged on the physical outcome,
- pilotGuidance: extra instructions appended to the pilot prompt (how to plan, structure code, react),
- specGuidance: general lessons for the spec writer (only if self-checks disagreed with the referee).

${CONTROL_API}

${ARENA_MAP}

Start presets for experiments and tests: ${START_LIST}.

Rules: keep it lean (at most 14 insights, at most ~170 lines of skills). The team will be tested on NEW stunts it has
never seen, so every lesson must be GENERAL: about the car, the controls, flying, landing, reading the flight report
or writing checks. Never name a training task or hard-code its coordinates or thresholds in insights, guidance or
skills (arena facts from the map are fine). specGuidance must be general principles for turning ANY goal into
checks (e.g. how to read "between A and B", what "land" implies, which tolerances are fair), never per-task criteria.
Do not repeat ideas that were tried and rejected. Skills must be valid plain JavaScript (function declarations only)
and must never loop unboundedly (no while loops on angles; use Math.atan2(Math.sin(a), Math.cos(a)) to wrap).
Never state a sign convention or a number as fact unless an experiment or flight report shows it.`;

const LAB_SYSTEM = `You are the COACH of an autonomous stunt-flying agent team (Version N+1). Before you rewrite the team
playbook you can run up to 4 short EXPERIMENTS in the physics simulator to MEASURE how the car really behaves,
so the playbook rests on evidence instead of guesses (e.g. which way steer +1 turns the heading on the ground and
in the air, what lift 0 / 0.5 / -0.5 does to altitude, how fast pitch +1 accelerates, how far braking takes,
what happens to forwardSpeed when you brake after stopping). Pick the questions behind the failures you see.

${COACH_RULES}

Each experiment is a controller program (same API as the pilot; the current skills library is in scope).
Make it do ONE simple thing so the result is easy to read; you get back a timeline sampled every 0.25 s.
Reply with exactly one \`\`\`json block:
{"experiments": [{"id": "steer-sign-ground", "question": "...", "start": "free", "seconds": 5,
  "code": "function control(obs, mem) { ... }"}]}`;

const COACH_SYSTEM = `You are the COACH of an autonomous stunt-flying agent team (Version N+1). After each training round you
rewrite the team PLAYBOOK that every pilot reads before it flies. Your rewrite is kept ONLY if the team scores
better on the next round, so target the failures you actually see, and build on what your experiments measured.

${COACH_RULES}

Every skill needs at least one skillTest: a short flight (<= 12 s) whose check() judges the PHYSICAL outcome, e.g. a
steering helper must actually bring the heading to the target, an altitude helper must actually hold the altitude,
a landing helper must actually end with the car resting on its wheels. A skill whose tests fail is thrown away.
check(trace) gets the flight trace: { duration, crashed, crashReason, maxY, maxAlt, final: {x,y,z,speed,upY,heading,alt,
wheels,airborne,armed,gas,surface}, samples: [{t,x,y,z,vx,vy,vz,speed,heading,alt,upY,wheels,airborne,armed,gas,surface}],
events, flights } and returns [{ name, pass, detail }].
Reply with exactly one \`\`\`json block:
{"analysis": "what went wrong and why, and what the experiments showed (<= 150 words)",
 "insights": [{"id": "short-id", "text": "...", "evidence": "experiment id or task/attempt"}],
 "skills": "full JS source of the new skills library",
 "skillTests": [{"name": "...", "start": "free", "seconds": 8, "code": "function control(obs, mem) { ... }",
                 "check": "function check(trace) { return [{ name: '...', pass: ..., detail: '...' }]; }"}],
 "findings": [{"experiment": "experiment id from LAB RESULTS", "finding": "one line: what it measured, with numbers"}],
 "pilotGuidance": "...",
 "specGuidance": "...",
 "changelog": ["one line per change"]}`;

// The coach embeds whole JS libraries in JSON strings; one bad escape breaks a hand-written block.
// JSON mode makes the server guarantee valid JSON; one retry covers the rest.
export const coachRaw = [];
async function coachJson(messages, maxTokens, temperature) {
  for (let i = 0; i < 2; i++) {
    const r = await chat({ role: 'coach', messages, maxTokens, temperature, json: true });
    const j = extractJson(r.text);
    coachRaw.push({ t: new Date().toISOString(), ok: !!j, finish: r.finish || null, text: r.text });
    if (j) return j;
  }
  throw new Error('coach returned unparseable JSON twice');
}

const pbJson = (pb) => JSON.stringify({ insights: pb.insights, skills: pb.skills, pilotGuidance: pb.pilotGuidance, specGuidance: pb.specGuidance }, null, 1);

// The verifier's statistics: how did the flights END? (the coach otherwise reads them one by one)
export function endState(trace) {
  const f = trace.final;
  const last = trace.samples[trace.samples.length - 1];
  const alt = last ? last.alt : null;
  if (trace.controllerError) return 'program error';
  if (trace.crashed) return `crashed (${trace.crashReason})`;
  if ((f.airborne || f.wheels < 3) && f.armed && alt != null && alt < 0.6) return `never landed: hovering just above the floor (altitude ${alt.toFixed(2)} m) with the jets still on`;
  if (f.airborne || (f.armed && f.wheels < 3)) return 'never landed: still flying / in the air at the end';
  if (f.speed > 2.5) return 'on the ground but still moving at the end';
  return 'came to rest on its wheels';
}

function failureCensus(round) {
  const counts = new Map();
  let n = 0;
  for (const e of round.episodes) for (const a of e.attempts) {
    const k = endState(a.trace).replace(/ \(.*?\)/g, '');
    counts.set(k, (counts.get(k) || 0) + 1);
    n++;
  }
  const lines = [...counts].sort((a, b) => b[1] - a[1]).map(([k, c]) => `- ${c}/${n} attempts: ${k}`);
  return `FAILURE CENSUS (how all ${n} flights of the round ended, counted by the verifier):\n${lines.join('\n')}`;
}

function notebookText(notebook) {
  if (!notebook?.length) return 'LAB NOTEBOOK: empty (nothing measured yet).';
  return `LAB NOTEBOOK (facts measured in earlier generations; they stay true even if that playbook was rejected; do NOT re-measure them, build on them):\n${notebook.map((x) => `- [v${x.version} ${x.id}] ${x.question} -> ${x.finding || (x.ok ? 'ran (no finding recorded)' : `failed: ${x.error}`)}`).join('\n')}`;
}

function bankText(bank) {
  if (!bank?.length) return '';
  return `VERIFIED SKILL BANK (functions that passed their physical test flights in earlier generations; you may reuse them verbatim, with their tests):\n${bank.map((b) => `### ${b.name} (verified in v${b.version}, test: ${b.test.name})\n\`\`\`js\n${b.code}\n\`\`\``).join('\n')}`;
}

function roundText(playbook, round, history, flownWith) {
  const tasks = round.episodes.map((e) => {
    const best = e.attempts[e.best] || e.attempts[e.attempts.length - 1];
    const parts = [
      `### ${e.task.id}: ${e.task.goal}`,
      `referee: ${e.referee.pass ? 'PASS' : 'FAIL'} (progress ${e.referee.progress.toFixed(2)}) · team self-check said: ${e.claimedDone ? 'DONE' : 'not done'} · attempts ${e.attempts.length}`,
      ...e.attempts.map((a, i) => `attempt ${i + 1}: ${a.check.pass ? 'self-check PASS' : 'self-check fail'} · referee ${a.referee.pass ? 'pass' : 'fail'}${a.trace.crashed ? ` · CRASH ${a.trace.crashReason}` : ''}${a.trace.controllerError ? ` · PROGRAM ERROR ${a.trace.controllerError.message.slice(0, 120)}` : ''} · failed: ${a.check.results.filter((r) => !r.pass).map((r) => r.name).join('; ') || '-'}\n   plan: ${a.plan.replace(/\n/g, ' ').slice(0, 220)}`),
    ];
    if (best) {
      parts.push(`flight report of attempt ${e.attempts.indexOf(best) + 1}:\n${best.digest.split('\n').slice(0, 40).join('\n')}`);
      parts.push(`code of attempt ${e.attempts.indexOf(best) + 1}:\n\`\`\`js\n${(best.code || '').slice(0, 4500)}\n\`\`\``);
    }
    return parts.join('\n');
  });
  const hist = history.length
    ? history.map((h) => `v${h.version} ${h.accepted ? 'KEPT' : 'REJECTED'} (train score ${h.score.toFixed(3)} vs ${h.baseline.toFixed(3)}): ${h.changelog.join(' / ')}`).join('\n')
    : '(no earlier proposals)';
  const parts = [failureCensus(round), `CURRENT PLAYBOOK v${playbook.version} (the one you are editing):\n\`\`\`json\n${pbJson(playbook)}\n\`\`\``];
  if (flownWith.version !== playbook.version) {
    parts.push(`The flights below were flown with proposal v${flownWith.version}, which was REJECTED (it scored worse than v${playbook.version}). Its content, so you can see which of its ideas hurt:\n\`\`\`json\n${pbJson(flownWith)}\n\`\`\``);
  }
  parts.push(`TRAINING ROUND RESULTS with v${flownWith.version} (score ${round.score.toFixed(3)}):\n${tasks.join('\n\n')}`, `EARLIER PROPOSALS:\n${hist}`);
  return parts.join('\n\n');
}

export async function coachExperiments(playbook, round, history, flownWith = playbook, notebook = []) {
  const user = `${roundText(playbook, round, history, flownWith)}\n\n${notebookText(notebook)}\n\nStart from the FAILURE CENSUS: design experiments about the most common way flights end badly.`;
  const j = await coachJson([{ role: 'system', content: LAB_SYSTEM }, { role: 'user', content: user }], 20000, 0.4);
  const list = Array.isArray(j?.experiments) ? j.experiments : [];
  return list.slice(0, 4).map((x, i) => ({
    id: String(x.id || `exp${i + 1}`).replace(/[^\w-]/g, '').slice(0, 40) || `exp${i + 1}`,
    question: String(x.question || '').slice(0, 300),
    start: STARTS[x.start] ? x.start : 'free',
    seconds: Math.max(1, Math.min(15, Number(x.seconds) || 6)),
    code: String(x.code || ''),
  })).filter((x) => x.code);
}

function labText(experiments) {
  if (!experiments?.length) return 'LAB: no experiments were run this generation.';
  return `LAB RESULTS (measured in the simulator this generation):\n${experiments.map((x) => `### experiment ${x.id}: ${x.question}\nstart ${x.start}, ${x.seconds} s\n\`\`\`js\n${x.code.slice(0, 1500)}\n\`\`\`\n${x.ok ? x.digest : `FAILED TO RUN: ${x.error}`}`).join('\n\n')}`;
}

function parsePlaybook(j) {
  return {
    analysis: String(j.analysis || '').slice(0, 1500),
    insights: (Array.isArray(j.insights) ? j.insights : []).slice(0, 14).map((i, k) => ({ id: String(i.id || `i${k + 1}`).slice(0, 40), text: String(i.text || i).slice(0, 400), evidence: String(i.evidence || '').slice(0, 120) })),
    skills: String(j.skills || ''),
    skillTests: (Array.isArray(j.skillTests) ? j.skillTests : []).slice(0, 12).map((t, k) => ({
      name: String(t.name || `test${k + 1}`).slice(0, 80), start: STARTS[t.start] ? t.start : 'free',
      seconds: Math.max(1, Math.min(12, Number(t.seconds) || 8)), code: String(t.code || ''), check: String(t.check || ''),
    })),
    pilotGuidance: String(j.pilotGuidance || '').slice(0, 2000),
    specGuidance: String(j.specGuidance || '').slice(0, 1500),
    findings: (Array.isArray(j.findings) ? j.findings : []).slice(0, 8).map((f) => ({ experiment: String(f.experiment || f.id || '').slice(0, 60), finding: String(f.finding || f.text || '').slice(0, 300) })),
    changelog: (Array.isArray(j.changelog) ? j.changelog : []).map(String).slice(0, 12),
  };
}

export async function coach(playbook, round, history, flownWith = playbook, experiments = [], notebook = [], bank = []) {
  const user = [roundText(playbook, round, history, flownWith), notebookText(notebook), labText(experiments), bankText(bank)].filter(Boolean).join('\n\n');
  const j = await coachJson([{ role: 'system', content: COACH_SYSTEM }, { role: 'user', content: user }], 32000, 0.4);
  return parsePlaybook(j);
}

// second chance: the coach sees which skill tests failed and fixes the skills (or the tests)
export async function coachFix(proposal, failures, experiments = []) {
  const user = [
    `YOUR PROPOSED PLAYBOOK:\n\`\`\`json\n${JSON.stringify({ ...proposal, analysis: undefined }, null, 1)}\n\`\`\``,
    `SKILL TEST RESULTS (run in the simulator):\n${failures.join('\n')}`,
    labText(experiments),
    'Fix the SKILLS that fail their tests (a failing test usually means a wrong sign, wrong units or a wrong assumption about the controls; read the timeline and the lab results). The tests are LOCKED: they were written before you saw any results and any change you make to them is ignored. Return the full corrected playbook in the same JSON format.',
  ];
  const j = await coachJson([{ role: 'system', content: COACH_SYSTEM }, { role: 'user', content: user.join('\n\n') }], 32000, 0.3);
  return parsePlaybook(j);
}
