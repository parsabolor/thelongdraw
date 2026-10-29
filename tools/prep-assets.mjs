// Prepares the user-supplied models in assets/models/incoming/ for the browser: copies each model into
// assets/models/game/ under a short name and downscales its textures with macOS `sips` (the originals are up to 28 MB).
// Re-runnable: outputs that already exist are skipped. Only albedo and normal maps are kept (src/models.js wires those).
// Not prepared on purpose: the 206 MB outpost scan / 54 MB terrain scan (too heavy for a browser).
//   node tools/prep-assets.mjs
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';

const IN = fileURLToPath(new URL('../assets/models/incoming/', import.meta.url)), OUT = fileURLToPath(new URL('../assets/models/game/', import.meta.url));
// [source folder, model file inside it, output name, textures: [file in <source>/textures/, output name, max pixels]]
const JOBS = [
  ['machete-sword-knife-17mb', 'source/sword.fbx', 'knife.fbx', [['BaseColor.png', 'knife_albedo.jpg', 512], ['Normal.png', 'knife_normal.jpg', 512]]],
  ['arrow', 'source/ArrowSketchfab_x/ArrowSketchfab/Arrow.obj', 'arrow.obj', [['Arrow_ALB.png', 'arrow_albedo.jpg', 512], ['Arrow_NRM.png', 'arrow_normal.jpg', 512]]],
  ['zombie-walk-test', 'source/Zombie Walk.fbx', 'zombie.fbx', [['zombie_Packed0_Diffuse.png', 'zombie_albedo.jpg', 2048], ['zombie_Packed0_Normal.png', 'zombie_normal.jpg', 2048]]], // the atlas fills only a quarter of the image, so keep it large
  ['igme-317-p3-survivor', 'source/Survivor_textured.fbx', 'survivor.fbx', ['Body', 'Head', 'Legs'].flatMap((p) => [
    [`M_${p}_albedo.jpg`, `survivor_${p.toLowerCase()}_albedo.jpg`, 1024], [`M_${p}_normal.png`, `survivor_${p.toLowerCase()}_normal.jpg`, 1024]])],
  ['motorcycle', 'source/cafe_racer.glb', 'bike.glb', []], // textures are embedded in the .glb (13 MB, one instance: used as is)
  ['outpost', 'source/outpost_x/outpost.fbx', 'hut.fbx', [['color.png', 'hut_albedo.jpg', 512], ['normal.png', 'hut_normal.jpg', 512]]],
  // first-person bow viewmodel (src/bow.js loadBowAssets): one texture set per model
  ['compound-bow', 'source/CompoundGame.fbx', 'bow.fbx', [['blinn1_Base_Color.png', 'bow_albedo.jpg', 1024], ['blinn1_Normal_DirectX.png', 'bow_normal.jpg', 1024]]],
  ['avalon-bow-sight', 'source/avalon.fbx', 'sight.fbx', [['avalon_tec_one_carbon_LP_DefaultMaterial_A.png', 'sight_albedo.jpg', 1024], ['avalon_tec_one_carbon_LP_DefaultMaterial_N.png', 'sight_normal.jpg', 1024]]],
];

mkdirSync(OUT, { recursive: true });
const kb = (p) => Math.round(statSync(p).size / 1024) + ' KB';
for (const [dir, model, name, textures] of JOBS) {
  const src = `${IN}${dir}/`;
  if (!existsSync(src + model)) { console.log(`MISSING ${dir}/${model} (extract the zip into assets/models/incoming/${dir}/ first)`); continue; }
  if (!existsSync(OUT + name)) copyFileSync(src + model, OUT + name);
  console.log(`${name.padEnd(28)} ${kb(OUT + name)}`);
  for (const [file, out, px] of textures) {
    if (!existsSync(src + 'textures/' + file)) { console.log(`MISSING ${dir}/textures/${file}`); continue; }
    if (!existsSync(OUT + out)) execFileSync('sips', ['-Z', String(px), '-s', 'format', 'jpeg', '-s', 'formatOptions', '88', src + 'textures/' + file, '--out', OUT + out], { stdio: 'ignore' });
    console.log(`${out.padEnd(28)} ${kb(OUT + out)}`);
  }
}
