// Caelancraft — light in the shaders (three). See src/CONTRACTS.md §62.
//
// Two patches of three's lit materials share one fragment change. The SUN / MOON (DirectionalLight) and SKY
// (HemisphereLight) contributions are multiplied by `caelSky`, the brightness curve of the cell's SKY level, and the
// cell's BLOCK level adds a warm irradiance (it goes through the material's diffuse term, so it is × the texture albedo
// and the vertex colour) plus a small floor where the sky does not reach. Point lights (the campfires' pool, the flash)
// are untouched. The day/night cycle stays in the lights' intensities (computeSky, every frame) and in the
// `caelDaylight` uniform, so nothing is re-meshed when the time changes; at sky level 15 with no block light the result
// is exactly three's own (caelSky = 1, nothing added): the surface by day and by night looks as before.
//
// - Chunk materials (applyChunkLight): the levels come from the mesh's `caelLight` vertex attribute (mesher.js §62:
//   sky·17, block·17 as normalised Uint8), smoothed per vertex.
// - Everything else that is lit (installObjectLighting: a Material.prototype.onBeforeCompile hook, so mobs, falling
//   blocks, campfire models, circuit models and the Watcher need no change of their own): the levels are read per
//   VERTEX from a 3D texture of the light around the camera (R8, width WORLD_HEIGHT = y, height LIGHT_VOLUME_QR = r,
//   depth LIGHT_VOLUME_QR = q; one packed byte per cell) at the vertex's world position nudged 0.3 along its normal, or
//   0.5 above it when that is brighter (a mob's feet on the floor, a block resting on the ground). Outside the volume,
//   or before the renderer has a light field, everything reads open sky (today's look).
import * as THREE from 'three';
import {
  WORLD_HEIGHT, LIGHT_CURVE_K, LIGHT_FLOOR, BLOCK_LIGHT_COLOR, BLOCK_LIGHT_INTENSITY, BLOCK_LIGHT_DAY_WASH, LIGHT_VOLUME_QR,
} from './config.js';

/** Name of the chunk meshes' light attribute (2 × Uint8, normalised). */
export const LIGHT_ATTRIBUTE = 'caelLight';

/**
 * @typedef {Object} LightUniforms  Shared by every patched program (the same `{ value }` objects).
 * @property {{ value: number }} caelDaylight      SkyState.daylight 0..1 (washes block light out under the open sky by day)
 * @property {{ value: THREE.Color }} caelBlockColor  block light irradiance at level 15 (linear, × BLOCK_LIGHT_INTENSITY)
 * @property {{ value: number }} caelFloor         irradiance where no sky reaches
 * @property {{ value: number }} caelCurveK        LIGHT_CURVE_K
 * @property {{ value: number }} caelDayWash       BLOCK_LIGHT_DAY_WASH
 * @property {{ value: THREE.Data3DTexture }} caelVol  the light volume around the camera
 * @property {{ value: THREE.Vector4 }} caelVolInfo  (q0, r0, size, live 0|1)
 */

/** @type {LightUniforms|null} */
let shared = null;

/**
 * The light volume: its bytes, its texture and the uniforms every patched program reads (one set per page).
 * @returns {{ uniforms: LightUniforms, data: Uint8Array, texture: THREE.Data3DTexture, size: number }}
 */
export function lightVolume() {
  if (shared === null) {
    const size = LIGHT_VOLUME_QR;
    const data = new Uint8Array(size * size * WORLD_HEIGHT);
    const texture = new THREE.Data3DTexture(data, WORLD_HEIGHT, size, size);
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    const color = new THREE.Color().setRGB(BLOCK_LIGHT_COLOR[0], BLOCK_LIGHT_COLOR[1], BLOCK_LIGHT_COLOR[2], THREE.SRGBColorSpace)
      .multiplyScalar(BLOCK_LIGHT_INTENSITY);
    shared = {
      caelDaylight: { value: 1 },
      caelBlockColor: { value: color },
      caelFloor: { value: LIGHT_FLOOR },
      caelCurveK: { value: LIGHT_CURVE_K },
      caelDayWash: { value: BLOCK_LIGHT_DAY_WASH },
      caelVol: { value: texture },
      caelVolInfo: { value: new THREE.Vector4(0, 0, size, 0) },
    };
  }
  const texture = shared.caelVol.value;
  return { uniforms: shared, data: /** @type {Uint8Array} */ (texture.image.data), texture, size: LIGHT_VOLUME_QR };
}

/** Fragment declarations: the uniforms, the varying and the brightness curve (light.lightBrightness in GLSL). */
export const LIGHT_FRAGMENT_PARS = /* glsl */ `
uniform float caelDaylight;
uniform vec3 caelBlockColor;
uniform float caelFloor;
uniform float caelCurveK;
uniform float caelDayWash;
varying vec2 vCaelLight;
float caelCurve( float x ) {
	x = clamp( x, 0.0, 1.0 );
	return x / ( 1.0 + caelCurveK * ( 1.0 - x ) );
}
`;

/** Evaluated just before three's light accumulation. */
export const LIGHT_FRAGMENT_SETUP = /* glsl */ `
float caelSky = caelCurve( vCaelLight.x );
float caelBlock = caelCurve( vCaelLight.y ) * ( 1.0 - caelDayWash * caelDaylight * caelSky );
vec3 caelExtra = caelBlockColor * caelBlock + vec3( caelFloor * ( 1.0 - caelSky ) );
`;

/** The edits to three's lights_fragment_begin: [anchor, replacement, required]. */
const LIGHTS_BEGIN_EDITS = /** @type {const} */ ([
  ['getDirectionalLightInfo( directionalLight, directLight );',
    'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= caelSky;', true],
  ['getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight );\n\t\tdirectLight.color *= caelSky;', false],
  ['irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );',
    'irradiance += caelSky * getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );', true],
  ['vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );',
    'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor ) + caelExtra;', true],
]);

/** @type {string|null} */
let patchedBegin = null;

/**
 * three's lights_fragment_begin chunk with the sky factor on the directional and hemisphere lights and the block light /
 * floor added to the irradiance. Throws when three's chunk no longer has one of the required lines (an upgrade moved
 * them: tests/unit/light.test.js checks this against the installed three).
 * @param {string} [chunk]
 * @returns {string}
 */
export function patchLightsFragmentBegin(chunk = THREE.ShaderChunk.lights_fragment_begin) {
  if (chunk === THREE.ShaderChunk.lights_fragment_begin && patchedBegin !== null) return patchedBegin;
  let out = chunk;
  for (const [anchor, replacement, required] of LIGHTS_BEGIN_EDITS) {
    if (!out.includes(anchor)) {
      if (required) throw new Error(`lightShader: three's lights_fragment_begin has no "${anchor}"`);
      continue;
    }
    out = out.split(anchor).join(replacement);
  }
  if (chunk === THREE.ShaderChunk.lights_fragment_begin) patchedBegin = out;
  return out;
}

/** @param {{ fragmentShader: string }} shader */
function patchFragment(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${LIGHT_FRAGMENT_PARS}`)
    .replace('#include <lights_fragment_begin>', `${LIGHT_FRAGMENT_SETUP}\n${patchLightsFragmentBegin()}`);
}

/** @param {{ uniforms: Record<string, *> }} shader */
function addUniforms(shader) {
  Object.assign(shader.uniforms, lightVolume().uniforms);
}

/**
 * Patch a chunk material: its light comes from the `caelLight` vertex attribute.
 * @param {THREE.Material} material
 * @returns {THREE.Material}
 */
export function applyChunkLight(material) {
  material.onBeforeCompile = (shader) => {
    addUniforms(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 ${LIGHT_ATTRIBUTE};\nvarying vec2 vCaelLight;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvCaelLight = ${LIGHT_ATTRIBUTE};`);
    patchFragment(shader);
  };
  material.customProgramCacheKey = () => 'caelancraft-chunk-light';
  material.userData.caelLight = 'chunk';
  return material;
}

/** Vertex declarations of the object patch: the volume and its cell lookup (hex.worldToHex's cube rounding in GLSL). */
export const LIGHT_VOLUME_VERTEX_PARS = /* glsl */ `
uniform sampler3D caelVol;
uniform vec4 caelVolInfo;
varying vec2 vCaelLight;
vec2 caelVolumeLevels( vec3 p ) {
	if ( caelVolInfo.w < 0.5 ) return vec2( 1.0, 0.0 );
	float y = floor( p.y );
	if ( y >= ${WORLD_HEIGHT.toFixed(1)} ) return vec2( 1.0, 0.0 );
	if ( y < 0.0 ) return vec2( 0.0 );
	float rf = p.z * 1.1547005383792515;
	float qf = p.x - 0.5 * rf;
	float sf = - qf - rf;
	float rq = floor( qf + 0.5 );
	float rr = floor( rf + 0.5 );
	float rs = floor( sf + 0.5 );
	float dq = abs( rq - qf );
	float dr = abs( rr - rf );
	float ds = abs( rs - sf );
	if ( dq > dr && dq > ds ) rq = - rr - rs;
	else if ( dr > ds ) rr = - rq - rs;
	float tq = rq - caelVolInfo.x;
	float tr = rr - caelVolInfo.y;
	if ( tq < 0.0 || tr < 0.0 || tq >= caelVolInfo.z || tr >= caelVolInfo.z ) return vec2( 1.0, 0.0 );
	float v = floor( texelFetch( caelVol, ivec3( int( y ), int( tr ), int( tq ) ), 0 ).r * 255.0 + 0.5 );
	float sky = floor( v / 16.0 );
	return vec2( sky, v - sky * 16.0 ) / 15.0;
}
`;

/** After project_vertex: the vertex's world position and normal → vCaelLight. */
export const LIGHT_VOLUME_VERTEX_MAIN = /* glsl */ `
{
	vec4 caelP = vec4( transformed, 1.0 );
	vec3 caelN = objectNormal;
	#ifdef USE_BATCHING
		caelP = batchingMatrix * caelP;
		caelN = mat3( batchingMatrix ) * caelN;
	#endif
	#ifdef USE_INSTANCING
		caelP = instanceMatrix * caelP;
		caelN = mat3( instanceMatrix ) * caelN;
	#endif
	caelP = modelMatrix * caelP;
	caelN = mat3( modelMatrix ) * caelN;
	float caelNl = length( caelN );
	vec3 caelAt = caelP.xyz + ( caelNl > 1e-6 ? caelN * ( 0.3 / caelNl ) : vec3( 0.0 ) );
	vCaelLight = max( caelVolumeLevels( caelAt ), caelVolumeLevels( caelP.xyz + vec3( 0.0, 0.5, 0.0 ) ) );
}
`;

/** @returns {boolean} a material three lights (the ones whose shaders include lights_fragment_begin) */
export function isLitMaterial(m) {
  return !!m && !!(m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshStandardMaterial || m.isMeshToonMaterial);
}

/**
 * Patch the shader of a lit non-chunk material to read the light volume (what the prototype hook does).
 * @param {{ vertexShader: string, fragmentShader: string, uniforms: Record<string, *> }} shader
 */
export function patchObjectShader(shader) {
  addUniforms(shader);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${LIGHT_VOLUME_VERTEX_PARS}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${LIGHT_VOLUME_VERTEX_MAIN}`);
  patchFragment(shader);
}

let installed = false;

/**
 * Light every lit material that has no onBeforeCompile of its own from the light volume, by giving THREE.Material's
 * prototype one (idempotent). It runs whenever three builds a program, so materials made before or after this call,
 * prewarmed or not, are covered alike; a material with its own onBeforeCompile (the chunk materials, the campfire smoke)
 * keeps it.
 */
export function installObjectLighting() {
  if (installed) return;
  installed = true;
  const proto = THREE.Material.prototype;
  const original = proto.onBeforeCompile;
  proto.onBeforeCompile = function caelancraftObjectLight(shader, webgl) {
    original.call(this, shader, webgl);
    if (isLitMaterial(this)) patchObjectShader(/** @type {*} */ (shader));
  };
}
