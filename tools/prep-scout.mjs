// Prepares the scouts' model (the supplied "dead man" GLB, exported from the .blend) for the browser:
//   node tools/prep-scout.mjs      assets/models/incoming/zombie-glb/zombie.glb  ->  assets/models/game/scout.glb
// The file has ten vertex attributes on its big mesh (position, normal, tangent, skin indices and weights, and five identical UV sets), and WebGPU
// allows only eight vertex buffers per pipeline, so the mesh silently fails to draw. This drops what is not needed (the extra UV sets, which are
// identical to the first, and the tangents), points every texture at UV set 0, and downsizes the five 2048 px textures to 1024 JPEGs with macOS `sips`.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = `${ROOT}assets/models/incoming/zombie-glb/zombie.glb`, OUT = `${ROOT}assets/models/game/scout.glb`;
const doc = await new NodeIO().read(SRC), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-'));
const root = doc.getRoot();

let dropped = 0;
for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
  for (const semantic of prim.listSemantics()) {
    if (['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'].includes(semantic)) continue;
    prim.setAttribute(semantic, null); dropped++;
  }
}
for (const mat of root.listMaterials()) { // every texture reads UV set 0 (the sets were identical)
  for (const info of [mat.getBaseColorTextureInfo(), mat.getNormalTextureInfo(), mat.getEmissiveTextureInfo(), mat.getMetallicRoughnessTextureInfo(), mat.getOcclusionTextureInfo()]) if (info) info.setTexCoord(0);
}
let n = 0;
for (const tex of root.listTextures()) { // 2048 px PNGs -> 1024 px JPEGs
  const src = path.join(tmp, `t${n}.${tex.getMimeType() === 'image/jpeg' ? 'jpg' : 'png'}`), dst = path.join(tmp, `t${n}.out.jpg`); n++;
  fs.writeFileSync(src, tex.getImage());
  execFileSync('sips', ['-Z', '1024', '-s', 'format', 'jpeg', '-s', 'formatOptions', '88', src, '--out', dst], { stdio: 'ignore' });
  tex.setImage(fs.readFileSync(dst)).setMimeType('image/jpeg');
}
for (const a of root.listAccessors()) if (a.listParents().every((p) => p.propertyType === 'Root')) a.dispose(); // the accessors of the dropped attributes
await new NodeIO().write(OUT, doc);
fs.rmSync(tmp, { recursive: true, force: true }); // the temp folder this script made
console.log(`dropped ${dropped} attributes, resized ${n} textures; wrote ${path.relative(ROOT, OUT)} ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB (was ${(fs.statSync(SRC).size / 1e6).toFixed(1)} MB)`);
