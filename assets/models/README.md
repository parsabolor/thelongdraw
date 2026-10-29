# Character models

Drop model files in this folder and reload the game. A missing file is fine: the game then uses its built-in
procedural people. `src/models.js` does the loading; open the browser console to see what it decided.

## Zombie

1. Open [ANIMATION ZOMBIE by MUD](https://sketchfab.com/3d-models/animation-zombie-0d0b5b62fd8e48b9bd31f3769d2877e7)
   (CC Attribution, 4.6k faces, 16 animations). Log in to Sketchfab, press **Download 3D Model**, choose **glTF**.
2. Either save a single file as `zombie.glb` here, or unzip the download so it reads `zombie/scene.gltf`
   (next to its `scene.bin` and `textures/` folder).
3. The licence is CC BY 4.0, so the game must credit the author. Create `credits.txt` here containing:

       Zombie model: "ANIMATION ZOMBIE" by MUD (sketchfab.com/3d-models/animation-zombie-0d0b5b62fd8e48b9bd31f3769d2877e7), CC BY 4.0.

   Its text appears on the start screen.
4. Reload. The console prints a `[models] zombie` line (triangles, size, scale, root bone, and which clip it chose
   for idle, walk, run, attack and death) and a table of all the model's clips. To fix a wrong pick, set the clip by
   name or index in `CFG.zombie.clips` in `src/models.js`. If it faces away from where it walks, set
   `CFG.zombie.yaw = Math.PI`. Open `/?clip=N` to play clip N on every zombie and see what each animation is.

## Player

Same as above with `player.glb` or `player/scene.gltf`. Notes:
- A model with no animations only bobs and leans while moving.
- It will not carry a bow in third person (the first-person bow is separate).
- Above 50,000 triangles it stops casting shadows, to protect the frame rate.

## The prepared models in `game/` (what the game loads by default)

The prototype was built from ten downloaded art packs, which are not in this repository. They were extracted into
`incoming/` (about 700 MB, never deploy or zip it) and trimmed for the browser by `node tools/prep-assets.mjs`, which writes
`game/` (33 MB: models plus 512 to 2048 px albedo and normal maps). `src/models.js` loads them; every one is optional.

| File | What it is | Used as |
|---|---|---|
| `game/zombie.fbx` | Mixamo-rigged "Zombie Walk", one 4 s walk clip, 33k triangles | every zombie (idle = the walk slowed, run = faster; when it dies it becomes a Verlet ragdoll, `src/ragdoll.js`) |
| `game/survivor.fbx` | camo survivor, 47k triangles, no rig in the file | the player in third person: skinned to a 19-bone skeleton at load and animated (idle, walk, run, crouch) by `src/survivor.js` |
| `game/knife.fbx` | kukri, 4k triangles | the knife: on the right hip, swung out when F is pressed |
| `game/arrow.obj` | arrow, 5k triangles, drawn 3x thicker and with a glowing fletching so it shows at night | every arrow in flight or stuck in a body or the ground |
| `game/bike.glb` | cafe racer, 95k triangles | the bike at the start |
| `game/hut.fbx` | lookout hut, 810 triangles | stands on a solid box at the edge of the pad (`skin: 'hut'` in `src/level.js`) |
| `game/scout.glb` | the owner's "dead man" (Blender export `zombie.glb`, 109k triangles, PBR + emission maps, one 11.7 s sway clip), prepared by `node tools/prep-scout.mjs` | the 3 scouts, on the vantage points (about 2 m tall, tinted slightly blue; it ragdolls like the others) |
| `game/bow.fbx`, `game/sight.fbx` | compound bow (22 parts, 12k triangles) and the Avalon slider sight | the first-person bow and sight (`src/bow.js`); the pins stay procedural at the ballistics positions |

**Licences are not verified.** The zips carry no licence file. They are prototype art only: check each model's licence (and credit it) before
anything is shown outside the team or sold. The start screen says so (`credits.txt`).

## The world: terrain and outpost scans (`assets/world/`, built by `tools/prep-world.mjs`)

| Source (in `incoming/`) | Built into | What it became |
|---|---|---|
| `rugged-terrain` (200 m square scan, 0 to 39 m of relief, 2.1M triangles) | `src/world-data.js` (GENERATED, 106 KB) + `assets/world/terrain_{albedo,normal}.jpg` | the ground: baked on the sim's 1 m grid, with the outpost pad cut flat at exactly y = 0 and the ground mirrored beyond the scan's edge |
| `abandoned-military-outpost-building-scan` (1.3M triangles, ground slab, 3 textures of 8192 px) | `assets/world/outpost.glb` (220k triangles, 14 MB; `OUTPOST` in the tool: 4096 px diffuse, 2048 px normal) | the ruined stone fort: the scan's ground slab, below-ground junk, a sliver artefact and small floating islands removed, placed with its door sill at the pad |

How the world is drawn (all in `src/main.js`): the ground is `terrainGrid` from `src/level.js`, a smooth (Catmull-Rom) surface through the sim's 1 m heights, subdivided to
0.25 m cells within 60 m of the pad and the plain 1 m grid out to 140 m. The sim keeps its own bilinear terrain; the renderer's surface agrees with it at every grid point and is at
most about 25 cm off between them. The scan textures are soft (the terrain's colour map is 1024 px over 200 m), so `src/detail.js` multiplies tiling CC0 detail from
`assets/textures` on top in the material (gravel on the ground at two scales, concrete and rock on the fort), sampled in world space and normalised so it adds grain without shifting colour.
Trees are generated in code by `src/trees.js` (three seeded conifer variants, instanced), not from a model file.

The fort's collision is authored by hand in `src/level.js` from the 1 m column maps the tool prints (about 20 boxes, with a 2 m doorway). To rebuild:
`node tools/prep-world.mjs terrain` then `node tools/prep-world.mjs outpost`. Both need `npm install` (dev dependencies `meshoptimizer` and
`@gltf-transform/core`) and macOS `sips`.

Not used: the survivor's bow-draw pose. `zombie.zip` held a Blender file, so the owner exported `zombie.glb` from it; that file has ten vertex
attributes and WebGPU allows eight vertex buffers, so it silently did not draw. `tools/prep-scout.mjs` drops the unused ones (the identical extra UV sets
and the tangents) and resizes the textures to 1024 px, making `game/scout.glb` (7 MB).

## Models that were looked at and not used

- "rugged charactor" (Atrikumar Das): not downloadable on Sketchfab, no licence shown, no animations, 251k faces; its
  description points to a CGTrader listing. Check that licence before using it for a game you sell.
- "LString Compound Bow CB19" (John Lai): a Fallout 4 mod model; not downloadable, no licence shown. The
  first-person bow in `src/bow.js` is procedural instead.

`dev/fixtures/test-zombie.glb` is a tiny generated test model used to check the loader. It is not a game asset.
