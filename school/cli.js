#!/usr/bin/env node
// Stunt School CLI
//   node school/cli.js check                      verify the Crusoe key + role models
//   node school/cli.js episode <task> [--pb ref]  one Done-Means-Done episode
//   node school/cli.js evolve [--gens 3]          Version N+1 training, then the held-out before/after eval
//   node school/cli.js eval --before ref --after ref   held-out comparison only
//   node school/cli.js goal "<stunt>" [--start free|stage|truck|wall|loop]   any one-line goal, live
//   node school/cli.js tasks                      list tasks
// common flags: --attempts N (per episode), --repeats N (eval), LLM_MOCK=1 for an offline dry run
import { MODELS, chat, listModels, hasKey } from './llm.js';
import { RunLog, loadPlaybook } from './runlog.js';
import { runEpisode, summarize } from './episode.js';
import { evolve, heldOut, seedPlaybook } from './evolve.js';
import { TASKS, getTask, customTask, STARTS } from './tasks.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};

async function main() {
  if (cmd === 'tasks') {
    for (const t of TASKS) console.log(`${t.split.padEnd(5)} ${t.id.padEnd(12)} ${t.goal}`);
    return;
  }
  if (cmd === 'check') {
    if (process.env.LLM_MOCK === '1') return console.log('mock mode: no API calls');
    if (!hasKey()) throw new Error('CRUSOE_API_KEY not set. Create school/.env with CRUSOE_API_KEY=... (single quotes if it contains $)');
    const models = await listModels();
    const ids = new Set(models.map((m) => m.id));
    console.log(`${models.length} models available`);
    for (const [role, id] of Object.entries(MODELS)) {
      const hit = ids.has(id);
      process.stdout.write(`${role.padEnd(8)} ${id.padEnd(45)} ${hit ? 'listed' : 'NOT LISTED'}  `);
      try {
        const r = await chat({ role, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 400, temperature: 0 });
        console.log(`-> "${r.text.trim().slice(0, 40)}" (${r.ms} ms)`);
      } catch (err) {
        console.log(`-> ERROR ${err.message.slice(0, 200)}`);
      }
    }
    if (argv.includes('--list')) for (const m of models) console.log(`  ${m.id}\t${m.context_length}\t${(m.supported_parameters || []).join(',')}`);
    return;
  }
  if (cmd === 'episode') {
    const task = getTask(argv[1]);
    if (!task) throw new Error(`unknown task ${argv[1]} (see: node school/cli.js tasks)`);
    const pb = flag('pb') ? loadPlaybook(flag('pb')) : seedPlaybook();
    const attempts = Number(flag('attempts', 4));
    const log = new RunLog('episode', { task: task.id, playbook: pb.version, attempts });
    log.state.playbooks.push({ ...pb, accepted: true });
    const ep = await runEpisode({ task, playbook: pb, maxAttempts: attempts, log, key: task.id, specCache: new Map() });
    log.state.rounds.push({ label: `episode v${pb.version}`, version: pb.version, split: task.split, score: ep.referee.pass ? 1 : 0.6 * ep.referee.progress, passRate: ep.referee.pass ? 1 : 0, episodes: [summarize(ep)] });
    log.log('done', `${task.id}: team says ${ep.claimedDone ? 'DONE' : 'NOT DONE'} · referee ${ep.referee.pass ? 'PASS' : 'FAIL'} · ${ep.attempts.length} attempts`);
    log.finish();
    return;
  }
  if (cmd === 'goal') {
    // free-text goal, no hidden referee: the team's own audited definition of done is the only judge
    const goal = argv[1];
    if (!goal) throw new Error(`usage: node school/cli.js goal "<one-line stunt>" [--start ${Object.keys(STARTS).join('|')}] [--pb ref]`);
    const task = customTask(goal, flag('start', 'free'), { fuel: Number(flag('fuel', 1)), maxT: Number(flag('time', 30)) });
    const pb = flag('pb') ? loadPlaybook(flag('pb')) : seedPlaybook();
    const attempts = Number(flag('attempts', 4));
    const log = new RunLog('goal', { goal, start: flag('start', 'free'), playbook: pb.version, attempts });
    log.state.playbooks.push({ ...pb, accepted: true });
    const ep = await runEpisode({ task, playbook: pb, maxAttempts: attempts, log, key: 'custom', specCache: new Map() });
    log.state.rounds.push({ label: `goal v${pb.version}`, version: pb.version, split: 'custom', score: null, passRate: null, episodes: [summarize(ep)] });
    log.log('done', `"${goal}": team says ${ep.claimedDone ? 'DONE' : 'NOT DONE'} after ${ep.attempts.length} attempts · watch: http://127.0.0.1:5199/?replay=${ep.attempts[ep.best].replay}`);
    log.finish();
    return;
  }
  if (cmd === 'evolve') {
    const gens = Number(flag('gens', 3));
    const attempts = Number(flag('attempts', 3));
    const repeats = Number(flag('repeats', 1));
    const log = new RunLog('evolve', { gens, attempts, repeats });
    const start = flag('pb') ? loadPlaybook(flag('pb')) : seedPlaybook();
    const best = await evolve({ gens, attempts, log, start, baselineRepeats: Number(flag('baseline-repeats', 2)) });
    if (!argv.includes('--no-eval')) await heldOut({ before: start, after: best, attempts, log, repeats });
    log.finish();
    return;
  }
  if (cmd === 'eval') {
    const before = loadPlaybook(flag('before'));
    const after = loadPlaybook(flag('after'));
    const attempts = Number(flag('attempts', 3));
    const log = new RunLog('eval', { attempts, before: before.version, after: after.version });
    log.state.playbooks.push({ ...before, accepted: true }, { ...after, accepted: true });
    await heldOut({ before, after, attempts, log, repeats: Number(flag('repeats', 1)) });
    log.finish();
    return;
  }
  console.log('usage: node school/cli.js check | tasks | episode <task> [--pb ref] | evolve [--gens N] | eval --before ref --after ref');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
