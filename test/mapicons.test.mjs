import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAP_ICONS, zombieIcon } from '../src/mapicons.js';

test('the icons picture has one square cell for each map icon, in a row', () => {
  const png = readFileSync(new URL('../assets/ui/map-icons.png', import.meta.url));
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.equal(w, MAP_ICONS.length * h, `${w} x ${h} for ${MAP_ICONS.length} icons`);
});

test('a scout is binoculars, the armored zombie a vest, and every other zombie a walker', () => {
  assert.equal(zombieIcon({ kind: 'scout', role: 'scout' }), 'scout');
  assert.equal(zombieIcon({ kind: 'armored', role: 'armored' }), 'armored');
  for (const kind of ['hunter', 'sleeper', 'screamer']) assert.equal(zombieIcon({ kind, role: 'hunter' }), 'walker', kind);
  for (const icon of ['scout', 'armored', 'walker']) assert.ok(MAP_ICONS.includes(icon), icon);
});
