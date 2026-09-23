# Caelancraft — Build, Test and Verification Plan

> Authoritative for: toolchain, gates, unit-test expectations, smoke test, review process.
> Where this document pins a *code-level convention* that `src/CONTRACTS.md` also pins, `src/CONTRACTS.md` wins.

## 0. Environment facts (verified 2026-09-21)

| Item | Result |
|---|---|
| OS | Ubuntu 24.04.3 LTS on WSL2 (NAT networking), 14 CPUs |
| Node / npm | v24.15.0 / 11.12.1 — satisfies vite 8, vitest 5 |
| Toolchain | three 0.186.0 (ESM, `three/addons/*` resolves via exports map), vite 8.3 (Rolldown; no `rollupOptions`), vitest 5 (default env `node`, artifacts in `.vitest/`) |
| Linux browsers | none; `libnss3`/`libnspr4`/`libasound2` missing; no sudo; downloading .debs was **declined** → Playwright/puppeteer on Linux are OUT |
| Windows browsers via interop | `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe` (Chrome 152) and Edge. Headless run from WSL2 gives **GPU-backed WebGL2** (ANGLE D3D11). `--screenshot="C:\\Users\\Public\\x.png"` → readable at `/mnt/c/Users/Public/x.png`. `--dump-dom` prints the DOM. Windows reaches WSL2 servers at `http://localhost:<port>`. |

## 1. Scaffolding

Layout:
```
Caelancraft/
├── index.html  vite.config.js  eslint.config.js  jsconfig.json  package.json  README.md
├── docs/  SPEC-gameplay.md  SPEC-engine.md  PLAN-build.md
├── scripts/ smoke-windows-chrome.sh
├── src/  CONTRACTS.md  styles.css  <modules per CONTRACTS.md>
└── tests/ unit/<module>.test.js  integration/harness.test.js  helpers/fixtures.js
```
Scripts: `dev` (vite --host), `build`, `preview`, `test` (vitest run), `test:watch`, `lint` (eslint src tests), `typecheck` (tsc -p jsconfig.json, JSDoc checkJs, advisory), `check` (lint + test + build), `smoke:win` (scripts/smoke-windows-chrome.sh).

No jsdom/happy-dom: unit + integration tests never touch the DOM. `tests/e2e` does not exist (no Linux browser).

## 2. Unit test plan (Vitest, environment node)

Conventions: `import { describe, it, expect } from 'vitest'`; import constants from `src/config.js`; deterministic seeded PRNG only. Fixtures in `tests/helpers/fixtures.js`:
- `makeIsSolidAt(setOfKeys)` → `(x,y,z) => set.has(`${x},${y},${z}`)`
- `makeVoxelGetter(map, default=AIR)` → `getBlock(x,y,z)` over world coords
- `flatWorld(groundY)` → `isSolidAt = (x,y,z) => y <= groundY`

### 2.1 config.test.js
`CHUNK_SIZE === 16`; `WORLD_HEIGHT` power of two in [64,256]; `SEA_LEVEL < WORLD_HEIGHT-20`; `RENDER_DISTANCE` in [2,12]; `GRAVITY > 0`; jump height `JUMP_SPEED²/(2·GRAVITY)` in [1.2,1.6]; `PLAYER_WIDTH < 1`; `PLAYER_HEIGHT` in [1.6,1.9]; `EYE_HEIGHT < PLAYER_HEIGHT`; `REACH` in [4,8]; `MAX_DT ≤ 0.1`.

### 2.2 noise.test.js
1. RNG determinism: same seed → identical first 1000 outputs in [0,1), mean 0.5±0.03; different seed differs in ≥990/1000.
2. Noise seed determinism over a 100×100 grid at step 0.37; different seed differs in ≥90%.
3. Range over 10k samples: min ≥ −1, max ≤ 1, min < −0.5, max > 0.5, |mean| < 0.05.
4. Continuity: |n(x+1e-4,y) − n(x,y)| < 1e-2 for 1000 random points.
5. Not symmetric garbage: n(x,y) ≠ n(y,x) for ≥50% of samples.
6. 3D noise: same range/continuity/determinism.
7. fBm: octaves 1 equals base within 1e-12; octaves 5 in [−1,1]; octaves 5 has more high-frequency energy than octaves 1.
8. Purity: `vi.spyOn(Math,'random')` → 0 calls during sampling.

### 2.3 chunk.test.js
1. Index bijection over 16×H×16 → Set size = volume; min 0, max volume−1.
2. Index order pinned by CONTRACTS.md (test asserts the three unit strides).
3. Roundtrip set/get; other cells untouched; `set` returns true iff changed.
4. Out of range get → 0; out of range set → false and no change.
5. `data instanceof Uint8Array`, length = volume.
6. Fresh chunk flags per contract.

### 2.4 worldgen.test.js
1. Determinism: same (seed,cx,cz) → identical data; different seed or chunk differs.
2. Bedrock at y=0 in all 256 columns.
3. Topmost solid in every column ≤ H−8 over 9 chunks.
4. Every column has solid ground; topmost non-air is WATER only if y ≤ SEA_LEVEL.
5. WATER ⇒ y ≤ SEA_LEVEL; some chunk in a 5×5 scan contains water.
6. Surface layering: GRASS_BLOCK has DIRT below; no GRASS_BLOCK directly under WATER.
7. Trees: each trunk top has ≥4 LEAVES within Chebyshev 2 / y∈[−1,+2]; each LOG is rooted within 8 blocks; no LOG at y ≤ SEA_LEVEL.
8. Cross-chunk decoration consistency: generate a 3×3 block of chunks into a merged 48×H×48 array; no canopy truncated at a chunk boundary (compare to the same tree seen from the neighbour chunk).
9. Ores over 16 chunks: COAL in [128, 6400]; IRON ≤ COAL; DIAMOND > 0 and all y < 16; every ore adjacent to STONE.
10. Caves: underground AIR (4 < y < SEA_LEVEL−10) > 0 and < 40% of that volume.
11. `getHeight(seed,x,z)` equals topmost terrain (excluding trees) for 50 random columns.
12. Perf guard: 9 chunks < 2000 ms.

### 2.5 world.test.js (inject a trivial generator)
1. `worldToChunk(-1,-17) → {cx:-1, cz:-2, lx:15, lz:15}`; `(0,0)`, `(16,15)`, `(-16,-16)`, `(-17,31)` cases.
2. setBlock/getBlock roundtrip at negative coords; neighbours unaffected.
3. Chunk ownership: the (−1,−2) chunk's local (15,10,15) holds the block.
4. getBlock in unloaded area → AIR and does NOT allocate a chunk.
5. setBlock in unloaded area → false, no allocation.
6. Dirty tracking: interior edit → exactly one dirty chunk once; edge edit at lx=0 → also (−1,0); corner (15,·,15) → (0,0),(1,0),(0,1),(1,1); never a vertical "neighbour".
7. No-op set returns false and marks nothing.
8. y out of [0,H) → set false, get AIR.
9. Load ring radius 3 → 49 chunks; moving far unloads with `onUnload` called exactly once per removed chunk.
10. Repeated `updateLoadedArea` at same position → no new loads.
11. Edits survive unload → reload (delta re-application).
12. Cross-border getter feeds the mesher (STONE at (16,10,0) suppresses +X face of STONE at (15,10,0)).

### 2.6 mesher.test.js
1. Lone solid at (5,5,5) → 6 faces: 24 verts, 36 indices, 48 uvs, 24 colours×3 (or ao).
2. Two adjacent solids → 10 faces.
3. 3×3×3 STONE cube → 54 faces.
4. Empty chunk → zero-length arrays, no throw.
5. Full chunk of STONE with empty neighbours → face count per contract (below-world treatment pinned); indices are `Uint32Array` (checkerboard chunk > 65535 vertices).
6. Water: WATER with AIR above → transparent geometry has a +Y face at y+WATER_SURFACE (0.875); opaque geometry empty; WATER–WATER no face; STONE gets a face toward WATER; WATER emits faces only toward AIR (and non-water transparents per contract).
7. Glass: GLASS–GLASS culled (10 faces for two); STONE gets a face toward GLASS.
8. Leaves: LEAVES–LEAVES not culled (12 faces for two).
9. UVs in [0,1], inside the block's tile rect inset by UV_EPS; GRASS_BLOCK top/side/bottom tiles differ.
10. Indices valid: max < vertexCount; length = faces×6; each face's 6 indices reference exactly 4 distinct vertices.
11. Winding CCW outward: for every triangle, cross(b−a,c−a)·normal > 0, normal points from block centre outward.
12. Normals are unit axis vectors, constant per face.
13. AO: values in the contract's discrete set; lone block all fully lit; a neighbour above-and-beside darkens exactly 2 of the 4 top-face vertices; WATER never occludes.
14. Positions in the contract's space (chunk-local + origin) — pinned.
15. Border culling uses neighbour chunk data via `getBlock`.
16. Determinism; `getBlock` only called within a 1-block halo.
17. Perf guard: real worldgen chunk meshes in < 50 ms median.

### 2.7 raycast.test.js
1. Origin (0.5,0.5,0.5), dir +X, STONE at (3,0,0) → block [3,0,0], normal [−1,0,0], distance 2.5, adjacent [2,0,0].
2. maxDist 2 → null; 2.5±1e-6 boundary behaviour.
3. Empty world → null quickly (maxDist 1000 < 10 ms).
4. Negative dir (0,−1,0), STONE at (0,−3,0) → normal [0,1,0], distance 2.5.
5. Exact diagonal tie → hits (2,0,1) or (1,0,2) per contract tie-break (x first), never (2,0,2).
6. Off-grid diagonal: origin (0.2,0.5,0.7), dir norm(1,0,0.5), STONE at (2,0,1) → hit with normal [−1,0,0].
7. Starting inside a targetable block → null.
8. `isTargetable` filter: passes through WATER to STONE behind it.
9. Unnormalised dir normalised internally; zero dir → null.
10. All six face normals correct (six placements).
11. Negative-coordinate flooring: origin (−0.5,0.5,0.5), dir −X, STONE at (−3,0,0) → distance 1.5.

### 2.8 player.test.js (pure physics step)
1. Falls onto flatWorld(4) from y=10 → lands at exactly y=5 (`toBe`), vel.y 0, onGround; stays exactly 5.
2. Never penetrates ground during fall.
3. Terminal velocity respected after 5 s.
4. Walk into wall at x=3 → x stops at exactly 3 − width/2, vel.x 0, no z push.
5. Wall slide: diagonal into wall → x clamps, z keeps increasing.
6. No tunnelling with dt = 0.5 through a 1-block floor and a 1-block wall (sub-stepping).
7. Jump height in [1.2,1.6]; no double jump mid-air.
8. Ceiling: head stops below y=7, no sticking.
9. Fly: no gravity drift; up moves at FLY speed; still collides with walls.
10. Swimming: fall speed capped in liquid; jump held → rises.
11. Horizontal speeds walk/sprint/sneak within 5% after 2 s; stops within 0.5 s.
12. Yaw mapping pinned by contract (yaw 0 → forward is −Z).
13. dt clamp: dt 5.0 → no NaN/explosion; NaN in state sanitised.
14. `isSolidAt` only called with integer args within bounds.
15. `findSpawn` returns standing position.

### 2.9 blocks.test.js
1. AIR is 0; ids contiguous 0..N−1; N ≤ 256.
2. Names unique snake_case; `BLOCK[NAME] === id`.
3. Every non-air block resolves 6 face tiles to valid tile indices.
4. Flag consistency: opaque ⇒ solid; liquid ⇒ !solid; WATER !solid transparent liquid; GLASS solid transparent cullSame; OAK_LEAVES solid transparent !cullSame.
5. BEDROCK !breakable !placeable; WATER placeable; all others placeable.
6. DEFAULT_HOTBAR 9 placeable unique ids; PICKER_ORDER all placeable, unique.
7. `tileToUV(tile)` → [u0,v0,u1,v1] in [0,1], non-overlapping across tiles, v orientation pinned (flipY=false → v0 is tile-image top).

### 2.10 storage.test.js (pure serialise/deserialise)
1. Roundtrip 1000 random edits + meta.
2. Size: empty < 200 chars; 1000 edits < 25 KB.
3. Last-write-wins preserved.
4. Version field; unknown version → null; garbage → null; ids > 255 dropped.
5. Negative coords roundtrip; y out of range dropped.
6. Deterministic output.
7. Storage wrapper tested only in integration with a Map-backed fake.

### 2.11 daynight.test.js
Noon sun up & max intensity; midnight sun below horizon, ambient ≥ minimum (never black); continuity; wrap f(0)=f(1); colours in [0,1]; `advanceTime` wraps.

### 2.12 integration/harness.test.js (node, no Three)
Drive world+worldgen+mesher+raycast+player+storage+daynight with a stub renderer for 300 ticks: 49 chunks at rd 3; player lands and stays; dirty set drains; look-down raycast hits at ≈EYE_HEIGHT; break → remesh → place → verify; walk across a border → loads/unloads with no orphan meshes; save/load roundtrip; no NaN over a day; < 10 s total.

## 3. Browser smoke test — decision

**Primary: Windows Chrome headless via WSL interop** driving the in-page `?smoke=1` self-test. `scripts/smoke-windows-chrome.sh` builds, starts `vite preview`, then:
```
chrome.exe --headless=new --window-size=1280,720 --virtual-time-budget=20000 --enable-logging=stderr --v=0 \
  --no-first-run --screenshot="C:\Users\Public\caelancraft-smoke.png" \
  "http://localhost:4173/?seed=1&rd=3&smoke=1&nosave=1&autoplay=1"
```
Pass: stderr contains `SMOKE_OK`; `/mnt/c/Users/Public/caelancraft-smoke.png` shows terrain + HUD when viewed. `--dump-dom` variant lets the orchestrator read `#smoke-result` text.

**Always:** human verification at `http://localhost:5173/?smoke=1` shows a green banner. The integration harness (§2.12) is the browser-free gate.

## 4. Runtime diagnostics (`src/diagnostics.js`)
- URL params: `seed`, `rd` (clamped 1..16), `smoke=1`, `autoplay=1`, `nosave=1`, `debug=1`, `fly=1`, `time=0..1`.
- `window.__caelancraft = { version, ready, seed, world, player, renderer, camera, scene, stats:{fps, frameMs, chunksLoaded, chunksDirty, meshesVisible, faces, drawCalls, triangles, geometries, textures}, getBlock, setBlock, teleport, setTime, errors:[], smoke:null }`.
- Error capture: `error` + `unhandledrejection` → `errors[]` and `#error-banner` (always shown for smoke/debug, and in DEV).
- `?smoke=1` sequence (~300 frames): wait grounded ≤120 frames; assert chunks/meshes/drawCalls > 0; look down, break, assert AIR + remesh; place hotbar block at adjacent, assert; spin 360°; walk 60 frames; fly up 30 frames; assert errors empty and WebGL2. Then `__caelancraft.smoke = {done:true, ok, ...}`, `console.log('SMOKE_OK'|'SMOKE_FAIL', json)`, write `#smoke-result` text and green/red banner.

## 5. Parallel implementation
Phase 0 (done by orchestrator): scaffold, `src/CONTRACTS.md`, `src/types.js`, stubs, fixtures.
Phase 1: one agent per module (see CONTRACTS.md ownership table); edit only owned files; `// CONTRACT-ISSUE:` comments for disagreements; run own tests + eslint to green; no `npm install`.
Phase 2: integration agent — audit ownership, resolve CONTRACT-ISSUEs, `npm run check`, build, smoke via Windows Chrome, read screenshot, fix.
Phase 3: adversarial review lenses (correctness/edges, performance/frame budget, UX-vs-spec, Three.js 0.186 API misuse, test quality) → independent refuter per finding → fix agent per confirmed finding → re-gate; loop until two clean rounds.

Acceptance checklist: `npm run check` green; title → Play → pointer lock; terrain with biomes/trees/water/ores; movement/jump/collision/swim/fly correct; break/place with highlight, no seams at borders; hotbar; day/night visible, never black; rd 6 ≥ 55 fps on the user's GPU; geometries bounded after walking 500 blocks; save/load persists; resize + tab-away safe; README works verbatim.

## 6. Three.js 0.186 rules for implementers
- `texture.colorSpace = SRGBColorSpace` on the atlas (mandatory or colours wash out); `renderer.outputColorSpace` default is sRGB.
- Physically-based light units (`useLegacyLights` no longer exists): DirectionalLight ~1.5–3, Hemisphere/Ambient ~0.3–1.4. `MeshLambertMaterial` is the cheap lit material.
- WebGL2 required (WebGL1 dropped in r163).
- `PointerLockControls.getObject()` removed → `controls.object`; we use a custom pointer-lock implementation anyway.
- Dispose `geometry` and shared materials carefully on chunk unload; call `geometry.computeBoundingSphere()` (or set bounds) so frustum culling works.
- `NearestFilter` + `generateMipmaps=false` on the atlas.

## 7. Gates
| Gate | Command | Pass |
|---|---|---|
| G0 | `npm run lint && npx vitest run && npm run build` on stubs | eslint silent, vitest green (todos), `vite build ✓` |
| G1 | per module: `npx vitest run tests/unit/<m>.test.js && npx eslint src/<m>.js` | green, only owned files touched |
| G2a | `npm run lint && npm test` | all unit + integration green < 60 s |
| G2b | `npm run build` | no `circular`/`Unresolved`/`is not exported` warnings; dist ≤ 2 MB |
| G2c | `npm run smoke:win` | `SMOKE_OK` in output; screenshot shows terrain + HUD |
| G3 | re-run G2a–G2c after each fix wave | two consecutive clean review rounds |
