# Roadster Flight

**▶ Play: https://rikinshah787.github.io/Roadstar/**

A 3D browser game inspired by flying-roadster stunt videos. Drive a white roadster through a
laser-lit night arena, fire the cold-gas thrusters, jump and flip over a car-carrier truck, ride a
34 m wall straight up, run a C-loop upside down, and finish with donuts in a laser grid. There are
7 levels with stars, an online leaderboard, and a live count of who's playing.

Built with Three.js + Vite. Everything (car, truck, ramps, arena, textures, sound and music) is
generated in code, so there are no asset files to download.

## Run it

```
npm install      # first time only
npm run dev      # opens http://localhost:5173
```

`npm run build` makes a static build in `dist/` (serve it with `npm run preview`).

## Online leaderboard (Supabase)

1. Apply `supabase/migrations/*_scores_leaderboard.sql` to your project (`npx supabase db push`, or
   paste it into the SQL Editor).
2. Copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` and the **publishable /
   anon** key. Never use the `sb_secret_` key in the game; it would be visible to every player.
3. Restart `npm run dev`.

Without these settings the game still works, and scores are kept in the browser.

## Deploy

Every push to `main` builds and publishes to GitHub Pages
(`.github/workflows/deploy.yml`). The build reads the repo variable `VITE_SUPABASE_URL` and the
repo secret `VITE_SUPABASE_ANON_KEY`.

## Modes

- **Stunt Tour** (from *The Kickflip* and *Real life, baby*): 4 stunts in a row, each with a
  title card, its own start line and slow-motion shots:
  1. **Truck Kickflip**: hit the kicker ramp and press R in the air to kickflip over the truck
     loaded with gold cars.
  2. **Mega Wall**: drive straight up the 34 m curved wall, launch off the lip, then use the
     thrusters to land in the smoke zone.
  3. **The C-Loop**: run the loop upside down, then catch the drop and land it.
  4. **Donut Finale**: 3 donuts inside the laser grid in front of the showcase lineup.

  Crash or miss a stunt and you go back to that stunt's start line. Your clip's **views** grow
  with every trick.
- **Launch Show** (from the reveal video): cone lane → lift-off → 3 rings → flip → pad landing
  → donuts → park on stage.
- **Free Roam**: everything is open; rings, ramps, wall and loop all score.

Tricks bank when you land upright. Crash or land upside down and you lose the pending points.

## Controls

| Key | Action |
| --- | --- |
| W / S | Drive / brake-reverse · pitch when flying |
| A / D | Steer · turn when flying |
| Space | Fire thrusters / climb (assist holds altitude when released) |
| Shift | Descend · handbrake on the ground |
| Q / E | Roll / strafe in the air |
| W + S | Burnout (add A/D for donuts) |
| R | Kickflip (can be pressed just before take-off) |
| F / B | Front flip / back flip |
| C | Cycle camera: chase, crowd cam, drone (top-down), cinematic, cockpit |
| V | Phone-video frame: vertical crowd cam with likes/views rail |
| K | Record a clip; press again to save a `.webm` (vertical when the phone frame is on) |
| T | Flight assist on/off (off = acro mode) |
| Enter | Back to the start line / reset · M mute · H help · Esc pause |

A gamepad works too: RT/LT drive, left stick steer/pitch, right stick roll, A/B up/down, X flip, LB kickflip, Y camera.

Slow-motion stunt shots can be switched off in the pause menu.

## Graphics

HDR rendering with neutral tone mapping, bloom, planar wet-floor reflections, volumetric light beams,
lasers, soft particle smoke and vapor, PCF soft shadows from a follow-spot, floodlight towers, and a
procedural environment map for the clear-coat paint. Choose a quality preset on the title screen.
If the frame rate drops below about 38 fps, the game steps down a preset by itself.

## Code map

| File | What it does |
| --- | --- |
| `src/main.js` | renderer, post-processing, slow-mo/cinematic effects, main loop, UI wiring |
| `src/environment.js` | arena: floor + reflections, stage, beams, lasers, crowd, cones, rings |
| `src/stunts.js` | stunt park: Mega Wall, C-Loop, kicker + semi truck, lineup, laser grid, floodlights |
| `src/colliders.js` | signed-distance collision world (ground, curved ramps, boxes) |
| `src/car.js` | procedural roadster model (lofted body, light bars, wheels, thrusters) |
| `src/physics.js` | rigid-body vehicle: sphere-traced suspension, tyre grip, wall grip, thrusters, tricks |
| `src/particles.js` | billboard particle system (vapor, tyre smoke, haze, smoke cannons) |
| `src/game.js` | Stunt Tour / Launch Show objectives, trick detection, scoring, views |
| `src/camera.js` | chase / crowd / drone / cinematic / cockpit cameras + stunt shots |
| `src/recorder.js` | clip recorder with burned-in captions |
| `src/audio.js` | synthesized motor, thrusters, tyres, crowd and music |
| `src/hud.js`, `src/style.css` | HUD, likes, title cards and menus |
