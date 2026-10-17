// Stunt tasks. Each has a one-line goal (all the agents get), a start pose, and a HIDDEN grader
// (ground truth, never shown to the agents) used to score the team honestly.
import { LAYOUT, STUNTS } from './sim/world.js';

const PAD = LAYOUT.pad, STAGE = LAYOUT.stage;
const dist2 = (a, x, z) => Math.hypot(a.x - x, a.z - z);
const settled = (f) => f.wheels >= 3 && !f.airborne && f.upY > 0.8 && f.speed < 2.5;

// shared map every agent can read (public facts about the arena, not about how to fly)
export const ARENA_MAP = `ARENA MAP (metres; y is up; heading 0 faces +z, heading +PI/2 faces +x)
- Floor is flat at y=0 inside x -116..116, z -70..80 (soft walls push you back at the edges).
- Stage: round platform centre (0, -52), radius 13, 0.5 m high with a gentle ramp edge (part of the 'ground' surface). A big backdrop wall stands behind it at z=-69.
- Landing pad: centre (0, 34), radius 7, painted flat on the floor (part of the 'ground' surface).
- Flight rings (radius 5.5, you must pass through the hole):
  ring 0 centre (0, 12, 60), facing along z (fly through it travelling +z or -z)
  ring 1 centre (48, 18, 42), facing along (1, 0, -0.45) normalised
  ring 2 centre (-38, 15, 26), facing along (-1, 0, -0.15) normalised
- Kicker ramp: starts at (-20, 0, 50) and rises along -x for ~5.7 m (lip ~1.2 m high at x=-25.7), 6 m wide (z 47..53).
- Truck: a car-carrier trailer lying along z at x=-52 (box x -53.35..-50.65, z 43.6..58.4, 4.5 m tall), cab x -53.3..-50.7, z 37..41.7, 4 m tall. Hitting it at speed is a crash.
- Truck landing zone: centre (-78, 50), radius 16.
- Mega Wall: a quarter-pipe that starts at (86, 0, -20) and curves up along +x into a vertical wall, top at y~29, 9 m wide (z -24.5..-15.5). Wall landing zone (smoke zone): centre (70, -20), radius 10.
- C-Loop: a half-loop that starts at (-80, 0, -42) and curves up along -z, over the top (inverted at y~20) and back out over its own entry; 8 m wide (x -84..-76).
- Donut finale area: centre (65, -44), radius 12; display cars parked at z~-63.5.`;

export const TASKS = [
  // ---------------------------------------------------------------- training set
  {
    id: 'truck-jump', split: 'train',
    goal: 'Jump over the truck and land on your wheels on the far side.',
    start: STUNTS.truck.start, fuel: 1, maxT: 12,
    grade(tr) {
      const f = tr.flights.find((x) => x.overTruck);
      const reachedKicker = tr.samples.some((s) => s.surface === 'kicker') || tr.flights.some((x) => x.from === 'kicker');
      const clean = f && f.minTruckClearance > 0 && !f.crashedOnLanding && f.end.x < -55;
      const pass = !!clean && !tr.crashed && settled(tr.final) && tr.final.x < -55;
      const progress = pass ? 1 : clean ? 0.85 : f ? 0.6 : reachedKicker ? 0.35 : Math.min(0.3, Math.max(0, (4 - tr.final.x) / 80));
      return { pass, progress };
    },
  },
  {
    id: 'pad-landing', split: 'train',
    goal: 'Take off from the stage, fly to the landing pad and land on it.',
    start: LAYOUT.spawnStage, fuel: 1, maxT: 25,
    grade(tr) {
      const d = dist2(tr.final, PAD.x, PAD.z);
      const pass = !tr.crashed && settled(tr.final) && d < PAD.r;
      const closest = Math.min(...tr.samples.map((s) => dist2(s, PAD.x, PAD.z)), d);
      const progress = pass ? 1 : Math.max(0, 0.8 * (1 - closest / 86)) * (tr.crashed ? 0.6 : 1);
      return { pass, progress };
    },
  },
  {
    id: 'hover-10', split: 'train',
    goal: 'Hover between 8 and 12 metres of altitude for at least 5 seconds in a row, then land gently.',
    start: LAYOUT.spawnFree, fuel: 1, maxT: 25,
    grade(tr) {
      let best = 0, run = 0, prevT = 0;
      for (const s of tr.samples) {
        if (s.alt >= 8 && s.alt <= 12) run += s.t - prevT; else run = 0;
        best = Math.max(best, run);
        prevT = s.t;
      }
      const pass = best >= 5 && !tr.crashed && settled(tr.final);
      const progress = pass ? 1 : Math.min(0.8, (best / 5) * 0.7 + Math.min(tr.maxAlt, 8) / 80) * (tr.crashed ? 0.6 : 1);
      return { pass, progress };
    },
  },
  {
    id: 'ring-0', split: 'train',
    goal: 'Fly through ring 0 (the ring at x=0, y=12, z=60), then land safely.',
    start: LAYOUT.spawnFree, fuel: 1, maxT: 25,
    grade(tr) {
      const hit = tr.rings.some((r) => r.ring === 0);
      const pass = hit && !tr.crashed && settled(tr.final);
      const near = Math.min(...tr.samples.map((s) => Math.hypot(s.x - 0, s.y - 12, s.z - 60)));
      const progress = pass ? 1 : hit ? 0.75 : Math.max(0, 0.6 * (1 - near / 85));
      return { pass, progress };
    },
  },
  {
    id: 'wall-ride', split: 'train',
    goal: 'Drive up the Mega Wall higher than 20 metres and get back down to the floor without crashing.',
    start: STUNTS.wall.start, fuel: 0.7, maxT: 20,
    grade(tr) {
      const top = Math.max(0, ...tr.samples.filter((s) => s.surface === 'megawall').map((s) => s.y));
      const pass = top > 20 && !tr.crashed && settled(tr.final);
      const progress = pass ? 1 : Math.min(0.8, top / 25) * (tr.crashed ? 0.6 : 1);
      return { pass, progress };
    },
  },
  {
    id: 'park-stage', split: 'train',
    goal: 'Drive onto the stage and park within 3 metres of its centre (0, -52), fully stopped.',
    start: LAYOUT.spawnFree, fuel: 1, maxT: 25,
    grade(tr) {
      const d = dist2(tr.final, STAGE.x, STAGE.z);
      const pass = !tr.crashed && d < 3 && tr.final.speed < 0.6 && tr.final.wheels >= 3 && tr.final.upY > 0.9;
      const progress = pass ? 1 : Math.max(0, 0.8 * (1 - d / 40)) * (tr.crashed ? 0.6 : 1);
      return { pass, progress };
    },
  },

  // ---------------------------------------------------------------- held-out set (never trained on)
  {
    id: 'flip-truck', split: 'test',
    goal: 'Do a front flip while jumping over the truck and land it on your wheels.',
    start: STUNTS.truck.start, fuel: 1, maxT: 12,
    grade(tr) {
      const f = tr.flights.find((x) => x.overTruck);
      const flipped = f && f.tricks.includes('FRONT FLIP');
      const clean = f && f.minTruckClearance > 0 && !f.crashedOnLanding;
      const pass = !!(flipped && clean) && !tr.crashed && settled(tr.final);
      const progress = pass ? 1 : flipped ? 0.7 : clean ? 0.5 : f ? 0.35 : 0.1;
      return { pass, progress };
    },
  },
  {
    id: 'ring-1', split: 'test',
    goal: 'Fly through ring 1 (the ring at x=48, y=18, z=42), then land safely.',
    start: LAYOUT.spawnFree, fuel: 1, maxT: 30,
    grade(tr) {
      const hit = tr.rings.some((r) => r.ring === 1);
      const pass = hit && !tr.crashed && settled(tr.final);
      const near = Math.min(...tr.samples.map((s) => Math.hypot(s.x - 48, s.y - 18, s.z - 42)));
      const progress = pass ? 1 : hit ? 0.75 : Math.max(0, 0.6 * (1 - near / 90));
      return { pass, progress };
    },
  },
  {
    id: 'cloop', split: 'test',
    goal: 'Drive around the C-Loop so the car is upside down on it, then land back on your wheels without crashing.',
    start: STUNTS.loop.start, fuel: 0.6, maxT: 20,
    grade(tr) {
      const inverted = tr.samples.some((s) => s.surface === 'cloop' && s.upY < -0.45 && !s.airborne);
      const pass = inverted && !tr.crashed && settled(tr.final);
      const top = Math.max(0, ...tr.samples.filter((s) => s.surface === 'cloop').map((s) => s.y));
      const progress = pass ? 1 : inverted ? 0.7 : Math.min(0.6, top / 30);
      return { pass, progress };
    },
  },
  {
    id: 'wall-launch', split: 'test',
    goal: 'Ride up the Mega Wall, launch off the top, and land in the wall landing zone centred at (70, -20).',
    start: STUNTS.wall.start, fuel: 0.7, maxT: 25,
    grade(tr) {
      const launched = tr.flights.some((f) => f.from === 'megawall' && f.maxY > 25);
      const d = dist2(tr.final, 70, -20);
      const pass = launched && !tr.crashed && settled(tr.final) && d < 10;
      const top = Math.max(0, ...tr.samples.filter((s) => s.surface === 'megawall').map((s) => s.y));
      const progress = pass ? 1 : launched ? 0.5 + 0.3 * Math.max(0, 1 - d / 40) : Math.min(0.45, top / 60);
      return { pass, progress };
    },
  },
];

export const getTask = (id) => TASKS.find((t) => t.id === id);

// start presets for free-text goals (live demo: "give us a stunt")
export const STARTS = {
  free: { start: LAYOUT.spawnFree, label: 'open floor near the arena centre, facing +z' },
  stage: { start: LAYOUT.spawnStage, label: 'on the stage, facing +z' },
  truck: { start: STUNTS.truck.start, label: 'truck run-up line, facing the kicker ramp (-x)' },
  wall: { start: STUNTS.wall.start, label: 'Mega Wall run-up line, facing the wall (+x)' },
  loop: { start: STUNTS.loop.start, label: 'C-Loop run-up line, facing the loop (-z)' },
};
export function customTask(goal, startKey = 'free', { fuel = 1, maxT = 30 } = {}) {
  const s = STARTS[startKey] || STARTS.free;
  return { id: 'custom', split: 'custom', goal, start: s.start, fuel, maxT, grade: null };
}
export const TRAIN = TASKS.filter((t) => t.split === 'train');
export const TEST = TASKS.filter((t) => t.split === 'test');
