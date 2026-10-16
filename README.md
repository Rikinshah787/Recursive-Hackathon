# Roadster Flight

A 3D browser game inspired by the flying-roadster reveal video in this folder. You drive a white
roadster through a laser-lit night arena, light the cold-gas thrusters, fly through neon rings,
flip it, land it, and finish with a smoky burnout before parking on the stage.

Built with Three.js + Vite. Everything (car, arena, textures, sound and music) is generated in
code, so there are no asset files to download.

## Run it

```
npm install      # first time only
npm run dev      # opens http://localhost:5173
```

`npm run build` makes a static build in `dist/` (serve it with `npm run preview`).

## Modes

- **Launch Show**: the video's sequence as 7 timed objectives (cone lane → lift-off → 3 neon
  rings → flip → pad landing → 2 donuts → park on stage). You get a grade, and your best score is saved.
- **Free Flight**: open arena, all rings live, trick scoring.

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
| F / B / R | Front flip / back flip / barrel roll |
| C | Cycle camera: chase, crowd cam, cinematic, cockpit |
| V | Phone-video frame (vertical crowd cam, like the original clip) |
| T | Flight assist on/off (off = acro mode) |
| Enter | Reset car · M mute · H help · Esc pause |

A gamepad works too: RT/LT drive, left stick steer/pitch, right stick roll, A/B up/down, X flip, LB roll, Y camera.

## Graphics

HDR rendering with neutral tone mapping, bloom, planar wet-floor reflections, volumetric light beams,
lasers, soft particle smoke and vapor, PCF soft shadows from a follow-spot, and a procedural
environment map for the clear-coat paint. Choose a quality preset on the title screen. If the
frame rate drops below about 38 fps, the game steps down a preset by itself.

## Code map

| File | What it does |
| --- | --- |
| `src/main.js` | renderer, post-processing, effects, main loop, UI wiring |
| `src/environment.js` | arena: floor + reflections, stage, beams, lasers, crowd, cones, rings |
| `src/car.js` | procedural roadster model (lofted body, light bars, wheels, thrusters) |
| `src/physics.js` | rigid-body vehicle: raycast suspension, tyre grip, thrusters, flight assist, tricks |
| `src/particles.js` | billboard particle system (vapor, tyre smoke, haze) |
| `src/game.js` | show objectives, trick detection, scoring, crashes |
| `src/camera.js` | chase / crowd / cinematic / cockpit cameras |
| `src/audio.js` | synthesized motor, thrusters, tyres, crowd and music |
| `src/hud.js`, `src/style.css` | HUD and menus |
