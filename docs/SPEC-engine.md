# Caelancraft — Engine Notes (reference; `src/CONTRACTS.md` is normative)

## Three.js 0.186 facts (verified against the r186 sources)

1. Imports: `import * as THREE from 'three'`; addons via `three/addons/<path>` (the package `exports` map points `./addons/*` → `./examples/jsm/*`). Pure ESM.
2. Colour management is on by default; `renderer.outputColorSpace` defaults to `SRGBColorSpace` — do not set it.
   **`Texture.colorSpace` defaults to `NoColorSpace`** → the atlas MUST set `texture.colorSpace = THREE.SRGBColorSpace` or colours wash out.
3. **`Color.setRGB(r,g,b)` interprets the values as LINEAR** (working space) by default; `setHex`/`setStyle` assume sRGB.
   For spec colours given as sRGB floats use `color.setRGB(r, g, b, THREE.SRGBColorSpace)`.
4. Lights are physical-only: `useLegacyLights` / `physicallyCorrectLights` no longer exist. A legacy intensity of 1 ≈ π now.
   Start with DirectionalLight ≈ 2 at noon and HemisphereLight ≈ 1.4 (values come from `computeSky`).
5. Texture defaults: `flipY = true`, `generateMipmaps = true`, `minFilter = LinearMipmapLinearFilter`, `magFilter = LinearFilter`.
   The atlas sets `NearestFilter` for both, `generateMipmaps = false`, `flipY = false`, `wrapS = wrapT = ClampToEdgeWrapping`.
6. `MeshLambertMaterial` inherits `vertexColors`, `alphaTest`, `transparent`, `opacity`, `side`, `depthWrite` from `Material`
   (all accepted in the constructor object); `fog: true` by default so `scene.fog` applies.
7. `PointerLockControls` (not used; we have custom controls): `getObject()` is gone → `controls.object`.
8. **`Object3D.dispose()` (new in r186) only dispatches an event** — it does not free geometry or materials.
   Call `geometry.dispose()` yourself on chunk unload; never dispose the three shared materials or the atlas texture.
9. `THREE.Clock` is deprecated (r183) — use the `requestAnimationFrame` timestamp.
10. With `matrixAutoUpdate = false`, call `mesh.updateMatrix()` after setting the position.
11. WebGL 1 is unsupported since r163 → WebGL2 is guaranteed → `Uint32Array` indices are always fine
    (`geometry.setIndex(new THREE.BufferAttribute(indices, 1))`).
12. `WebGLRenderer` constructor keys used here: `canvas, antialias, powerPreference`.
13. `Sprite`, `Points`, `ShaderMaterial`, `SphereGeometry`, `EdgesGeometry`, `LineSegments`, `Fog`, `HemisphereLight`,
    `DirectionalLight`, `PerspectiveCamera`, `CanvasTexture`, `BufferGeometry`, `BufferAttribute` are all unchanged.

## Rendering design

- Three shared materials: opaque, cutout (`alphaTest 0.5`, `DoubleSide`), translucent (`transparent`, `depthWrite false`, `DoubleSide`, `renderOrder 1`).
- One `Mesh` per non-empty layer per chunk. Chunk-local positions; `mesh.position = (cx*16, 0, cz*16)`.
- Vertex colours carry face shade × ambient occlusion (`FACE_SHADE`, `AO_CURVE`); lights multiply on top.
- Sky: gradient dome (`SphereGeometry(500, 16, 8)`, `BackSide`, custom `ShaderMaterial` with `uZenith`/`uHorizon`, `depthWrite false`,
  `fog false`, `renderOrder -3`) that follows the camera. Optional sun/moon `Sprite`s (`depthTest false`, `fog false`, scale ~60 at
  `camera + dir*400`) and 600 star `Points` (`sizeAttenuation false`, opacity from `sky.stars`).
- Fog: `THREE.Fog(fogColor, far*0.55, far)` with `far = (renderDistance - 0.5) * 16`; underwater `near 1, far 22, colour #204A8C`.
- Block highlight: `LineSegments(EdgesGeometry(BoxGeometry(1.002,1.002,1.002)), LineBasicMaterial({color: 0x000000, transparent: true, opacity: 0.4}))`.

## Performance budget

- Expected ~1.5–3k triangles per surface chunk (forest/cave chunks 4–6k). RD 7 → 225 meshed chunks ≈ 0.5–1 M triangles,
  ≤ 675 meshes, roughly half frustum-culled. Integrated GPUs may prefer RD 5–6 (`?rd=`).
- Memory: 32 KB per chunk of block data × 289 loaded ≈ 9 MB; the mesher reuses one padded scratch buffer.
- Knobs (all in `config.js`): `RENDER_DISTANCE`, `BUILD_BUDGET_MS`, `MAX_BUILDS_PER_UPDATE`, `MAX_PIXEL_RATIO`, `FOV`.
- If frames are slow: check `getStats().drawCalls` (> 700 → lower RD); GPU-bound → `MAX_PIXEL_RATIO = 1`; update spikes →
  lower `BUILD_BUDGET_MS`. Web Workers are deliberately out of scope for v1 (both `generateChunk` and `buildChunkMesh` are pure
  functions over typed arrays, so a worker wrapper is a mechanical v2 change).
