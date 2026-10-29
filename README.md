# The Long Draw (working title): a stealth-archery zombie prototype

A playable browser prototype of one outpost from a stealth-archery game about zombies: you plan every shot, noise is the enemy, and a miss makes a sound where the arrow
lands, not where you stand. It is a single page, plain ES modules, Three.js with the WebGPU renderer (it falls back to WebGL 2 on its own), and no bundler.

## Run it

You need Node.js 20 or newer (to serve the files and run the tests) and a current Chrome, Edge or Safari.

```sh
npm install
npm start          # serves http://127.0.0.1:5173/
```

Open http://127.0.0.1:5173/ and follow the start screen. `npm start` runs `tools/serve.mjs`, which makes the browser revalidate every file on every load and stamps each module
with its modification time. Use it rather than a plain static server: a browser that keeps an old `level.js` next to a new `main.js` leaves the page stuck on
"Loading renderer..." with no error on screen.

## Controls

| | |
|---|---|
| `WASD`, `Shift`, `C` | move, run, crouch |
| right mouse (hold) | raise the bow (first person, slider sight); the wheel sets the sight's range, 20 to 60 m |
| left mouse (hold, release) | draw, fire |
| `1`, `2` | plain arrow, whistling arrow (a lure) |
| `F` | knife: a silent kill from behind or on a sleeper, a noisy stab otherwise |
| `E` | pick up an arrow, or bail out at the bike |
| `B` | binoculars: the wheel zooms, anything inside the viewfinder for one second is tagged |
| `G`, `M`, `H`, `R` | AI debug map, sound on/off, help, restart |

The wind (bottom right) pushes arrows sideways, more at range. Zombies hunt by sound and sight; scouts on high ground see far and call the others to where you are;
a zombie that hears a noise goes to look, then searches the area within 20 m of it.

## Tests

```sh
npm test           # node --test
```

The simulation, level, tools and animation maths run in Node with no browser (`test/`). Tests that need the survivor model are skipped when its file is not present.

## What is where

| | |
|---|---|
| `src/sim.js` | the rules, as a pure deterministic 60 Hz simulation: movement, noise and hearing, sight, the zombies' states, arrows, wind, the knife |
| `src/level.js`, `src/world-data.js` | the outpost as data (fort collision, spawns, patrol points) over a baked heightmap (`world-data.js` is generated) |
| `src/main.js` | rendering, input, the HUD and the minimap; the game rules stay in `sim.js` |
| `src/survivor.js`, `held.js`, `fparms.js`, `ik.js`, `motion.js` | the player's body: a rig skinned onto a static model, procedural walk, crouch and stab, what it carries, first-person arms with two-bone IK |
| `src/ragdoll.js`, `trees.js`, `detail.js`, `bow.js`, `models.js`, `characters.js`, `audio.js`, `materials.js` | ragdolls, instanced conifers, material detail, the first-person bow, model loading, procedural people (the fallback), sound, textures |
| `tools/` | `serve.mjs` (the dev server) and the scripts that turn downloaded art into game files (`prep-*.mjs`, `fetch-*.mjs`) |
| `dev/` | viewer pages for single parts (`dev/survivor.html`, `dev/trees.html`, `dev/bow.html`, ...) |

## Art and licences

**This repository holds code and the CC0 textures in `assets/textures/` (Poly Haven, see `assets/textures/CREDITS.md`).** The prototype was built and tuned with
character, weapon, building and terrain art from downloads whose licences were never verified, so that art is **not** in this repository. Without it the game still
runs: the people are the built-in procedural figures, the fort is textured boxes, the ground is a neutral rocky base with gravel detail, and the trees are generated in code.

- `src/world-data.js` is the one piece derived from that art: a 201 x 201 heightmap (1 m grid) baked from a scanned terrain, which the level is laid out on. If the
  source's licence does not allow this, replace it with terrain you have the rights to (the baking script is `node tools/prep-world.mjs terrain`).
- To use your own art, see `assets/models/README.md`. The `tools/prep-*.mjs` scripts expect the original downloads under `assets/models/incoming/`; everything they
  write (`assets/models/game/`, `assets/world/`) is git-ignored.

## Licence

No licence has been chosen for this code yet, so all rights are reserved until the owner adds one. Three.js is MIT-licensed and is installed from npm.
