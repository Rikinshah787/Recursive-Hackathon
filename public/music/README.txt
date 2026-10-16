ROADSTER FLIGHT - CUSTOM MUSIC
==============================

By default the game plays its own built-in soundtrack: a procedural electronic anthem
(126 BPM, A minor) that is synthesised live in the browser and reacts to how you drive
(speed, air time, landings, wall rides, tricks, slow motion).

Want your own track instead?

  1. Drop an audio file in this folder named exactly:
        track.mp3      (or  track.ogg  - the .mp3 is checked first)

  2. Optional: add  track.json  next to it so the arena lights pulse on the beat:
        { "bpm": 128, "offset": 0 }

     bpm    - tempo of your track (default 126)
     offset - seconds from the start of the file to the first beat (default 0)

  3. Reload the game. The track loops in place of the built-in music. It still goes
     through the game's music bus, so the MUSIC on/off toggle, the slow-motion muffle,
     landing impacts and the clip recorder all keep working.

Remove (or rename) the file to get the built-in music back.

Only use music you own or have the rights to use (for example royalty-free / licensed
tracks), especially if you share recorded clips or publish the game.
