// strip-fbx-media.mjs: shrinks a binary FBX by replacing the images embedded in it with a 1 x 1 PNG.
//   node tools/strip-fbx-media.mjs model.fbx [more.fbx ...]     rewrites the files in place
//   stripFbxMedia(buffer) -> Buffer                              the same, on a Buffer (prep-assets.mjs uses it)
// Some exporters embed the full-size textures in the FBX (Video nodes, their Content property). The game takes its textures from the separate, resized
// files next to the model (models.js), so the embedded copies are pure download weight: survivor.fbx was 13.4 MB, 10.9 MB of it three 2048 px PNGs.
// A 1 x 1 PNG stays in their place, not an empty property, so FBXLoader still decodes an image and does not go looking for the original file name.
// The file is parsed into its node records and written back with fresh offsets; every other byte is copied as it was. Binary FBX 7.4 (32 bit offsets) and 7.5 (64 bit).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MAGIC = 'Kaydara FBX Binary  \0', HEAD = 27, FOOT_FIXED = 160, MIN_IMAGE = 4096; // the fixed part of the footer: id 16 + 4 zeros + (padding) + version 4 + 120 zeros + magic 16 = 160 + padding

export function stripFbxMedia(buf) {
  if (buf.toString('latin1', 0, MAGIC.length) !== MAGIC) throw new Error('not a binary FBX');
  const ver = buf.readUInt32LE(23), w = ver >= 7500 ? 8 : 4, hdr = 3 * w + 1;
  const rd = (p) => (w === 8 ? Number(buf.readBigUInt64LE(p)) : buf.readUInt32LE(p));
  const wr = (b, p, v) => (w === 8 ? b.writeBigUInt64LE(BigInt(v), p) : b.writeUInt32LE(v, p));

  // one node record -> { name, nProps, props: Buffer (the property list, as it was), kids: [] | null }; null for the record that closes a list
  function node(at) {
    const end = rd(at), nProps = rd(at + w), propLen = rd(at + 2 * w), nameLen = buf[at + 3 * w];
    if (end === 0) return null;
    const name = buf.toString('latin1', at + hdr, at + hdr + nameLen), p0 = at + hdr + nameLen, p1 = p0 + propLen;
    const n = { name, nProps, props: buf.subarray(p0, p1), kids: null };
    if (p1 < end) n.kids = list(p1, end);
    return n;
  }
  function list(from, end) { // the nodes up to the closing null record, which lies just before `end`
    const out = []; let at = from;
    for (;;) { const n = node(at); if (!n) return out; out.push(n); at = rd(at); if (at >= end) return out; }
  }
  const top = []; let at = HEAD;
  for (;;) { const n = node(at); if (!n) break; top.push(n); at = rd(at); }
  const tail = buf.subarray(at + hdr); // what follows the closing null record is the footer
  if (tail.length < FOOT_FIXED) throw new Error('FBX footer not found');

  let saved = 0;
  const swap = (n, parent) => { // Video > Content holding one raw ('R') property: the embedded image
    if (parent === 'Video' && n.name === 'Content' && n.nProps === 1 && n.props[0] === 0x52 && n.props.length > MIN_IMAGE) {
      const p = Buffer.alloc(5 + PNG_1X1.length); p[0] = 0x52; p.writeUInt32LE(PNG_1X1.length, 1); PNG_1X1.copy(p, 5);
      saved += n.props.length - p.length; n.props = p;
    }
    if (n.kids) for (const k of n.kids) swap(k, n.name);
  };
  for (const n of top) swap(n, '');
  if (!saved) return buf;

  function emit(n, pos) { // a node record at file offset `pos`, with offsets that fit where it now lies
    const name = Buffer.from(n.name, 'latin1'); let p = pos + hdr + name.length + n.props.length; const kids = [];
    if (n.kids) { for (const k of n.kids) { const b = emit(k, p); kids.push(b); p += b.length; } kids.push(Buffer.alloc(hdr)); p += hdr; }
    const head = Buffer.alloc(hdr); wr(head, 0, p); wr(head, w, n.nProps); wr(head, 2 * w, n.props.length); head[3 * w] = name.length;
    return Buffer.concat([head, name, n.props, ...kids]);
  }
  const parts = [buf.subarray(0, HEAD)]; let pos = HEAD;
  for (const n of top) { const b = emit(n, pos); parts.push(b); pos += b.length; }
  parts.push(Buffer.alloc(hdr)); pos += hdr;
  const pad = (16 - (pos % 16)) % 16; // the footer keeps its id, its version and its closing magic; only the padding after the id follows the new position (the file ends 16-aligned, as the original does)
  parts.push(tail.subarray(0, 16), Buffer.alloc(4 + pad), tail.subarray(tail.length - 140));
  return Buffer.concat(parts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const f of process.argv.slice(2)) {
    const a = fs.readFileSync(f), b = stripFbxMedia(a);
    if (b !== a) fs.writeFileSync(f, b);
    console.log(`${f}: ${(a.length / 1048576).toFixed(1)} MB -> ${(b.length / 1048576).toFixed(1)} MB`);
  }
}
