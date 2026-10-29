// Fetches the CC0 Quaternius "Zombie Apocalypse Kit" (animated zombies and survivors, plus a few props) from its
// public Google Drive folder into assets/models/candidates/quaternius-zak/. Re-runnable: skips files already there.
// Google Drive refuses popular files with "Quota exceeded" for up to 24 hours; the script then stops and says so
// (exit code 2): run it again later. Downloads are untrusted data and never executed: each file must parse as glTF
// JSON (or, for the licence, contain "Creative Commons") or it is not saved.
//   node tools/fetch-quaternius.mjs
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

const OUT = new URL('../assets/models/candidates/quaternius-zak/', import.meta.url).pathname;
const FILES = {
  characters: {
    'Zombie_Basic.gltf': '1S6EfXv0Fc6SiqyoPx5gNF48MI0OajNLr', 'Zombie_Arm.gltf': '19MMkSg5NkpeSNb6271EoN_pNeBlQpt4Z',
    'Zombie_Chubby.gltf': '1PKHYBqygDy3ztkJLOQWx4fY00eFL0epN', 'Zombie_Ribcage.gltf': '1mcGcs5UeeBpgbSwhu3r2yZWoB0V4dazt',
    'Characters_Matt.gltf': '1yNs2723NIl51s_LcI6ISpUkb7REeURv2', 'Characters_Sam.gltf': '1yv-OLGTp4tEm2_PM02TXhoh7jz2bzLLo',
    'Characters_Lis.gltf': '1732QBPPKRkeGmhm-b8PBPR_Imkz8iUl3', 'Characters_Shaun.gltf': '1CLkXsgz8QJKi5Ty8snQUFiGnfBEa0GWO',
  },
  props: {
    'Barrel.gltf': '114k_vH2gWjaumPc39bKfGRdRvkB8Ym4Q', 'Container_Green.gltf': '1lX57FkFymKSZRjOhwrbOP7CjvQVaFdQM',
    'Container_Red.gltf': '10SC_m23U-_UGPRlUdQwW1iqi0-QAtpzq', 'Pallet.gltf': '1qI0DJkGfnOG85-7W1uE1ceZni1A4JKBS',
    'Pallet_Broken.gltf': '1hZFumQsNw-1cjYBpUPS-PsdSLRwEktq-', 'PlasticBarrier.gltf': '19Qff0L9UtY_pumPT1jdbfFYLMRMWl9X7',
    'TrafficBarrier_1.gltf': '1AtADK-CW_7EfMiBeMGL95Iu4FnolBCBq', 'TrafficBarrier_2.gltf': '1bnXoYPgYw6eX8pyN0G5B1BMiNy17P8MW',
    'StreetLights.gltf': '1kIQHIMErEozis98TX8Dyca3uWXOKtfkq', 'WaterTower.gltf': '1RSQt1S8iHFOfnQOegpX0p41VHw3W0g6X',
    'Wheels_Stack.gltf': '1Oa4cOiUt9PpNeLi5xFhHhwnAix3bor-w', 'Wheel.gltf': '1OmFnmerM0noHCt5CeTr5KdwpvO62Eiyq',
    'Pipes.gltf': '1hxT5Xnm77y6gXOKwriNSXonaxf4W-wdY', 'TrashBag_1.gltf': '1FuihhOhGyhKCycJPTYtPHnBBWbGHEpMF',
    'TrashBag_2.gltf': '1A4AfNM4-4XtSLkLr-_SC40fThLguleNb', 'CinderBlock.gltf': '1bmCa_mWLpiJHr2fH8CxjxQXdCsUIM3oA',
    'TownSign.gltf': '1RardVh99rHg6BUVCokWSzyin66nFCgHZ', 'FireHydrant.gltf': '12eTSrvHAa4D5Sr-_oFnMEHWYY65jwDGo',
  },
  licence: { 'License.txt': '1580uoubj39h6sNRFo394PvNU4ozIwehi' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const manifest = [];
let quota = false, failed = 0;

for (const [group, files] of Object.entries(FILES)) {
  mkdirSync(OUT + group, { recursive: true });
  for (const [name, id] of Object.entries(files)) {
    const path = `${OUT}${group}/${name}`;
    if (existsSync(path)) { manifest.push({ group, name, id, status: 'already there' }); continue; }
    if (quota) { manifest.push({ group, name, id, status: 'skipped (quota)' }); continue; }
    const res = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, { redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer()), text = buf.subarray(0, 4000).toString('utf8');
    let status = 'ok';
    if (/Quota exceeded|Too many users/i.test(text)) { quota = true; status = 'quota exceeded'; }
    else if (buf.length < 200 || (name.endsWith('.gltf') && !validGltf(buf)) || (name.endsWith('.txt') && !/Creative Commons/i.test(text))) { status = 'not the expected file'; failed++; }
    if (status === 'ok') writeFileSync(path, buf);
    manifest.push({ group, name, id, bytes: buf.length, status });
    console.log(`${status === 'ok' ? 'ok     ' : 'FAILED '} ${group}/${name} ${status === 'ok' ? buf.length + ' bytes' : status}`);
    await sleep(400);
  }
}
writeFileSync(OUT + 'manifest.json', JSON.stringify(manifest, null, 2));
if (quota) { console.log('\nGoogle Drive quota exceeded: nothing more can be fetched right now. Run this script again later (up to 24 hours).'); process.exit(2); }
console.log(failed ? `\n${failed} file(s) were not what was expected.` : '\nAll files fetched.');
process.exit(failed ? 1 : 0);

function validGltf(buf) { // plain glTF JSON with an asset block, never executed
  if (buf[0] !== 0x7b) return false;
  try { const j = JSON.parse(buf.toString('utf8')); return !!(j.asset && (j.meshes || j.scenes)); } catch { return false; }
}
