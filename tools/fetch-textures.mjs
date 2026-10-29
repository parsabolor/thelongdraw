// Fetches one CC0 Poly Haven PBR set (1k JPG: Diffuse, nor_gl, Rough) per role into assets/textures/<role>/.
// Usage: node tools/fetch-textures.mjs     (re-runnable; skips files already present for the same slug)
// Only api.polyhaven.com and dl.polyhaven.org are contacted. Downloads are untrusted data: each file is
// checked for JPEG magic bytes (FF D8 FF) and a size cap before it is written, and is never executed.
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'textures');
const MAX_BYTES = 3 * 1024 * 1024;
const MAPS = { diff: 'Diffuse', nor: 'nor_gl', rough: 'Rough' }; // our file name -> Poly Haven map key

// role -> Poly Haven slug + real-world metres covered by one texture tile (estimate)
const ROLES = {
  ground:   { slug: 'rock_ground',           tileMeters: 4.0 }, // dry gravelly dirt
  asphalt:  { slug: 'asphalt_02',            tileMeters: 3.0 }, // cracked road
  concrete: { slug: 'concrete_wall_007',     tileMeters: 2.0 }, // weathered board-formed wall
  metal:    { slug: 'worn_corrugated_iron',  tileMeters: 1.5 }, // peeling, rusting corrugated sheet (ribs run along V)
  wood:     { slug: 'weathered_planks',      tileMeters: 1.5 }, // dark planks (run along V)
  rock:     { slug: 'rock_face_03',          tileMeters: 4.0 }, // cracked brown rock face
  bark:     { slug: 'bark_brown_01',         tileMeters: 1.5 }, // trunk bark (grain runs along V)
};

const getJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
};
const exists = (p) => stat(p).then((s) => s.size > 0, () => false);

const catalogue = await getJson('https://api.polyhaven.com/assets?t=textures');
let prev = {};
try { prev = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8')); } catch {}

const manifest = {};
let bytes = 0;
for (const [role, { slug, tileMeters }] of Object.entries(ROLES)) {
  if (!catalogue[slug]) throw new Error(`slug not on Poly Haven: ${slug} (role ${role})`);
  const files = {};
  const same = prev[role]?.slug === slug; // a changed slug means stale files: re-download
  let listing;
  for (const [name, key] of Object.entries(MAPS)) {
    const rel = `${role}/${name}.jpg`;
    const dest = path.join(OUT, rel);
    files[name] = rel;
    if (same && (await exists(dest))) { console.log(`skip   ${rel}`); continue; }
    listing ??= await getJson(`https://api.polyhaven.com/files/${slug}`);
    const url = listing[key]?.['1k']?.jpg?.url;
    if (!url || !url.startsWith('https://dl.polyhaven.org/')) throw new Error(`${slug}: no 1k jpg for ${key}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`${url}: ${buf.length} bytes exceeds cap`);
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw new Error(`${url}: not a JPEG`);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    bytes += buf.length;
    console.log(`fetch  ${rel}  ${(buf.length / 1e6).toFixed(2)} MB  <- ${url}`);
  }
  manifest[role] = { slug, tileMeters, files };
}

await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const credits = ['# Texture credits', '',
  'All textures are CC0 (public domain) from Poly Haven, 1k JPG. Fetched by tools/fetch-textures.mjs.', '',
  '| Role | Slug | Source | License |', '| --- | --- | --- | --- |',
  ...Object.entries(manifest).map(([role, m]) => `| ${role} | ${m.slug} | https://polyhaven.com/a/${m.slug} | CC0 |`), ''];
await writeFile(path.join(OUT, 'CREDITS.md'), credits.join('\n'));
console.log(`done, downloaded ${(bytes / 1e6).toFixed(2)} MB`);
