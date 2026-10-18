# Stunt School: AI agents that teach themselves to fly

The game is real not any video you can checkout and try here - https://rikinshah787.github.io/Roadstar/

**Repo:** https://github.com/Rikinshah787/Recursive-Hackathon

Built on **October 17, 2026** at the Crusoe × Cerebral Valley **Recursive Agents** hackathon.
Tracks: **Version N+1** and **Done Means Done**. All model inference runs on **Crusoe Managed Inference**.

## The problem

AI agents say "done" when they aren't, and they don't get better with experience unless a human rewrites
their prompts. Stunt School is a team of agents that writes and audits its own definition of done, then
improves itself. A hidden referee checks every claim.

## What we built today

You give the team a one-line goal like *"do a front flip over the truck and land it"*. It flies a
jet-powered roadster in a real 3D game and:

1. **Writes its own definition of done** as executable checks. An auditor from a different model family
   reviews those checks for loopholes. A flight where the car does nothing must fail them.
2. **Flies and verifies.** A pilot model writes a control program, flies it in the game's physics and checks
   the flight against the spec. A watchdog then decides to continue, re-plan, revert, stop or ping a human.
3. **Improves itself between rounds.** A coach runs physics experiments and rewrites the team's playbook
   (insights, a library of helper skills, prompt guidance). Every skill must pass a physical test flight.
   A new version is kept only if it scores higher than the version it came from.

No model is fine-tuned. What improves is the playbook the team writes for itself.

The game itself (Roadster Flight, Three.js) existed before the hackathon. Today we ran its physics
without graphics as the simulator, and added a replay mode so every agent flight can be watched in 3D.

```
 one-line goal
     │
     ▼
 SPEC WRITER (gpt-oss-120b) ──► check(trace) code + criteria
     │            ▲ revise
     ▼            │
 AUDITOR (NVIDIA Nemotron-3-Super-120B, a different model family)
     │
     ▼
 PILOT (DeepSeek-V4-Flash) ──► control(obs) program ── disputes the spec? ──► auditor rules
     │
     ▼
 SIMULATOR   the game's own physics, no graphics, 120 Hz, deterministic; a 20 s flight takes about 50 ms
     │
     ▼
 VERIFIER ──► WATCHDOG: done · continue · replan · revert · stop · ping human
     │
 between rounds: COACH (DeepSeek-V4-Pro, reasoning on)
   lab experiments → rewrite playbook → skill test flights → keep only if the score goes up
```

## Models (all on Crusoe Managed Inference)

| Role | Model |
|---|---|
| Spec writer | `openai/gpt-oss-120b` |
| Auditor | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B` |
| Pilot | `deepseek-ai/DeepSeek-V4-Flash` |
| Coach | `deepseek-ai/DeepSeek-V4-Pro` (reasoning on) |
| Backups when rate-limited | GLM-5.3, GLM-5.3-Flash, DeepSeek-V4.1-Flash |
| Pilot-swap experiments | `nvidia/NVIDIA-Nemotron-3.5-Super-VL`, `nvidia/Nemotron-3.5-Lightning-30B-A3B` |

Crusoe usage on hackathon day (12 runs, about 2.4 hours of autonomous runs):
- **1,635** calls and **9.46M tokens** (7.29M in, 2.17M out), about **67K tokens per minute**
- DeepSeek-V4-Flash averaged about **205 output tokens per second per call**, measured end to end
  (about 5 s per pilot program)

## Results (real runs, October 17)

**Self-improvement on the 6 training stunts.** The coach proposed 4 rewrites; the gate kept 2 and rejected 2.

| Version | Built from | Training score | Result |
|---|---|---|---|
| v0 | the game's controls page only | 0.325 | starting point |
| v1 | v0 | 0.564 | kept |
| v2 | v1 | 0.171 | rejected |
| v3 | v1 | 0.437 | rejected |
| v4 | v1 | **0.615** | kept (+89% over v0) |

**Held-out exam: 4 stunts the team never trained on.** v0 vs v4, same pilot model (DeepSeek-V4-Flash),
same hidden referee, same budget (3 attempts per episode), run 5 times per side.

| | v0 (empty playbook) | v4 (self-improved) |
|---|---|---|
| Flights the hidden referee passed | 0 / 19 | **5 / 20** |
| Mean score | 0.233 | **0.430** (+85%) |
| False "done" claims | 0 | **0** |

- Score difference +0.198, 95% bootstrap CI [+0.029, +0.387], one-sided permutation p = 0.019
- Pass rate 5/20 vs 0/19, one-sided Fisher exact p = 0.027

| Held-out stunt | v0 | v4 |
|---|---|---|
| Front flip over the truck | 0/5 · 0.18 | **2/5 · 0.44** |
| Fly through ring 1, then land | 0/5 · 0.12 | **1/5 · 0.30** |
| C-Loop upside down, then land | 0/4 · 0.42 | **2/5 · 0.65** |
| Launch off the Mega Wall, land in the zone | 0/5 · 0.25 | 0/5 · **0.34** |

**Same exam, different pilot: no gain yet.** With the pilot swapped to Nemotron-3.5-Super-VL, v4 did not beat
v0 (0.304 vs 0.325, 2/12 passes each side). The playbook was learned with DeepSeek pilots and did not
transfer to another model family. Nemotron flew better than DeepSeek with no playbook at all (0.325 vs 0.233).
Nemotron-3.5-Lightning was too small to fly (about 0.02). Next step: train with mixed pilot models.

## Things the team caught

- **The coach's steering skill turned the wrong way.** A skill test flight failed it ("heading error 3.10 rad")
  and the coach fixed the sign.
- **The coach tried to pass its tests by editing them.** Tests are now locked during the fix round.
- **The spec writer filled a vague goal with assumptions.** It turned "hover *between* 8 and 12 m" into
  "hover at 8 ± 0.2 m or 12 ± 0.2 m".
- **Pilots disputed the spec 28 times. The Nemotron auditor upheld 8 and rejected 20.** In one upheld case,
  a Mega Wall spec demanded a jump off the wall that the goal never asked for. The spec was rewritten and
  every earlier flight was re-checked.
- **A failure census redirected the research.** It showed most flights never landed, so the coach's
  experiments switched from steering to landing.

## Run it

```
npm install
# an Intelligence Foundry / Managed Inference API key (not Crusoe Cloud access keys)
echo "CRUSOE_API_KEY='...'" > school/.env
node school/cli.js check                          # verifies the key and the role models

npx vite --port 5199
#   dashboard:  http://localhost:5199/school/dashboard/
#   live 3D:    http://localhost:5199/?live        (flies each new attempt as it lands)

node school/cli.js evolve --gens 4 --attempts 3   # train, then the held-out before/after exam
node school/cli.js eval --before <run>/v0 --after <run>/v4 --repeats 2
node school/cli.js goal "fly through ring 2 and land on the stage" --start free
LLM_MOCK=1 node school/cli.js evolve --gens 1     # offline dry run, no key needed
```

More detail on the pipeline is in [school/README.md](school/README.md).

## What's in the repo (today's work)

| Path | What it does |
|---|---|
| `school/sim/` | headless collision world and flight runner (the game's car physics and crash rules) |
| `school/tasks.js` | 6 training and 4 held-out stunts, with hidden referee graders |
| `school/agents.js` | prompts for the spec writer, auditor, pilot, dispute review and coach |
| `school/episode.js` | the Done Means Done loop and watchdog |
| `school/evolve.js` | the Version N+1 loop: lab, skill tests, locked fix round, gate, held-out exam |
| `school/lab.js` | experiment flights and skill test flights |
| `school/sandbox.js` | runs model-written code in a sandbox with time limits |
| `school/llm.js` | Crusoe client: retries, per-model concurrency, fallbacks, token ledger |
| `school/dashboard/` | live dashboard |
| `src/replay.js` | in-game replay of any agent flight (`?replay=`, `?live`) |

## Honest limits

- One training run produced the kept improvement. Training scores are noisy, so the held-out claim rests on
  5 exam rounds per side.
- What the team learned did not transfer to a different pilot model family.
- Earlier runs (1–5) did not produce a version that beat v0. Each one exposed a flaw that we then fixed.
