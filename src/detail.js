// detail.js: high-frequency detail over a low-resolution scan texture, in the material itself (a TSL node material, WebGPU).
//   detailMaterial(src, layers) -> MeshStandardNodeMaterial
//     src:    the material to improve (its map, normalMap, roughness, metalness and normalScale are kept: the scan's own look and normal map)
//     layers: [{ map: Texture (tileable, RepeatWrapping, sRGB), meters: world size of one tile, strength: 0..1 }]
//   Each layer is sampled in WORLD space (no UV seams): from above (xz) wherever the surface is not steep (a 45 degree slope stretches it only 1.4x), and from
//   the sides (zy / xy, by the normal) only on faces steeper than about 65 degrees, so ground never shows the streaks of a plain triplanar blend; it is
//   multiplied onto the scan colour after
//   dividing by its own average colour, so it adds grain and contrast without shifting the scan's colours. Falls back to `src` if node materials are not there.
import * as THREE from 'three';
import { texture, uniform, vec2, vec3, vec4, float, mix, clamp, abs, pow, smoothstep, positionWorld, normalWorld } from 'three/tsl';

// The mean colour of a loaded texture, as a linear rgb triple (a 16 x 16 downscale is plenty for a tileable texture).
export function averageColour(tex) {
  const img = tex && tex.image;
  if (!img || typeof document === 'undefined') return [0.4, 0.4, 0.4];
  const cv = document.createElement('canvas'); cv.width = cv.height = 16;
  const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 16, 16);
  const d = g.getImageData(0, 0, 16, 16).data, sum = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += d[i + c] / 255;
  return sum.map((v) => Math.max(0.02, Math.pow(v / (d.length / 4), 2.2))); // sRGB -> roughly linear
}

export function detailMaterial(src, layers) {
  if (!THREE.MeshStandardNodeMaterial || !src.map) return src;
  const m = new THREE.MeshStandardNodeMaterial({ map: src.map, normalMap: src.normalMap, roughness: src.roughness ?? 0.95, metalness: src.metalness ?? 0, side: src.side });
  if (src.normalScale) m.normalScale.copy(src.normalScale);
  let colour = texture(src.map).rgb; // the scan's colour: colorNode replaces the material's own use of `map`
  for (const L of layers) {
    const avg = uniform(new THREE.Vector3(...averageColour(L.map)));
    const p = positionWorld.mul(1 / L.meters), n = abs(normalWorld), side = float(1).sub(smoothstep(0.3, 0.6, n.y)); // side: 0 on ground, 1 on a cliff face
    const wx = pow(n.x, float(4)), wz = pow(n.z, float(4)), wsum = wx.add(wz).add(0.0001);
    const top = texture(L.map, vec2(p.x, p.z)).rgb, faces = texture(L.map, vec2(p.z, p.y)).rgb.mul(wx).add(texture(L.map, vec2(p.x, p.y)).rgb.mul(wz)).div(wsum);
    const detail = mix(top, faces, side);
    colour = colour.mul(mix(vec3(1), clamp(detail.div(avg), 0.25, 3), L.strength));
  }
  m.colorNode = vec4(colour, 1);
  m.name = (src.name || 'detail') + '+detail';
  return m;
}
