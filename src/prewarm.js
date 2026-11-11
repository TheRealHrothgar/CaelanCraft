// Caelancraft — pay shader costs while the game loads (three). See src/CONTRACTS.md §72.
//
// A material's program is compiled the first time something drawn with it comes into view, which freezes the game for
// up to seconds on a slow GPU driver (KNOWN-ISSUES P1, P2). `compileHidden` asks the renderer to compile the programs of
// a set of objects now: each is made visible for the call (three collects the programs from visible objects, synchronously,
// keyed by the object — instanced or not, with instance colours or not — and by the scene's lights and fog), then put back
// exactly as it was. Nothing is drawn.
/**
 * @param {ReadonlyArray<*>} objects   meshes, lines or groups already in `scene`
 * @param {*} webgl                    the THREE.WebGLRenderer (or a fake); needs compileAsync or compile
 * @param {*} camera
 * @param {*} scene
 * @returns {Promise<void>} resolves when the programs are ready (at once without compileAsync); never rejects
 */
export function compileHidden(objects, webgl, camera, scene) {
  /** @type {{ o: *, visible: boolean, count: number|undefined }[]} */
  const saved = [];
  const show = (o) => {
    saved.push({ o, visible: o.visible, count: o.isInstancedMesh ? o.count : undefined });
    o.visible = true;
    if (o.isInstancedMesh && o.count === 0) o.count = 1;
  };
  for (const root of objects) {
    if (!root) continue;
    show(root);
    if (typeof root.traverse === 'function') root.traverse((o) => { if (o !== root) show(o); });
  }
  let done = Promise.resolve();
  try {
    if (webgl && typeof webgl.compileAsync === 'function') {
      done = Promise.all(objects.filter(Boolean).map((o) => webgl.compileAsync(o, camera, scene))).then(() => {}, () => {});
    } else if (webgl && typeof webgl.compile === 'function') {
      for (const o of objects) if (o) webgl.compile(o, camera, scene);
    }
  } catch {
    // A failed compile only brings back the one-off compile on first use.
  }
  for (const s of saved) {
    s.o.visible = s.visible;
    if (s.count !== undefined) s.o.count = s.count;
  }
  return done;
}
