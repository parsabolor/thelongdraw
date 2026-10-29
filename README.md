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

- **What is in the repository:** the characters, weapons, bike, lookout hut, and the terrain and outpost scans, trimmed for the browser (`assets/models/game/`, `assets/world/`, 58 MB), and the CC0 textures in `assets/textures/` (Poly Haven, see `assets/textures/CREDITS.md`). The trees are generated in code.
- **Licences:** the owner who downloaded that art says it is all under free licences that need no credit. The download packs carry no licence files, so this repository has no per-model licence record: if you reuse a model outside this project, check where it came from.
- **What is not:** the raw downloads (about 800 MB, `assets/models/incoming/`), which are too large for git. `tools/prep-assets.mjs`, `prep-scout.mjs` and `prep-world.mjs` rebuild the trimmed files from them if you have them. `src/world-data.js` is baked from the terrain scan by `node tools/prep-world.mjs terrain`.
- **Using your own art:** see `assets/models/README.md`. Every model is optional: delete one and the game falls back to a built-in stand-in (procedural people, a textured box for the fort, a neutral ground).

## Licence

No licence has been chosen for this code yet, so all rights are reserved until the owner adds one. That is about the code; the art above has its own licences. Three.js is MIT-licensed and is installed from npm.
