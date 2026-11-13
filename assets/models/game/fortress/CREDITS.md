# Fortress credits

The fortress round the outpost (`src/level.js` WALLS) is made from two Poly Haven models, both CC0 (public domain, no credit needed; credited anyway):

| Files | Source | Licence |
| --- | --- | --- |
| `wall_long.glb`, `wall_short.glb`, `wall_gate.glb`, `wall_corner.glb` | Modular Fort 01, https://polyhaven.com/a/modular_fort_01 | CC0 |
| `door_leaf_left.glb`, `door_leaf_right.glb` | Large Castle Door, https://polyhaven.com/a/large_castle_door | CC0 |

Modified by the engine's `tools/import-fortress.py`: four of the kit's pieces and the door's two leaves, each on its own, scaled to the level (walls 0.5954, leaves 1.083), their
look (the kit's three tiled materials and its grime mask) baked into one plain material with 2048 px colour, roughness and normal maps.
