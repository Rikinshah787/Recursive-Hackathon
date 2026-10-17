// VERSION N+1: train round -> coach rewrites the playbook -> candidate re-runs the train tasks -> keep
// the rewrite only if the score improves. Then compare v0 and the best version on held-out tasks.
import { runEpisode, summarize } from './episode.js';
import { coach, coachExperiments, coachFix } from './agents.js';
import { runExperiment, runSkillTest, testSummary, verifiedSkills, splitFunctions } from './lab.js';
import { lintSkills } from './sandbox.js';
import { TRAIN, TEST } from './tasks.js';

export const seedPlaybook = () => ({ version: 0, parent: null, insights: [], skills: '', skillTests: [], pilotGuidance: '', specGuidance: '', changelog: ['seed: empty playbook'] });

const taskScore = (e) => (e.referee.pass ? 1 : 0.6 * e.referee.progress);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

export async function runRound({ label, playbook, tasks, attempts, log, specCache, concurrency = 6 }) {
  log.log('round', `${label}: ${tasks.length} tasks with playbook v${playbook.version}`);
  const episodes = await pool(tasks, concurrency, async (task) => {
    const key = `${label.replace(/\s+/g, '_')}-${task.id}`;
    // an API failure is not a flying failure: retry the episode once after a pause before scoring it 0
    for (let tryNo = 0; tryNo < 2; tryNo++) {
      try {
        return await runEpisode({ task, playbook, maxAttempts: attempts, log, key, specCache });
      } catch (err) {
        log.log('error', `[${key}] episode failed${tryNo === 0 ? ' (retrying in 20 s)' : ''}: ${err.message}`);
        log.live(key, null);
        if (tryNo === 0) await new Promise((r) => setTimeout(r, 20000));
      }
    }
    return null;
  });
  const ok = episodes.filter(Boolean);
  const failedTasks = tasks.filter((_, i) => !episodes[i]).map((t) => t.id);
  const n = tasks.length;
  const round = {
    label, version: playbook.version, playbook, split: tasks[0]?.split,
    score: ok.reduce((s, e) => s + taskScore(e), 0) / n,
    passRate: ok.filter((e) => e.referee.pass).length / n,
    selfDone: ok.filter((e) => e.claimedDone).length,
    falseDone: ok.filter((e) => e.claimedDone && !e.referee.pass).length,
    missedDone: ok.filter((e) => !e.claimedDone && e.referee.pass).length,
    attemptsUsed: ok.reduce((s, e) => s + e.attempts.length, 0),
    failedTasks,
    episodes: ok,
  };
  log.state.rounds.push({ ...round, playbook: undefined, episodes: ok.map(summarize) });
  log.log('round', `${label}: score ${round.score.toFixed(3)} · referee pass ${Math.round(round.passRate * n)}/${n} · self-claimed done ${round.selfDone} (false ${round.falseDone}) · attempts ${round.attemptsUsed}`);
  return round;
}

function pbRecord(pb, extra = {}) {
  return { version: pb.version, parent: pb.parent, insights: pb.insights, skills: pb.skills, pilotGuidance: pb.pilotGuidance, specGuidance: pb.specGuidance, changelog: pb.changelog, analysis: pb.analysis || '', experiments: pb.experiments || [], skillTestResults: pb.skillTestResults || [], fixRound: !!pb.fixRound, ...extra };
}

export async function evolve({ gens = 3, attempts = 3, log, start = seedPlaybook(), baselineRepeats = 2 }) {
  const specCache = new Map();
  let current = start;
  log.savePlaybook(current);
  log.state.phase = 'train';
  let round = await runRound({ label: `train v${current.version}`, playbook: current, tasks: TRAIN, attempts, log, specCache });
  const evals = new Map([[current.version, [round.score]]]);
  // one round is a noisy sample: measure the starting playbook more than once so the gate is fair
  for (let i = 1; i < baselineRepeats; i++) {
    const again = await runRound({ label: `train v${current.version} #${i + 1}`, playbook: current, tasks: TRAIN, attempts, log, specCache });
    evals.get(current.version).push(again.score);
  }
  const startScore = evals.get(current.version).reduce((a, b) => a + b, 0) / evals.get(current.version).length;
  if (baselineRepeats > 1) log.log('gate', `v${current.version} baseline: ${evals.get(current.version).map((x) => x.toFixed(3)).join(', ')} -> mean ${startScore.toFixed(3)}`);
  log.state.playbooks.push(pbRecord(current, { accepted: true, score: startScore, baseline: null }));
  log.save();
  const history = [];
  const notebook = []; // measured facts survive rejected proposals
  const bank = new Map(); // verified skills survive rejected proposals
  let next = current.version + 1;
  for (let g = 1; g <= gens; g++) {
    log.log('coach', `generation ${g}: coach reviewing ${round.episodes.length} episodes from v${round.version}`);
    const version = next++;
    const flownWith = round.playbook || current;
    log.live('coach', { task: 'coach', goal: `generation ${g}: designing lab experiments`, version, stage: 'lab: designing experiments' });

    // 1. LAB: measure before you rewrite
    let experiments = [];
    try {
      const designs = await coachExperiments(current, round, history, flownWith, notebook);
      experiments = designs.map((x) => {
        const res = runExperiment(x, current.skills);
        const rep = res.replay ? log.saveReplay(`lab-v${version}-${x.id}`, { ...res.replay, meta: { kind: 'lab', task: 'lab', goal: `LAB: ${x.question}`, version, attempt: 0 } }) : null;
        if (rep) log.feed({ key: `lab-v${version}-${x.id}`, kind: 'lab', task: 'lab', goal: `LAB EXPERIMENT: ${x.question}`, version, attempt: 0, replay: rep, decision: { action: 'lab', reason: res.ok ? 'measured in the simulator' : res.error } });
        log.log('lab', `v${version} experiment ${x.id}: ${x.question.slice(0, 140)} -> ${res.ok ? 'ran' : `failed: ${res.error}`}`);
        return { ...res, replay: rep, trace: undefined };
      });
    } catch (err) {
      log.log('error', `lab design failed: ${err.message}`);
    }

    // 2. rewrite the playbook from the round + the measurements
    log.live('coach', { goal: `generation ${g}: rewriting the playbook`, stage: 'coach: rewriting playbook' });
    let proposal;
    try {
      proposal = await coach(current, round, history, flownWith, experiments, notebook, [...bank.values()]);
    } catch (err) {
      log.log('error', `coach failed: ${err.message}`);
      log.live('coach', null);
      continue;
    }

    // 3. every skill must pass a physical test flight; one fix round, then untested skills are dropped
    const testAll = (p) => {
      const lint = lintSkills(p.skills);
      if (lint) return { ok: false, all: [], results: [], lines: [`skills library does not compile: ${lint}`] };
      if (p.skills.trim() && p.skills.trim() !== current.skills.trim() && !p.skillTests.length) return { ok: false, all: [], results: [], lines: ['the skills changed but there are no skillTests'] };
      // the parent's verified tests ride along as regression tests
      const all = [...p.skillTests, ...(current.skillTests || []).filter((t) => !p.skillTests.some((x) => x.name === t.name))];
      const results = all.map((t) => runSkillTest(t, p.skills));
      return { ok: results.every((r) => r.pass), all, results, lines: results.map(testSummary) };
    };
    log.live('coach', { stage: 'lab: testing skills' });
    let tests = testAll(proposal);
    log.log('lab', `v${version} skill tests: ${tests.results.filter((r) => r.pass).length}/${tests.results.length} pass${tests.ok ? '' : ` · ${tests.lines.filter((l) => !/: PASS/.test(l)).join(' | ').slice(0, 300)}`}`);
    let fixRound = false;
    if (!tests.ok) {
      try {
        log.live('coach', { stage: 'coach: fixing failing skills' });
        const fixed = await coachFix(proposal, tests.lines, experiments);
        // tests are LOCKED in the fix round: rewriting a test to match a buggy skill is gaming, not fixing
        const changed = fixed.skillTests.filter((t) => { const o = proposal.skillTests.find((x) => x.name === t.name); return !o || o.code !== t.code || o.check !== t.check; });
        if (changed.length) log.log('lab', `v${version}: the coach edited ${changed.length} test(s) in the fix round; tests are locked, the original tests are used`);
        fixed.skillTests = proposal.skillTests;
        const t2 = testAll(fixed);
        log.log('lab', `v${version} after fix: ${t2.results.filter((r) => r.pass).length}/${t2.results.length} skill tests pass`);
        proposal = fixed;
        tests = t2;
        fixRound = true;
      } catch (err) {
        log.log('error', `coach fix failed: ${err.message}`);
      }
    }
    if (!tests.ok) {
      if (lintSkills(proposal.skills)) {
        proposal.skills = current.skills;
        proposal.skillTests = current.skillTests || [];
        proposal.changelog.push('(new skills dropped: the library did not compile)');
        log.log('lab', `v${version}: skills did not compile, keeping v${current.version}'s skills`);
      } else {
        // keep skill by skill: only functions whose test flights all passed (plus their helpers) survive
        const v = verifiedSkills(current.skills, proposal.skills, tests.all, tests.results);
        proposal.skills = v.skills;
        proposal.skillTests = tests.all.filter((t, i) => tests.results[i]?.pass);
        proposal.changelog.push(`(skills verified one by one: kept ${v.kept.join(', ') || 'none'}; dropped untested/failing ${v.dropped.join(', ') || 'none'})`);
        log.log('lab', `v${version}: kept verified skills [${v.kept.join(', ')}], dropped [${v.dropped.join(', ')}]`);
      }
    }
    // the lab notebook and the skill bank outlive this proposal, whatever the gate decides
    for (const x of experiments) {
      const f = (proposal.findings || []).find((y) => y.experiment === x.id);
      notebook.push({ version, id: x.id, question: x.question, ok: x.ok, error: x.error, finding: f ? f.finding : null });
    }
    if (tests.all) {
      const fns = splitFunctions(proposal.skills);
      tests.all.forEach((t, i) => {
        if (!tests.results[i]?.pass) return;
        for (const fn of fns) if (new RegExp(`\\b${fn.name}\\s*\\(`).test(t.code || '')) bank.set(fn.name, { name: fn.name, code: fn.code, test: t, version });
      });
    }
    log.state.notebook = notebook;
    log.state.skillBank = [...bank.values()].map((b) => ({ name: b.name, version: b.version, test: b.test.name }));
    // verified skills only accumulate: any banked skill the candidate does not define comes back in
    if (bank.size) {
      const have = new Set(splitFunctions(proposal.skills).map((f) => f.name));
      const back = [...bank.values()].filter((b) => !have.has(b.name));
      if (back.length) {
        proposal.skills = [proposal.skills.trim(), ...back.map((b) => b.code)].filter(Boolean).join('\n\n');
        proposal.skillTests = [...(proposal.skillTests || []), ...back.map((b) => b.test).filter((t) => !(proposal.skillTests || []).some((x) => x.name === t.name))];
        log.log('lab', `v${version}: restored verified skills from the bank: ${back.map((b) => b.name).join(', ')}`);
      }
    }
    log.live('coach', null);
    if (tests.ok && tests.all) proposal.skillTests = tests.all;
    const cand = { version, parent: current.version, ...proposal, experiments: experiments.map(({ digest, ...x }) => x), skillTestResults: tests.results.map((r) => ({ name: r.name, pass: r.pass, error: r.error, results: r.results })), fixRound };
    log.savePlaybook(cand);
    log.log('coach', `v${cand.version} proposed: ${cand.changelog.join(' / ').slice(0, 400)}`);
    const candRound = await runRound({ label: `train v${cand.version}`, playbook: cand, tasks: TRAIN, attempts, log, specCache });
    const base = evals.get(current.version);
    const baseline = base.reduce((a, b) => a + b, 0) / base.length;
    const accepted = candRound.score > baseline + 0.02;
    history.push({ version: cand.version, accepted, score: candRound.score, baseline, changelog: cand.changelog });
    log.state.playbooks.push(pbRecord(cand, { accepted, score: candRound.score, baseline }));
    log.log('gate', `v${cand.version} ${accepted ? 'KEPT' : 'REJECTED'}: train score ${candRound.score.toFixed(3)} vs v${current.version} ${baseline.toFixed(3)}`);
    if (accepted) {
      current = cand;
      evals.set(cand.version, [candRound.score]);
    }
    round = candRound; // the coach always studies the newest flights
  }
  log.state.best = current.version;
  log.save();
  return current;
}

export async function heldOut({ before, after, attempts = 3, log, repeats = 1 }) {
  log.state.phase = 'eval';
  const res = { before: [], after: [] };
  for (let r = 0; r < repeats; r++) {
    for (const [side, pb] of [['before', before], ['after', after]]) {
      const round = await runRound({ label: `test v${pb.version}${repeats > 1 ? ` #${r + 1}` : ''}`, playbook: pb, tasks: TEST, attempts, log, specCache: new Map() });
      res[side].push(round);
    }
  }
  const agg = (rounds) => ({
    version: rounds[0].version,
    score: rounds.reduce((s, r) => s + r.score, 0) / rounds.length,
    passRate: rounds.reduce((s, r) => s + r.passRate, 0) / rounds.length,
    falseDone: rounds.reduce((s, r) => s + r.falseDone, 0),
    attemptsUsed: rounds.reduce((s, r) => s + r.attemptsUsed, 0) / rounds.length,
    tasks: Object.fromEntries(TEST.map((t) => [t.id, rounds.map((r) => r.episodes.find((e) => e.task.id === t.id)).filter(Boolean).map((e) => ({ pass: e.referee.pass, progress: e.referee.progress, attempts: e.attempts.length, claimedDone: e.claimedDone }))])),
  });
  log.state.eval = { before: agg(res.before), after: agg(res.after), repeats };
  log.log('eval', `HELD-OUT: v${before.version} score ${log.state.eval.before.score.toFixed(3)} pass ${(log.state.eval.before.passRate * 100).toFixed(0)}%  ->  v${after.version} score ${log.state.eval.after.score.toFixed(3)} pass ${(log.state.eval.after.passRate * 100).toFixed(0)}%`);
  return log.state.eval;
}
