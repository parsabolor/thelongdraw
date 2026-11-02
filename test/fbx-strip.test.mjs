// Tests for tools/strip-fbx-media.mjs. A small binary FBX is built in memory (both the 32 bit 7.4 and the 64 bit 7.5 record layouts), so no model files are needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripFbxMedia } from '../tools/strip-fbx-media.mjs';

const MAGIC_END = 'f85a8c6adef5d97eece90ce3758f290b', FOOT_ID = 'fabcab09d0c8d466b176fb831cf7267e', PNG_SIG = Buffer.from('89504e470d0a1a0a', 'hex');
const S = (s) => { const b = Buffer.from(s, 'latin1'), h = Buffer.alloc(5); h[0] = 0x53; h.writeUInt32LE(b.length, 1); return Buffer.concat([h, b]); }; // a string property
const R = (b) => { const h = Buffer.alloc(5); h[0] = 0x52; h.writeUInt32LE(b.length, 1); return Buffer.concat([h, b]); }; // a raw property
const node = (name, props = [], kids = null) => ({ name, props, kids });

function fbx(nodes, ver = 7500) {
  const w = ver >= 7500 ? 8 : 4, hdr = 3 * w + 1, put = (b, p, v) => (w === 8 ? b.writeBigUInt64LE(BigInt(v), p) : b.writeUInt32LE(v, p));
  function emit(n, pos) {
    const name = Buffer.from(n.name, 'latin1'), pb = Buffer.concat(n.props); let p = pos + hdr + name.length + pb.length; const kb = [];
    if (n.kids) { for (const k of n.kids) { const b = emit(k, p); kb.push(b); p += b.length; } kb.push(Buffer.alloc(hdr)); p += hdr; }
    const head = Buffer.alloc(hdr); put(head, 0, p); put(head, w, n.props.length); put(head, 2 * w, pb.length); head[3 * w] = name.length;
    return Buffer.concat([head, name, pb, ...kb]);
  }
  const head = Buffer.alloc(27); head.write('Kaydara FBX Binary  \0', 0, 'latin1'); head[21] = 0x1a; head.writeUInt32LE(ver, 23);
  const parts = [head]; let pos = 27;
  for (const n of nodes) { const b = emit(n, pos); parts.push(b); pos += b.length; }
  parts.push(Buffer.alloc(hdr)); pos += hdr;
  const pad = (16 - (pos % 16)) % 16, v = Buffer.alloc(4); v.writeUInt32LE(ver);
  parts.push(Buffer.from(FOOT_ID, 'hex'), Buffer.alloc(pad + 4), v, Buffer.alloc(120), Buffer.from(MAGIC_END, 'hex'));
  return Buffer.concat(parts);
}
const scene = () => [
  node('FBXHeaderExtension', [], [node('Creator', [S('test')])]),
  node('Objects', [], [
    node('Video', [S('tex')], [node('Type', [S('Clip')]), node('Content', [R(Buffer.alloc(20000, 0xab))])]), // an embedded image
    node('Geometry', [S('g')], [node('Content', [R(Buffer.alloc(20000, 0xcd))])]), // a Content property that is not an image: it must stay
  ]),
];

for (const ver of [7400, 7500]) {
  test(`strip ${ver}: the embedded image becomes a 1 x 1 PNG, everything else is kept`, () => {
    const src = fbx(scene(), ver), out = stripFbxMedia(src);
    assert.ok(out.length < src.length - 19000, `${src.length} -> ${out.length}`);
    assert.ok(!out.includes(Buffer.alloc(1000, 0xab)), 'the image bytes are gone');
    assert.ok(out.includes(PNG_SIG), 'a PNG stands in its place');
    assert.ok(out.includes(Buffer.alloc(20000, 0xcd)), 'a Content property outside a Video node is left alone');
    assert.ok(out.includes(Buffer.from('FBXHeaderExtension')) && out.includes(Buffer.from('Creator')), 'other nodes survive');
  });

  test(`strip ${ver}: the result is a well-formed FBX again (offsets, footer, alignment), and a second pass has nothing to do`, () => {
    const out = stripFbxMedia(fbx(scene(), ver));
    assert.equal(out.length % 16, 0, 'the file ends 16-aligned, as exporters write it');
    assert.equal(out.subarray(out.length - 16).toString('hex'), MAGIC_END, 'the closing magic is last');
    assert.ok(out.includes(Buffer.from(FOOT_ID, 'hex')), 'the footer id is kept');
    assert.equal(stripFbxMedia(out), out, 'parses cleanly (every end offset lands on a record) and finds no image left');
  });
}

test('strip: a file without embedded images comes back untouched (the same buffer)', () => {
  const src = fbx([node('A', [S('x')], [node('B', [R(Buffer.alloc(9000, 1))])])]);
  assert.equal(stripFbxMedia(src), src);
});

test('strip: refuses what is not a binary FBX', () => {
  assert.throws(() => stripFbxMedia(Buffer.from('not an fbx at all, just text')), /not a binary FBX/);
});

const SURVIVOR = new URL('../assets/models/game/survivor.fbx', import.meta.url);
test('survivor.fbx in the repo carries no embedded full-size images (it is the download that matters)', { skip: fs.existsSync(SURVIVOR) ? false : 'assets/models/game/survivor.fbx not present' }, () => {
  const b = fs.readFileSync(SURVIVOR);
  assert.ok(b.length < 4 * 1048576, `${(b.length / 1048576).toFixed(1)} MB: run node tools/strip-fbx-media.mjs on it`);
  assert.equal(stripFbxMedia(b), b, 'nothing left to strip');
});
