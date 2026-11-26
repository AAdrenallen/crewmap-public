// Shrinks the Blender GLBs in place: dedup accessors/materials, weld identical vertices, then quantize vertex data
// (KHR_mesh_quantization: int16 positions, int8 normals) after dropping unused UVs (and, in avatar.glb, normals the app
// recomputes). three.js GLTFLoader reads quantized meshes natively, so
// there is no decoder at runtime (Draco/meshopt would need WebAssembly, which Hermes lacks). No `prune`: the
// runtime looks nodes up by name, including empty pivots (legL/armR/...) and vehicle roots.
//   node tools/blender/optimize.mjs apps/mobile/assets/models [avatar.glb|cars.glb]
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, quantize, weld } from '@gltf-transform/functions';

const dir = process.argv[2] ?? 'apps/mobile/assets/models';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const name of process.argv[3] ? [process.argv[3]] : ['avatar.glb', 'cars.glb']) {
  const path = join(dir, name);
  const before = statSync(path).size;
  const doc = await io.read(path);
  const ids = () => JSON.stringify([doc.getRoot().listNodes(), doc.getRoot().listMaterials()].map((l) => l.map((x) => x.getName()).sort()));
  const names = ids();
  // The kit is untextured: UVs are dead weight.
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) for (const sem of prim.listSemantics()) if (sem.startsWith('TEXCOORD_')) prim.setAttribute(sem, null);
  await doc.transform(dedup({ keepUniqueNames: true }), weld());
  // Avatar: drop normals that a smooth recompute reproduces (kit.ts recomputes them once per loaded kit); hard-edged
  // meshes (bevelled boxes, pixel shades) keep theirs.
  if (name === 'avatar.glb') {
    let dropped = 0;
    for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) if (smoothNormals(prim)) (prim.setAttribute('NORMAL', null), dropped++);
    await doc.transform(weld());
    console.log(`${name}: normals recomputed at load for ${dropped} primitives`);
  }
  await doc.transform(quantize({ quantizePosition: 14, quantizeNormal: 8 }));
  // the runtime finds nodes (variants, pivots, rides) and materials (recolour, glass) by name
  if (ids() !== names) throw new Error(`${name}: node or material names changed`);
  await io.write(path, doc);
  console.log(`${name}: ${before} -> ${statSync(path).size} bytes`);
}

/** Whether the primitive's normals match area-weighted smooth vertex normals (three.js computeVertexNormals). */
function smoothNormals(prim) {
  const pos = prim.getAttribute('POSITION');
  const nrm = prim.getAttribute('NORMAL');
  const idx = prim.getIndices();
  if (!pos || !nrm || !idx || prim.getMode() !== 4) return false;
  const P = pos.getArray(), N = nrm.getArray(), I = idx.getArray();
  const acc = new Float64Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const [a, b, c] = [I[t] * 3, I[t + 1] * 3, I[t + 2] * 3];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) (acc[k] += nx, acc[k + 1] += ny, acc[k + 2] += nz);
  }
  for (let k = 0; k < P.length; k += 3) {
    const l = Math.hypot(acc[k], acc[k + 1], acc[k + 2]);
    const m = Math.hypot(N[k], N[k + 1], N[k + 2]);
    if (l < 1e-12 || m < 1e-6) continue;
    if ((acc[k] * N[k] + acc[k + 1] * N[k + 1] + acc[k + 2] * N[k + 2]) / (l * m) < 0.94) return false;
  }
  return true;
}
