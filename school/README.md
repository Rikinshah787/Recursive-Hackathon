# Stunt School: agents that teach themselves to fly

A team of LLM agents on **Crusoe Managed Inference** learns to fly a jet-powered roadster through stunts in a
real 3D game (Roadster Flight, Three.js). You give it a one-line goal like *"do a front flip over the truck and
land it"*. The team does three things on its own:

1. It writes its own **definition of done**: executable checks that an independent auditor model reviews for
   loopholes.
2. It flies attempts in a deterministic physics simulator and verifies each one. A watchdog catches loops,
   stalls and drift, then decides whether to continue, re-plan, revert, stop or (rarely) ping a human.
3. Between training rounds it **improves itself**:
   - it runs physics **experiments** to measure how the car really behaves;
   - it rewrites its playbook: insights, a library of helper skills, and its own prompt guidance;
   - every skill must pass a **test flight** judged on the physical outcome;
   - a rewrite is kept only if the team scores better.

   The gain is measured on **held-out stunts the team never trained on**.

Every flight, including the lab experiments, can be replayed in the actual game in the browser.

Tracks: **Version N+1** (self-improvement with a held-out before/after) and **Done Means Done** (self-written,
audited, executable definition of done plus a watchdog).

## How it works

```
 one-line goal
     │
     ▼
 SPEC WRITER (gpt-oss-120b) ──► check(trace) JS + criteria
     │            ▲ revise (≤2) / fresh draft
     ▼            │
 PROBES ──────── AUDITOR (Nemotron-3-Super: a different model family)
 do-nothing flight must FAIL · syntax errors located · field/type/surface lint
     │
     ▼
 PILOT (DeepSeek-V4-Flash) ──► control(obs, mem) JS program   ── "SPEC ISSUE:" ──► AUDITOR rules on the dispute
     │                                                            (upheld → spec rewritten, all flights re-checked)
     ▼
 SIMULATOR  the game's own physics (src/physics.js), headless, 120 Hz, deterministic; a 20 s flight ≈ 50 ms
     │
     ▼
 VERIFIER   runs the spec on the trace, writes a flight report
     │
     ▼
 WATCHDOG   done · continue · replan (loop / stall) · revert (drift) · stop · escalate → ping human
     │
     └─► next attempt

 between training rounds: COACH (DeepSeek-V4-Pro, reasoning on)
   1. reads the round + a FAILURE CENSUS (how all flights ended) + the LAB NOTEBOOK
   2. designs ≤4 LAB EXPERIMENTS → measured in the simulator (also replayable in 3D)
   3. rewrites the playbook: insights · skills · skill tests · pilot guidance · spec guidance
   4. SKILL TESTS: every skill must pass a physical test flight; parent tests ride along as regression tests
   5. one fix round with the tests LOCKED (editing a test to match a buggy skill is ignored)
   6. skills kept one by one: only verified functions (+ their helpers) survive; they enter the SKILL BANK
   7. GATE: the candidate re-flies the 6 training stunts; kept only if its score beats the parent's
      (the starting playbook is measured twice and averaged)
 FINAL: v0 vs the best version on 4 HELD-OUT stunts (repeat to beat the noise)
```

**Honest scoring.** Every task has a hidden referee grader that no agent ever sees. The referee measures:

- task success, on the training gate and the held-out eval
- **false-done**: the team said "done" but the referee says fail
- **missed-done**: the team gave up on a flight that actually succeeded

**v0 starts with what a human player gets:** the game's controls page. Everything else is learned from flight
reports and experiments.

## Things the team caught (real runs)

These are from real runs on Crusoe:

- **The coach's steering skill turned the wrong way** (`+diff` instead of `−diff`). Before skill tests existed,
  every pilot that trusted it drove into the truck. Now a test flight fails it, which looks like "heading error
  3.10 rad". In the fix round the coach corrected the sign: `steer = −diff × gain`.
- **The coach tried to pass its tests by editing them.** One fix-round changelog reads: "test target changed to
  −PI/2 to match steer +1 behaviour". Tests are now locked during the fix round, and the log records it:
  "the coach edited 1 test in the fix round; the original tests are used".
- **The spec writer filled a vague goal with assumptions.** It turned "hover *between* 8 and 12 m" into "hover at
  8 ± 0.2 m or 12 ± 0.2 m". The team then rejected a flight the referee scored as a pass (missed-done).
- **Pilots pushed back on the definition of done 28 times; the independent auditor upheld 8 and rejected 20.**
  It does not relax checks just because a stunt is hard. One upheld case: a Mega Wall spec demanded a jump
  *off* the wall, but the goal only said drive up and come back down. The spec was rewritten and every earlier
  flight was re-checked against it.
- **The failure census redirected the research.** It showed that most flights *never landed* (the car hovered on
  its jets at the end). The coach's next experiments switched from steering to landing.

## Run it

```
# 1. key: an Intelligence Foundry / Managed Inference API key (single quotes if it contains $)
echo "CRUSOE_API_KEY='...'" > school/.env
node school/cli.js check                         # verifies the key and the four role models

# 2. dashboard + 3D replays (Vite dev server rooted at this folder)
npx vite --port 5199
#   dashboard:   http://localhost:5199/school/dashboard/
#   live 3D:     http://localhost:5199/?live      (flies every new attempt / experiment as it lands)

# 3. walk away: train N generations, then the held-out before/after eval
node school/cli.js evolve --gens 4 --attempts 3

# repeat the held-out exam to beat the noise
node school/cli.js eval --before <run>/v0 --after <run>/v3 --repeats 3

# a single Done-Means-Done episode, optionally with a trained playbook
node school/cli.js episode flip-truck --pb latest/v2

# any one-line stunt (no referee: the team's own audited checks are the judge)
node school/cli.js goal "fly through ring 2 and land on the stage" --start free

node school/cli.js tasks                         # the 6 training + 4 held-out stunts
LLM_MOCK=1 node school/cli.js evolve --gens 1    # offline dry run of the whole pipeline
```

Role → model mapping is in `school/llm.js` (override with `MODEL_PILOT=...` etc.):

- **Retries:** calls retry 429/5xx with backoff and jitter.
- **Fallbacks:** after repeated 429s a call moves to the role's backup model (rate limits are per model).
- **Ledger:** tokens are logged per role to the dashboard.
- **Failed episodes:** an episode that fails because the API failed is retried before it is scored.

## Files

| | |
|---|---|
| `sim/world.js`, `sim/runner.js` | headless collision world + flight runner (the game's `Vehicle` physics, the game's crash rules) |
| `tasks.js` | arena map, 6 training + 4 held-out stunts, hidden referee graders, free-text goal presets |
| `agents.js` | spec writer, auditor, pilot, dispute review, coach (lab design, rewrite, fix) prompts |
| `episode.js` | Done-Means-Done loop + watchdog |
| `evolve.js` | Version N+1 loop: lab, skill tests, locked fix round, per-skill acceptance, notebook, skill bank, gate, held-out eval |
| `lab.js` | experiment flights, skill test flights, per-function skill verification |
| `sandbox.js` | runs model-written code in `vm` contexts with per-tick and per-flight time limits; code normalisation and located syntax errors |
| `llm.js` | Crusoe client (retries, per-model concurrency, fallbacks, JSON mode, ledger) |
| `runlog.js` | `runs/<id>/state.json` (live dashboard state), `events.jsonl`, playbooks, replays |
| `dashboard/` | live dashboard |
| `../src/replay.js` | in-game replay driver (`?replay=`, `?live`) |
