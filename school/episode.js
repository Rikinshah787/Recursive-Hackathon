// DONE MEANS DONE: one goal -> audited, executable definition of done -> pilot attempts checked by the
// verifier -> a watchdog that spots loops and drift and decides continue / re-plan / revert / stop / ping.
import { runFlight } from './sim/runner.js';
import { compileController, runCheck, syntaxError, normalizeCode } from './sandbox.js';
import { digest, signature } from './digest.js';
import { writeSpec, auditSpec, pilot, reviewDispute } from './agents.js';

const idle = () => ({});
const floorIt = () => ({ throttle: 1 });

function probeSummary(trace) {
  const f = trace.final;
  return `${trace.crashed ? `crashed (${trace.crashReason})` : 'no crash'}, ended at (${f.x}, ${f.y}, ${f.z}) speed ${f.speed} upY ${f.upY}, maxY ${trace.maxY}, ${trace.flights.length} air segments, rings ${trace.rings.map((r) => r.ring).join(',') || 'none'}`;
}

// Spec phase: write -> probe -> independent audit -> revise (max 2 revisions)
export async function makeSpec(task, playbook, { log, key }) {
  const guidance = playbook.specGuidance || '';
  const probes = [
    { name: 'do-nothing flight (no input at all)', trace: runFlight({ task, control: idle }).trace },
    { name: 'floor-it flight (full throttle straight ahead, nothing else)', trace: runFlight({ task, control: floorIt }).trace },
  ];
  let spec = await writeSpec(task, { guidance });
  const audits = [];
  let fresh = 0;
  for (let round = 0; ; round++) {
    const issues = [];
    let ran = [];
    if (!spec.code) issues.push('No ```js block with function check(trace) was found.');
    else {
      ran = probes.map((p) => ({ name: p.name, summary: probeSummary(p.trace), result: runCheck(spec.code, p.trace) }));
      for (const p of ran) if (p.result.error) issues.push(`On the ${p.name} your check errors: ${p.result.error}`);
      if (ran[0].result.pass) issues.push('A do-nothing flight PASSES your spec, so it cannot tell success from failure.');
    }
    let audit = { verdict: 'approve', issues: [] };
    if (spec.code && !issues.length) audit = await auditSpec(task, spec, ran);
    if (audit.verdict === 'revise') issues.push(...audit.issues);
    audits.push({ round, auto: issues.length - (audit.verdict === 'revise' ? audit.issues.length : 0), verdict: issues.length ? 'revise' : 'approve', issues });
    log.log('auditor', `[${key}] spec round ${round + 1}: ${issues.length ? `REVISE: ${issues.map((s) => s.slice(0, 120)).join(' | ')}` : `approved (${spec.criteria.length} criteria)`}`);
    log.live(key, { stage: issues.length ? 'spec: revising' : 'spec: approved' });
    if (!issues.length) break;
    if (round >= 2) {
      if (!spec.code || ran.some((p) => p.result.error)) {
        if (fresh++ < 1) {
          // a stuck revision chain: start over from a fresh draft once before giving up
          log.log('auditor', `[${key}] spec still broken after 3 rounds; asking for a fresh draft`);
          spec = await writeSpec(task, { guidance });
          round = -1;
          continue;
        }
        throw new Error('spec writer could not produce a working check()');
      }
      log.log('auditor', `[${key}] accepting spec with open issues after 3 rounds`);
      break;
    }
    spec = await writeSpec(task, { guidance, previous: spec.code, feedback: issues.map((s) => `- ${s}`).join('\n') });
  }
  return { ...spec, audits };
}

const progressOf = (check) => (check.results.length ? check.results.filter((r) => r.pass).length / check.results.length : 0);
const sameSig = (a, b) => a.crash === b.crash && a.fails === b.fails && a.end === b.end && a.maxY === b.maxY;

// Watchdog: deterministic supervisor over the attempt history
export function watchdog(history, maxAttempts, loops) {
  const cur = history[history.length - 1];
  const k = history.length - 1;
  const total = cur.check.results.length;
  const ok = cur.check.results.filter((r) => r.pass).length;
  if (cur.check.error) return { action: 'escalate', reason: `definition of done broke on this flight: ${cur.check.error}` };
  if (cur.check.pass) return { action: 'done', reason: `all ${total} checks pass` };
  const earlier = history.findIndex((h) => h.check.pass);
  if (earlier >= 0) return { action: 'done', reason: `after the spec fix, attempt ${earlier + 1} passes all ${history[earlier].check.results.length} checks` };
  let best = 0;
  history.forEach((h, i) => { if (progressOf(h.check) >= progressOf(history[best].check)) best = i; });
  const failing = cur.check.results.filter((r) => !r.pass).map((r) => r.name).join('; ');
  if (k + 1 >= maxAttempts) {
    return { action: 'stop', reason: `attempt budget used (${maxAttempts}); best was attempt ${best + 1} with ${Math.round(progressOf(history[best].check) * total)}/${total} checks`, ping: loops >= 2 };
  }
  if (cur.trace.controllerError) {
    return { action: 'continue', reason: `pilot program threw at t=${cur.trace.controllerError.t}s`, message: `Your program threw "${cur.trace.controllerError.message}" at t=${cur.trace.controllerError.t}s, so the car got no input after that. Fix the bug first.` };
  }
  const same = history.slice(0, -1).findIndex((h) => sameSig(h.sig, cur.sig));
  if (same >= 0) {
    return {
      action: 'replan', loop: true,
      reason: `loop: same failure as attempt ${same + 1} (${cur.sig.crash || failing})`,
      message: `LOOP DETECTED: this attempt failed exactly like attempt ${same + 1} (${cur.trace.crashed ? `crash: ${cur.trace.crashReason}; ` : ''}failing: ${failing}). Tweaking numbers is not working. Re-plan: re-read the flight report, question your assumptions about the controls (signs, units, what each command really does), and use a different strategy for the phase that fails.`,
    };
  }
  const prev = history[k - 1];
  const failsOf = (h) => h.check.results.filter((r) => !r.pass).map((r) => r.name).sort().join('|');
  if (prev && failsOf(prev) === failsOf(cur) && progressOf(cur.check) <= progressOf(prev.check) + 1e-9) {
    return {
      action: 'replan', stall: true,
      reason: `stalled: the same ${total - ok} check(s) failed twice in a row (${failing})`,
      message: `STALLED: the same checks failed in your last two attempts (${failing}). Your changes are not reaching the cause. In the flight report timeline, compare the commands you sent (cmd column) with what the car actually did (altitude, speed, heading, armed), find where they disagree with your mental model of the controls, and change the approach for that phase.`,
    };
  }
  if (progressOf(cur.check) + 1e-9 < progressOf(history[best].check)) {
    return {
      action: 'revert', baseIndex: best,
      reason: `drift: regressed from ${Math.round(progressOf(history[best].check) * total)}/${total} (attempt ${best + 1}) to ${ok}/${total}`,
      message: `DRIFT: attempt ${best + 1} passed more checks (${Math.round(progressOf(history[best].check) * total)}/${total}) than your last attempt (${ok}/${total}). Start again from attempt ${best + 1}'s code (shown) and change only what its failing checks need.`,
    };
  }
  return { action: 'continue', reason: `${ok}/${total} checks pass; failing: ${failing}`, message: null };
}

/**
 * Runs one task end to end. The hidden referee grade is recorded for scoring but never shown to agents.
 */
export async function runEpisode({ task, playbook, maxAttempts = 3, log, key, specCache }) {
  log.live(key, { task: task.id, goal: task.goal, version: playbook.version, stage: 'spec: writing', attempt: 0 });
  const cacheKey = `${task.id}::${playbook.specGuidance || ''}`;
  let spec = specCache?.get(cacheKey);
  if (!spec) {
    spec = await makeSpec(task, playbook, { log, key });
    specCache?.set(cacheKey, spec);
  } else log.log('spec', `[${key}] reusing audited spec (${spec.criteria.length} criteria)`);

  const history = [];
  const decisions = [];
  let directive = null, loops = 0, respecs = 0, disputes = 0;
  for (let k = 0; k < maxAttempts; k++) {
    log.live(key, { stage: `pilot: writing attempt ${k + 1}`, attempt: k + 1 });
    const p = await pilot(task, spec, playbook, history, directive);
    let trace, replay, logs = [];
    if (!p.code) {
      ({ trace, replay } = runFlight({ task, control: idle, maxT: 2 }));
      trace.controllerError = { t: 0, message: 'no ```js code block in the answer' };
    } else {
      try {
        const c = compileController(p.code, playbook.skills);
        logs = c.logs;
        ({ trace, replay } = runFlight({ task, control: c.control }));
      } catch (err) {
        ({ trace, replay } = runFlight({ task, control: idle, maxT: 2 }));
        const where = syntaxError(normalizeCode(`${playbook.skills || ''}
;
${p.code}`), 'pilot.js');
        trace.controllerError = { t: 0, message: `compile error: ${(where || String(err?.message || err)).slice(0, 400)}` };
      }
    }
    let check = runCheck(spec.code, trace);
    if (check.error && respecs < 1) {
      // self-heal: the definition of done itself broke; rewrite it once with the error, then re-check
      respecs++;
      log.log('watchdog', `[${key}] spec check errored (${check.error}); asking the spec writer to repair it`);
      const fixed = await writeSpec(task, { guidance: playbook.specGuidance, previous: spec.code, feedback: `On a real flight your check threw: ${check.error}. Make it robust.` });
      if (fixed.code) {
        spec = { ...fixed, audits: spec.audits };
        specCache?.set(cacheKey, spec);
        check = runCheck(spec.code, trace);
      }
    }
    const referee = task.grade ? task.grade(trace) : { pass: null, progress: null };
    const att = { n: k + 1, plan: p.plan, code: p.code || '', trace, check, referee, digest: digest(trace), logs };
    if (check.error) att.check = { ...check, results: check.results || [] };
    history.push(att);

    // the pilot may dispute the definition of done; the independent auditor rules on it
    if (p.specIssue && disputes < 2) {
      disputes++;
      log.live(key, { stage: `auditor: reviewing pilot's dispute` });
      const rv = await reviewDispute(task, spec, p.specIssue, att);
      att.dispute = { issue: p.specIssue, verdict: rv.verdict, issues: rv.issues };
      log.log('auditor', `[${key}] pilot disputes the spec: "${p.specIssue.slice(0, 160)}" -> ${rv.verdict === 'fix' ? 'UPHELD, spec will be fixed' : 'REJECTED, spec stands'}${rv.issues.length ? `: ${rv.issues.join(' | ').slice(0, 300)}` : ''}`);
      if (rv.verdict === 'fix') {
        const fixed = await writeSpec(task, { guidance: playbook.specGuidance, previous: spec.code, feedback: (rv.issues.length ? rv.issues : [p.specIssue]).map((s) => `- ${s}`).join('\n') });
        const recheck = fixed.code ? history.map((h) => runCheck(fixed.code, h.trace)) : [];
        if (fixed.code && !recheck.some((c) => c.error)) {
          spec = { ...fixed, audits: [...(spec.audits || []), { round: 'dispute', verdict: 'revise', issues: rv.issues.length ? rv.issues : [p.specIssue] }] };
          specCache?.set(cacheKey, spec);
          history.forEach((h, i) => { h.check = recheck[i]; h.sig = signature(h.trace, h.check); });
          log.log('spec', `[${key}] spec rewritten after the dispute; re-checked all ${history.length} flights: ${recheck.map((c) => (c.pass ? 'PASS' : `${c.results.filter((r) => r.pass).length}/${c.results.length}`)).join(', ')}`);
        } else log.log('spec', `[${key}] spec rewrite after the dispute did not produce a working check; keeping the old one`);
      }
    }
    check = att.check;
    att.sig = signature(trace, check);
    replay.meta = { task: task.id, goal: task.goal, version: playbook.version, attempt: k + 1, selfCheck: !!check.pass, referee: { pass: referee.pass, progress: referee.progress }, crash: trace.crashReason };
    const rep = log.saveReplay(`${key}-a${k + 1}`, replay);
    att.replay = rep;
    const d = watchdog(history, maxAttempts, loops);
    if (d.loop) loops++;
    att.decision = d;
    decisions.push(d);
    log.feed({ key: `${key}-a${k + 1}`, task: task.id, goal: task.goal, version: playbook.version, attempt: k + 1, replay: rep, selfCheck: !!check.pass, checks: `${check.results.filter((r) => r.pass).length}/${check.results.length}`, referee: { pass: referee.pass, progress: referee.progress }, crash: trace.crashReason, decision: { action: d.action, reason: d.reason } });
    const refTxt = referee.pass == null ? 'no referee (custom goal)' : `referee ${referee.pass ? 'PASS' : 'fail'} ${referee.progress.toFixed(2)}`;
    log.log('verifier', `[${key}] attempt ${k + 1}: self-check ${check.pass ? 'PASS' : 'fail'} (${check.results.filter((r) => r.pass).length}/${check.results.length})${trace.crashed ? ` crash=${trace.crashReason}` : ''} · ${refTxt}`);
    log.log('watchdog', `[${key}] -> ${d.action.toUpperCase()}: ${d.reason}`);
    log.live(key, { stage: `attempt ${k + 1}: ${d.action}`, lastCheck: `${check.results.filter((r) => r.pass).length}/${check.results.length}` });
    if (d.action === 'done' || d.action === 'stop') {
      if (d.ping) log.ping(task.id, `stuck in a loop and out of attempts: ${d.reason}`);
      break;
    }
    if (d.action === 'escalate') {
      log.ping(task.id, d.reason);
      break;
    }
    directive = d;
  }
  // the attempt the team stands behind: a self-check pass, else the best progress
  let best = history.findIndex((h) => h.check.pass);
  if (best < 0) {
    best = 0;
    history.forEach((h, i) => { if (progressOf(h.check) >= progressOf(history[best].check)) best = i; });
  }
  const claimedDone = history[best].check.pass === true;
  const referee = history[best].referee;
  log.live(key, null);
  return { key, task, version: playbook.version, spec, attempts: history, decisions, best, claimedDone, referee };
}

// strip heavy fields for state.json
export function summarize(ep) {
  return {
    key: ep.key, task: ep.task.id, goal: ep.task.goal, split: ep.task.split, version: ep.version,
    claimedDone: ep.claimedDone, referee: ep.referee, falseDone: ep.referee.pass === false && ep.claimedDone, best: ep.best,
    spec: { criteria: ep.spec.criteria, code: ep.spec.code, audits: ep.spec.audits },
    attempts: ep.attempts.map((a) => ({
      n: a.n, plan: a.plan, code: a.code, replay: a.replay,
      check: { pass: !!a.check.pass, error: a.check.error || null, results: a.check.results },
      referee: a.referee, crash: a.trace.crashReason, controllerError: a.trace.controllerError,
      decision: a.decision, dispute: a.dispute || null,
      final: a.trace.final, maxY: a.trace.maxY,
    })),
  };
}
