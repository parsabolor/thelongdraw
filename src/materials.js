// PBR materials from assets/textures (Poly Haven CC0, see assets/textures/CREDITS.md).
//
// const mats = await loadMaterials(renderer)
//   mats.ground | asphalt | concrete | metal | wood | rock | bark   MeshStandardMaterial { map, normalMap, roughnessMap }
//   mats.terrain   same textures as ground, vertexColors: true (tint terrain via a 'color' attribute)
//   every material has userData.tileMeters = real-world size of one texture tile
//
// UV CONVENTION (the caller does the scaling, textures keep repeat = 1):
//   1 UV unit = 1 tile, so  uv = world metres / material.userData.tileMeters.
//   Terrain/road meshes: write uv = (worldX, worldZ) / tileMeters. Boxes: use boxUV() below.
//   Grain of wood, bark and corrugated metal runs along V (vertical on box sides).
import * as THREE from 'three';

// flat colours used when a role's textures cannot be loaded
const FALLBACK = { ground: 0x5a5448, asphalt: 0x2b2b2d, concrete: 0x777468, metal: 0x6b4a36, wood: 0x4a3a2c, rock: 0x6a5a4a, bark: 0x5a4a30 };
const METALNESS = { metal: 0.6 };
const MAPS = [['diff', 'map', THREE.SRGBColorSpace], ['nor', 'normalMap', THREE.NoColorSpace], ['rough', 'roughnessMap', THREE.NoColorSpace]];

export async function loadMaterials(renderer) {
  let anisotropy = 8;
  try { anisotropy = Math.min(8, renderer.getMaxAnisotropy()) || 1; } catch { /* renderer not initialised or no support: keep 8 */ }

  const base = new URL('../assets/textures/', import.meta.url);
  let manifest = {};
  try {
    const r = await fetch(new URL('manifest.json', base));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    manifest = await r.json();
  } catch (e) { console.warn('[materials] manifest failed, using flat colours:', e.message); }

  const loader = new THREE.TextureLoader();
  const load = async (role, rel, colorSpace) => {
    try {
      const t = await loader.loadAsync(new URL(rel, base).href);
      t.colorSpace = colorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = anisotropy;
      return t;
    } catch (e) { console.warn(`[materials] ${role}: failed to load ${rel}, falling back`); return null; }
  };

  const mats = {};
  await Promise.all(Object.keys(FALLBACK).map(async (role) => {
    const m = manifest[role];
    const tex = {};
    if (m) await Promise.all(MAPS.map(async ([name, slot, cs]) => { tex[slot] = await load(role, m.files[name], cs); }));
    if (!tex.map) console.warn(`[materials] ${role}: no diffuse texture, flat colour`);
    mats[role] = new THREE.MeshStandardMaterial({
      ...tex, // a missing normal/rough map just stays null
      color: tex.map ? 0xffffff : FALLBACK[role],
      roughness: 1, // roughnessMap multiplies this
      metalness: METALNESS[role] ?? 0,
    });
    mats[role].name = role;
    mats[role].userData.tileMeters = m?.tileMeters ?? 2;
  }));

  mats.terrain = mats.ground.clone(); // shares the ground textures
  mats.terrain.vertexColors = true;
  mats.terrain.name = 'terrain';
  return mats;
}

// Rewrites a THREE.BoxGeometry's uv so one texture tile = tileMeters in world space on every face.
// w,h,d = the box's width (x), height (y), depth (z). Needs its own geometry (uv is not shared).
export function boxUV(geometry, w, h, d, tileMeters) {
  const uv = geometry.attributes.uv;
  const { widthSegments: ws = 1, heightSegments: hs = 1, depthSegments: ds = 1 } = geometry.parameters ?? {};
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z
  const faces = [
    [(ds + 1) * (hs + 1), d, h], [(ds + 1) * (hs + 1), d, h],
    [(ws + 1) * (ds + 1), w, d], [(ws + 1) * (ds + 1), w, d],
    [(ws + 1) * (hs + 1), w, h], [(ws + 1) * (hs + 1), w, h],
  ];
  let i = 0;
  for (const [count, su, sv] of faces) {
    for (let k = 0; k < count; k++, i++) uv.setXY(i, (uv.getX(i) * su) / tileMeters, (uv.getY(i) * sv) / tileMeters);
  }
  uv.needsUpdate = true;
  return geometry;
}
