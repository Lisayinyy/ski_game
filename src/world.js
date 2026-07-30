import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng, clamp, lerp, smoothstep } from './util.js';
import { CHUNK_LEN } from './terrain.js';

/* ------------------------------------------------------------------ helpers */

function paint(geo, rgb) {
  // mergeGeometries() needs identical attribute sets AND identical index-ness across inputs.
  // Polyhedron-based primitives (Icosahedron…) are non-indexed while Box/Cylinder/Cone are
  // indexed, so normalise everything to non-indexed and drop UVs.
  geo.deleteAttribute('uv');
  geo.deleteAttribute('uv1');
  geo.deleteAttribute('uv2');
  if (geo.index) geo = geo.toNonIndexed();
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = rgb[0];
    arr[i * 3 + 1] = rgb[1];
    arr[i * 3 + 2] = rgb[2];
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

const hexRgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

function place(geo, x, y, z, scale = 1, rotY = 0) {
  const m = new THREE.Matrix4()
    .makeRotationY(rotY)
    .premultiply(new THREE.Matrix4().makeScale(scale, scale, scale))
    .setPosition(x, y, z);
  return geo.clone().applyMatrix4(m);
}

/**
 * Deterministic 0..1 hash — lets gate placement be reproduced for the ideal-line spline
 * without replaying the per-chunk scenery RNG stream (trees/hazards stay untouched).
 */
function hash01(a, b = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * The three slalom gates for one chunk, as pure data (no meshes, no RNG-stream coupling).
 * Both the mesh builder and the ideal-line planner call this, so the glowing line always
 * threads exactly through the gates the player sees. Returns [] for chunks with no gates.
 */
function planChunkGates(resort, terrain, index, finishZ) {
  const zStart = -index * CHUNK_LEN;
  const out = [];
  let running = index * 3;
  for (let k = 0; k < 3; k++) {
    const z = zStart - 18 - k * 30 - hash01(resort.seed + index, k * 7 + 1) * 8;
    if (z > -40 || z < finishZ + 24) { running++; continue; }
    const cxg = terrain.centerX(z);
    const offset = (hash01(resort.seed + index * 5.0, k * 3 + 2) - 0.5) * terrain.pisteHalf * 0.95;
    out.push({ x: cxg + offset, z, blue: running % 2 === 0 });
    running++;
  }
  return out;
}

/** Render order of the furthest vista layer; has to sit between the sky and the terrain. */
const VISTA_ORDER = -18;

/** Exposure calibration for snow-white albedo — see `buildLights`. */
const HEMI_CAL = 0.42;
const SUN_CAL = 0.50;

/* --------------------------------------------------------- vista silhouettes */

/** Normalised ridge profile for each resort's signature summit, x in [-1, 1]. */
function peakProfile(kind, x) {
  const ax = Math.abs(x);
  switch (kind) {
    case 'horn': {
      // Matterhorn-ish: steep, asymmetric, hooked tip.
      const core = Math.max(0, 1 - Math.pow(ax * 1.35, 1.25));
      const hook = x < 0 ? 0.14 * Math.max(0, 1 - Math.abs(x + 0.06) * 9) : 0;
      const shoulder = 0.22 * Math.max(0, 1 - Math.abs(ax - 0.55) * 2.4);
      return core + hook + shoulder * 0.6;
    }
    case 'pyramid': {
      const core = Math.max(0, 1 - ax * 1.15);
      const shoulder = 0.3 * Math.max(0, 1 - Math.abs(ax - 0.62) * 2.0);
      return Math.pow(core, 1.05) + shoulder * 0.5;
    }
    case 'cone': {
      // Mt Yotei: near-perfect volcano. Straight-ish flanks, no crater notch — at 30 km
      // the crater is invisible, and the dip split the shaded face with a white sliver.
      return Math.max(0, 1 - Math.pow(ax * 1.02, 1.15));
    }
    case 'twin': {
      // Maroon Bells: two broad pyramids sharing a saddle — not a pair of needles.
      const a = Math.max(0, 1 - Math.abs(x + 0.3) * 1.55);
      const b = Math.max(0, 0.9 - Math.abs(x - 0.36) * 1.6);
      return Math.max(a, b) * 0.95 + 0.14 * Math.max(0, 1 - ax * 0.9);
    }
    case 'granite': {
      // A saw-toothed granite crest. The teeth were 3 degrees wide at 1.9 km, which read
      // as TV aerials; wider teeth on a solid massif read as rock.
      let h = Math.max(0, 0.8 - ax * 0.55);
      for (const t of [-0.62, -0.28, 0.05, 0.4, 0.72]) {
        h = Math.max(h, 0.92 - Math.abs(x - t) * 2.5 - Math.abs(t) * 0.22);
      }
      return Math.max(0, h);
    }
    default: {
      // Broad rounded dome.
      return Math.max(0, Math.cos(x * 1.35) * 0.82);
    }
  }
}

/* ------------------------------------------------------------------- props */

class PropLibrary {
  constructor(resort) {
    this.resort = resort;
    const pal = resort.palette;
    this.c = {
      trunk: hexRgb(0x54382c),
      birch: hexRgb(0xe8eef2),
      aspen: hexRgb(0xd9dcd0),
      foliage: hexRgb(pal.tree),
      snow: hexRgb(pal.treeSnow),
      rock: hexRgb(pal.rock),
      ice: hexRgb(0x9fd7ef),
      steel: hexRgb(0x2b3947),
      wood: hexRgb(0x5c3a26),
      roof: hexRgb(0x22323f),
      bamboo: hexRgb(0xc9c05a),
      warm: hexRgb(0xffcf7a),
    };
    this.tree = this.buildTree(resort.flora.kind);
    this.farTree = this.buildFarTree(resort.flora.kind);
    this.rock = this.buildRock();
    this.markerL = this.buildMarker(0x2f7fe0);
    this.markerR = this.buildMarker(0xf1732f);
    this.bamboo = this.buildBamboo();
    this.serac = this.buildSerac();
    this.snowgun = this.buildSnowgun();
    this.cliff = this.buildCliff();
  }

  /**
   * Cheap flank tree — ~40 triangles instead of ~350. The forest on the shoulders needs
   * hundreds of trees per chunk to read as forest, which the detailed tree can't afford.
   */
  buildFarTree(kind) {
    const parts = [];
    const canopy = kind === 'birch' || kind === 'aspen' ? this.c.aspen : this.c.foliage;
    parts.push(paint(new THREE.CylinderGeometry(0.2, 0.3, 1.8, 4).translate(0, 0.9, 0), this.c.trunk));
    if (kind === 'birch' || kind === 'aspen') {
      // Slender trunk with a narrow, snow-loaded crown. A flat disc on a stick read as a
      // field of mushrooms, which is not the look Niseko is going for.
      parts.push(paint(new THREE.CylinderGeometry(0.13, 0.19, 4.6, 4).translate(0, 3.0, 0), this.c.birch));
      parts.push(paint(new THREE.ConeGeometry(1.25, 4.4, 5).translate(0, 5.6, 0), canopy));
      parts.push(paint(new THREE.ConeGeometry(0.78, 1.5, 5).translate(0, 7.3, 0), this.c.snow));
    } else {
      parts.push(paint(new THREE.ConeGeometry(2.05, 6.4, 6).translate(0, 3.9, 0), canopy));
      parts.push(paint(new THREE.ConeGeometry(1.3, 1.7, 6).translate(0, 6.6, 0), this.c.snow));
    }
    return mergeGeometries(parts);
  }

  buildTree(kind) {
    const parts = [];
    if (kind === 'spruce') {
      // Heavy snow-laden spruce (video reference: branches bowed under thick snow). Each
      // green tier carries a broad, thick snow layer that overhangs it, and a couple of
      // lower boughs droop under the load, so the tree reads as buried rather than dusted.
      parts.push(paint(new THREE.CylinderGeometry(0.26, 0.4, 3.0, 6).translate(0, 1.5, 0), this.c.trunk));
      for (let i = 0; i < 3; i++) {
        parts.push(paint(new THREE.ConeGeometry(2.5 - i * 0.52, 3.6, 7).translate(0, 3.0 + i * 1.8, 0), this.c.foliage));
        // thick, slightly overhanging snow load on each tier (wider than the green below)
        parts.push(paint(new THREE.ConeGeometry(2.32 - i * 0.5, 1.05, 7).translate(0, 4.35 + i * 1.8, 0), this.c.snow));
      }
      // drooping lower boughs sagging under the snow
      for (const sgn of [-1, 1]) {
        const bough = new THREE.ConeGeometry(0.7, 1.9, 5);
        bough.rotateZ(sgn * 1.15);
        bough.translate(sgn * 1.7, 2.7, 0);
        parts.push(paint(bough, this.c.snow));
      }
      // a snow cap crowning the top
      parts.push(paint(new THREE.ConeGeometry(0.72, 1.4, 7).translate(0, 8.5, 0), this.c.snow));
    } else if (kind === 'birch') {
      parts.push(paint(new THREE.CylinderGeometry(0.15, 0.22, 7.0, 5).translate(0, 3.5, 0), this.c.birch));
      for (let i = 0; i < 3; i++) {
        const b = new THREE.CylinderGeometry(0.06, 0.09, 2.2, 4);
        b.rotateZ((i % 2 ? 1 : -1) * 0.95);
        b.translate((i % 2 ? 1 : -1) * 0.8, 4.4 + i * 1.0, 0);
        parts.push(paint(b, this.c.birch));
      }
      parts.push(paint(new THREE.ConeGeometry(1.45, 3.4, 6).translate(0, 6.4, 0), hexRgb(0x5b6f5e)));
      parts.push(paint(new THREE.ConeGeometry(0.95, 1.5, 6).translate(0, 7.9, 0), this.c.snow));
    } else if (kind === 'aspen') {
      // Pale slender trunk, narrow crown. A squashed sphere on a pole looked like a
      // beach umbrella once there were a hundred of them on the hillside.
      parts.push(paint(new THREE.CylinderGeometry(0.16, 0.24, 6.4, 5).translate(0, 3.2, 0), this.c.aspen));
      parts.push(paint(new THREE.ConeGeometry(1.5, 4.6, 6).translate(0, 6.0, 0), this.c.foliage));
      parts.push(paint(new THREE.ConeGeometry(1.05, 1.7, 6).translate(0.1, 7.9, 0), this.c.snow));
    } else if (kind === 'sparse') {
      // Rime-encrusted, wind-stunted timberline spruce ("snow ghosts").
      parts.push(paint(new THREE.CylinderGeometry(0.22, 0.34, 1.6, 5).translate(0, 0.8, 0), this.c.trunk));
      parts.push(paint(new THREE.ConeGeometry(1.5, 3.4, 6).translate(0, 2.4, 0), this.c.snow));
      parts.push(paint(new THREE.ConeGeometry(1.0, 2.2, 6).translate(0, 4.2, 0), this.c.snow));
      parts.push(paint(new THREE.ConeGeometry(0.7, 1.5, 6).translate(0, 5.3, 0), this.c.foliage));
    } else {
      return null; // above the treeline
    }
    return mergeGeometries(parts, false);
  }

  buildRock() {
    const g = new THREE.IcosahedronGeometry(1.5, 0);
    g.scale(1.2, 0.7, 1.0);
    const cap = new THREE.IcosahedronGeometry(1.1, 0).scale(1.1, 0.3, 0.95).translate(0, 0.7, 0);
    return mergeGeometries([paint(g, this.c.rock), paint(cap, this.c.snow)], false);
  }

  buildMarker(hex) {
    const pole = paint(new THREE.CylinderGeometry(0.06, 0.06, 2.9, 5).translate(0, 1.45, 0), hexRgb(hex));
    const flag = paint(new THREE.BoxGeometry(0.06, 0.44, 0.66).translate(0.05, 2.4, 0.3), hexRgb(0xf6fbff));
    return mergeGeometries([pole, flag], false);
  }

  buildBamboo() {
    return paint(new THREE.CylinderGeometry(0.05, 0.05, 3.4, 4).translate(0, 1.7, 0), this.c.bamboo);
  }

  buildSerac() {
    const a = new THREE.BoxGeometry(3.4, 4.6, 3.0);
    a.rotateY(0.4);
    a.translate(0, 2.3, 0);
    const b = new THREE.BoxGeometry(2.2, 2.6, 2.0);
    b.rotateY(-0.7);
    b.translate(1.4, 3.4, 0.6);
    return mergeGeometries([paint(a, this.c.ice), paint(b, this.c.ice)], false);
  }

  buildSnowgun() {
    const base = paint(new THREE.CylinderGeometry(0.22, 0.3, 2.4, 6).translate(0, 1.2, 0), this.c.steel);
    const barrel = new THREE.CylinderGeometry(0.34, 0.44, 1.5, 8);
    barrel.rotateX(Math.PI / 2.6);
    barrel.translate(0, 2.5, -0.3);
    return mergeGeometries([base, paint(barrel, this.c.steel)], false);
  }

  /**
   * A layered rock cliff / outcrop — the "大山质感" that lines steep runs (like the video's
   * exposed granite walls). Several stacked, offset slabs read as bedded rock strata, tilted
   * a touch and capped with wind-blown snow on the top ledges. Deterministic-ish variety is
   * driven by the caller's rotation/scale; the base shape stays fixed so it can be merged.
   */
  buildCliff() {
    const parts = [];
    // stacked strata, each narrower + set back as it rises, like a weathered rock face
    const layers = [
      { w: 7.0, h: 2.4, d: 5.2, y: 1.2, ox: 0.0, oz: 0.0, rot: 0.05 },
      { w: 6.2, h: 2.1, d: 4.4, y: 3.3, ox: 0.5, oz: -0.4, rot: -0.08 },
      { w: 5.0, h: 1.9, d: 3.6, y: 5.1, ox: -0.4, oz: 0.3, rot: 0.12 },
      { w: 3.6, h: 1.7, d: 2.8, y: 6.7, ox: 0.7, oz: -0.2, rot: -0.05 },
    ];
    // two rock tones so the strata read as bedded layers, not one solid block
    const rockDark = this.c.rock.map((v) => v * 0.82);
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      const b = new THREE.BoxGeometry(L.w, L.h, L.d);
      b.rotateY(L.rot);
      b.translate(L.ox, L.y, L.oz);
      parts.push(paint(b, i % 2 ? rockDark : this.c.rock));
    }
    // snow caps on the wider lower ledges (wind scours the steep upper faces bare)
    const cap0 = new THREE.BoxGeometry(6.6, 0.5, 4.9).translate(0.0, 2.55, 0.0);
    const cap1 = new THREE.BoxGeometry(4.7, 0.45, 3.4).translate(-0.4, 6.15, 0.3);
    parts.push(paint(cap0, this.c.snow), paint(cap1, this.c.snow));
    return mergeGeometries(parts, false);
  }
}

/* -------------------------------------------------------------------- world */

export class World {
  constructor(scene, resort, terrain) {
    this.scene = scene;
    this.resort = resort;
    this.terrain = terrain;
    this.lib = new PropLibrary(resort);
    this.rng = makeRng(resort.seed);

    this.finishZ = -resort.run.lengthM;

    // How much bare rock lines this run. Green groomers stay clean; steeper runs get more,
    // grander cliffs. Driven by difficulty + pitch, no new resort schema needed.
    const CLIFF = {
      green: { d: 0.0, s: 0.0 },
      blue: { d: 0.05, s: 0.3 },
      black: { d: 0.11, s: 0.7 },
      double: { d: 0.16, s: 1.1 },
    };
    const cf = CLIFF[resort.difficulty] || CLIFF.blue;
    this.cliffDensity = cf.d;
    this.cliffScale = cf.s;

    this.decorMat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.92,
    });
    this.staticGroup = new THREE.Group();
    this.staticGroup.name = 'decor';
    scene.add(this.staticGroup);

    this.chunkGroups = new Map();  // chunkIndex -> Group (merged scenery)
    this.hazardsByChunk = new Map(); // chunkIndex -> [{x,z,r,type}]
    this.gates = [];
    this.kickers = [];
    this.animated = [];

    this.buildSky();
    this.buildVista();
    this.buildLights();
    this.buildFinishBanner();
    this.buildIdealLine();
  }

  /* ------------------------------------------------------------------ sky */

  buildSky() {
    const p = this.resort.palette;
    this.skyUniforms = {
      top: { value: new THREE.Vector3(...p.skyTop) },
      mid: { value: new THREE.Vector3(...p.skyMid) },
      low: { value: new THREE.Vector3(...p.skyLow) },
      sunDir: { value: new THREE.Vector3(...p.sunDir).normalize() },
      sunTint: { value: new THREE.Vector3(...p.sunTint) },
      sunSharp: { value: p.sunSharp },
    };
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1700, 32, 18),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: this.skyUniforms,
        vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `
          varying vec3 vP;
          uniform vec3 top, mid, low, sunDir, sunTint;
          uniform float sunSharp;
          void main(){
            vec3 d = normalize(vP);
            float h = d.y;
            vec3 c = mix(low, mid, smoothstep(-0.12, 0.32, h));
            c = mix(c, top, smoothstep(0.30, 0.92, h));
            float s = exp(-length(d - normalize(sunDir)) * sunSharp);
            c += sunTint * s * 0.40;
            float glow = exp(-length(d - normalize(sunDir)) * (sunSharp * 0.18));
            c += sunTint * glow * 0.10;
            gl_FragColor = vec4(c, 1.0);
          }`,
      })
    );
    this.sky.renderOrder = -30;
    this.scene.add(this.sky);
  }

  /* ---------------------------------------------------------------- vista */

  /**
   * Distant ranges, drawn as flat silhouettes a long way down the valley.
   *
   * The important part is the anchoring. The group rides at the skier's own elevation,
   * and each layer is then dropped by roughly the height the valley floor has lost by the
   * time it gets that far away (`depth * pitch`). Ridge feet therefore sit *at or below*
   * the far snowfields and get occluded by the massif, instead of hanging in mid-air.
   * The shapes also extend far below their ridge line so no bottom edge is ever visible.
   */
  buildVista() {
    const v = this.resort.vista;
    const pitch = this.terrain.pitch;
    this.vista = new THREE.Group();
    // NOTE: do *not* set renderOrder on this Group. three turns a Group's renderOrder into
    // `groupOrder`, which is compared *before* each child's own renderOrder — with -5 here
    // the whole vista sorted ahead of the sky dome and, since none of it writes depth, the
    // sky simply painted straight over it. The opaque layers vanished completely.
    this.scene.add(this.vista);

    // Distant snowy ranges are pale and hazy, not saturated blue cut-outs — anything
    // darker than this reads as a hole in the scene rather than a mountain 2 km away.
    const layers = [
      { depth: -1900, scale: 1.0, color: 0x8aa4c3, opacity: 1.0, signature: true },
      { depth: -1520, scale: 0.62, color: 0x9cb4cf, opacity: 0.94 },
      { depth: -1150, scale: 0.38, color: 0xafc4d9, opacity: 0.84 },
    ];

    layers.forEach((layer, li) => {
      const dist = Math.abs(layer.depth);
      // valley floor at that distance — a touch shallower than the piste, since valleys
      // flatten out as they run away from you
      // Valleys flatten out fast; carrying the piste's own gradient all the way to the
      // horizon would sink the ranges hundreds of metres below eye level and the signature
      // summits would never clear the skyline.
      const floorY = -dist * pitch * 0.34;
      const halfW = 2100;
      const skirt = -1400;

      const ridge = (x, withSummit) => {
        const nx = (x / halfW) * 2.4;
        let h = 26 * layer.scale;
        if (layer.signature && withSummit) {
          // The signature summit gets its own, much narrower x mapping: reusing the wide
          // background scale spread the Matterhorn across 56 degrees of horizon and it
          // came out as a dome. ~700 m of half-width at 1.9 km reads as a peak.
          h += peakProfile(v.kind, clamp((x + 210) / 700, -1.6, 1.6)) * 520 * v.height;
        }
        // Secondary ridgelines so the horizon is never a single shape. Kept small on the
        // signature layer — at full strength the noise was as tall as the summit itself and
        // Mt Yotei ended up as a fin poking out of a lumpy ridge.
        const n = layer.scale * (layer.signature ? 0.3 : 1);
        h += (Math.sin(nx * 3.1 + li * 2.2) * 0.5 + 0.5) * 210 * n;
        h += (Math.sin(nx * 7.7 + li) * 0.5 + 0.5) * 90 * n;
        h += (Math.sin(nx * 15.3 + li * 3.7) * 0.5 + 0.5) * 30 * n;
        return h;
      };

      const STEPS = 240;
      const xs = [];
      const hs = [];
      const hsBase = [];   // ridge line with the signature summit removed
      for (let i = 0; i <= STEPS; i++) {
        const x = -halfW + (i / STEPS) * halfW * 2;
        xs.push(x);
        hs.push(ridge(x, true));
        hsBase.push(ridge(x, false));
      }

      const addShape = (pts, color, opacity, order) => {
        const shape = new THREE.Shape();
        shape.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
        const mesh = new THREE.Mesh(
          new THREE.ShapeGeometry(shape),
          new THREE.MeshBasicMaterial({
            color, transparent: opacity < 1, opacity,
            depthWrite: false, fog: false,
          })
        );
        mesh.position.set(0, floorY, layer.depth);
        mesh.renderOrder = order;
        mesh.frustumCulled = false;
        this.vista.add(mesh);
      };

      // Far range first, near ranges after; all of it still ahead of the terrain (0).
      const order = VISTA_ORDER + li * 3;
      const body = [[xs[0], skirt]];
      for (let i = 0; i <= STEPS; i++) body.push([xs[i], hs[i]]);
      body.push([xs[STEPS], skirt]);
      addShape(body, layer.color, layer.opacity, order);

      if (layer.signature) {
        // Shade the summit's faces, but *only* the summit: an earlier version split the
        // whole range in half at its highest point, which drew a hard vertical seam from
        // the skyline all the way to the valley floor. Each face is a crescent closed
        // along `hsBase`, so every edge hides behind the ridge silhouette itself.
        //
        // Facing comes from the local ridge slope, not from one global summit. A crater
        // rim ('cone') or a twin summit has two equal maxima, and picking "the" peak put
        // the whole mountain in shadow with a vertical cliff down one side.
        const sunLeft = this.resort.palette.sunDir[0] < 0;
        // Sunlit snow high on a peak is brighter than the sky; the shaded face is a cold
        // blue-grey. Neither can go to an extreme or that face disappears into the sky.
        const lit = new THREE.Color(layer.color).lerp(new THREE.Color(0xfdfeff), 0.46);
        const shade = new THREE.Color(layer.color).lerp(new THREE.Color(0x546f8f), 0.38);

        const onSummit = (i) => hs[i] - hsBase[i] > 8;
        const facesSun = (i) => (hs[Math.min(i + 1, STEPS)] - hs[i] > 0) === sunLeft;

        // Runs shorter than this are profile wobble, not a mountain face; drawing them
        // leaves thin bright slivers cutting down through the silhouette.
        //
        // The band hugs the crest and tapers to nothing at both ends of the run. Squaring
        // it off against `hsBase` instead left a vertical edge wherever the facing flipped,
        // which on a broad summit looked like a tower block parked on the ridge.
        const face = (from, to, color) => {
          if (to - from < 7) return;
          const span = to - from;
          const top = [];
          const bottom = [];
          for (let i = from; i <= to; i++) {
            const t = (i - from) / span;
            const w = smoothstep(0, 0.16, t) * smoothstep(0, 0.16, 1 - t);
            top.push([xs[i], hs[i]]);
            bottom.push([xs[i], hs[i] - (hs[i] - hsBase[i] + 6) * w]);
          }
          addShape(top.concat(bottom.reverse()), color, layer.opacity, order + 1);
        };

        let run = -1;
        for (let i = 0; i <= STEPS; i++) {
          const active = onSummit(i);
          const flip = run >= 0 && active && facesSun(i) !== facesSun(run);
          if (!active || flip) {
            if (run >= 0) face(run, i, facesSun(run) ? lit : shade);
            run = active ? i : -1;
          } else if (run < 0 && active) {
            run = i;
          }
        }
        if (run >= 0) face(run, STEPS, facesSun(run) ? lit : shade);
      }

      // Snow-lit crest line on top of the ridge.
      const pts = xs.map((x, i) => new THREE.Vector3(x, hs[i] + 2.5, layer.depth + 3));
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: 0xfbfeff, transparent: true,
          opacity: 0.4 + 0.35 * (1 - li / 2), fog: false,
        })
      );
      line.position.y = floorY;
      line.renderOrder = order + 2;
      line.frustumCulled = false;
      this.vista.add(line);
    });
  }

  /* --------------------------------------------------------------- lights */

  buildLights() {
    const p = this.resort.palette;
    // The per-resort `hemiInt` / `sunInt` values are *relative* weights. These two
    // constants calibrate them against the terrain's actual albedo (snow is ~0.95 white,
    // which is about as bright as a surface gets) so that lit snow lands just under
    // clipping instead of blowing the whole frame out.
    this.hemi = new THREE.HemisphereLight(p.hemiSky, p.hemiGround, p.hemiInt * HEMI_CAL);
    this.scene.add(this.hemi);

    // Sun colour follows the resort's own `sunTint`, pulled most of the way back to white:
    // that is what puts warm light on the sunlit faces while the shaded snow stays blue.
    const sunCol = new THREE.Color(...p.sunTint).lerp(new THREE.Color(0xffffff), 0.55);
    this.sun = new THREE.DirectionalLight(sunCol, p.sunInt * SUN_CAL);
    const d = new THREE.Vector3(...p.sunDir).normalize().multiplyScalar(150);
    this.sun.position.set(d.x, Math.max(90, d.y + 110), d.z);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    // The old frustum was far too tight for a slope this long: anything beyond it got
    // clamped to the edge of the shadow map, which painted a dark band right across the
    // piste. Bias + normalBias kill the self-shadowing acne on the low-poly snow.
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.85;
    const cam = this.sun.shadow.camera;
    cam.left = -130; cam.right = 130; cam.top = 150; cam.bottom = -170;
    cam.near = 1; cam.far = 620;
    cam.updateProjectionMatrix();
    this.sunTarget = new THREE.Object3D();
    this.scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;
    this.scene.add(this.sun);
  }

  /* --------------------------------------------------------------- finish */

  buildFinishBanner() {
    const z = this.finishZ;
    const x = this.terrain.centerX(z);
    const y = this.terrain.elevation(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);

    const postGeo = new THREE.CylinderGeometry(0.28, 0.34, 7.5, 8);
    for (const sx of [-13, 13]) {
      const post = new THREE.Mesh(postGeo, new THREE.MeshStandardMaterial({ color: 0xd8452e, roughness: 0.6 }));
      post.position.set(sx, 3.75, 0);
      post.castShadow = true;
      g.add(post);
    }
    const banner = new THREE.Mesh(
      new THREE.BoxGeometry(26.6, 2.6, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xf5f7fa, roughness: 0.8, emissive: 0x334155, emissiveIntensity: 0.25 })
    );
    banner.position.y = 6.6;
    g.add(banner);

    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 3.2),
      new THREE.MeshBasicMaterial({ color: 0xff5a2b, transparent: true, opacity: 0.55 })
    );
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.y = 0.18;
    g.add(stripe);

    this.staticGroup.add(g);
    this.finishBanner = g;
  }

  /* --------------------------------------------------------- ideal line */

  /**
   * The "optimal line": a smooth spline that threads every slalom gate from the start ramp
   * to the finish. Instead of a floating ribbon it is drawn as a row of flat DIRECTION
   * ARROWS painted on the snow, each lying flat on the surface and pointing downhill toward
   * the next gate. Precomputed from planChunkGates() (deterministic, same coordinates the
   * gate meshes use) so it is complete the moment the run loads and never depends on chunk
   * streaming. Toggle with the on-screen 🎯 button / the L key.
   */
  buildIdealLine() {
    const t = this.terrain;
    const chunkCount = Math.ceil(this.resort.run.lengthM / CHUNK_LEN) + 1;

    // gather gate centres in downhill order, bracketed by a start and finish anchor.
    // `gate:false` marks the two anchors so the trail map can tell them from real gates.
    const pts = [{ x: t.centerX(-6), z: -6, gate: false }];
    for (let i = 0; i <= chunkCount; i++) {
      for (const gp of planChunkGates(this.resort, t, i, this.finishZ)) {
        pts.push({ x: gp.x, z: gp.z, blue: gp.blue, gate: true });
      }
    }
    pts.push({ x: t.centerX(this.finishZ + 2), z: this.finishZ + 2, gate: false });
    pts.sort((a, b) => b.z - a.z); // z decreases downhill

    this.idealLinePts = pts;
    if (pts.length < 2) { this.idealLine = null; return; }

    // smooth spline through the gate centres, sampled densely (kept for lineInfo + arrow placement)
    const ctrl = pts.map((p) => new THREE.Vector3(p.x, 0, p.z));
    const curve = new THREE.CatmullRomCurve3(ctrl, false, 'catmullrom', 0.5);
    const samples = Math.max(48, Math.min(900, pts.length * 10));
    const path = [];
    for (let i = 0; i <= samples; i++) {
      const v = curve.getPoint(i / samples);
      v.y = t.elevation(v.x, v.z);
      path.push(v);
    }
    this.idealCurve = new THREE.CatmullRomCurve3(path, false, 'catmullrom', 0.5);

    // --- a chevron arrow footprint, lying flat (XZ plane), tip pointing to -Z (downhill)
    const AL = 2.6, AW = 2.2, TH = 1.1; // length, half-width, tail thickness
    const shape = new THREE.Shape();
    shape.moveTo(0, -AL * 0.5);          // tip (downhill, -Z)
    shape.lineTo(AW, AL * 0.32);         // right wing
    shape.lineTo(AW - TH, AL * 0.5);     // right inner
    shape.lineTo(0, AL * 0.5 - TH * 1.1);// notch
    shape.lineTo(-(AW - TH), AL * 0.5);  // left inner
    shape.lineTo(-AW, AL * 0.32);        // left wing
    shape.closePath();
    const arrow2d = new THREE.ShapeGeometry(shape); // in XY, +Y = uphill tail

    const total = this.idealCurve.getLength();
    const STEP = 6.0;                       // metres between arrows
    const count = Math.max(2, Math.floor(total / STEP));
    const geos = [];
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const u = i / (count - 1);
      const p = this.idealCurve.getPointAt(u);
      const tan = this.idealCurve.getTangentAt(u).normalize(); // points downhill (-Z-ish)
      const g = arrow2d.clone();
      // lay flat: XY-shape -> XZ-plane (rotate -90° about X), then yaw to face the tangent
      const yaw = Math.atan2(tan.x, tan.z); // heading in XZ
      m.makeRotationX(-Math.PI / 2);
      q.setFromAxisAngle(up, yaw);
      const mm = new THREE.Matrix4().makeRotationFromQuaternion(q).multiply(m);
      mm.setPosition(p.x, t.elevation(p.x, p.z) + 0.12, p.z); // sit on the snow
      g.applyMatrix4(mm);
      // per-vertex sequence so the highlight can travel down the trail of arrows
      const n = g.attributes.position.count;
      const seq = new Float32Array(n).fill(i / count);
      g.setAttribute('aSeq', new THREE.BufferAttribute(seq, 1));
      geos.push(g);
    }
    const geo = mergeGeometries(geos, false);

    const uniforms = {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x14357a) },   // deep blue
      uHi: { value: new THREE.Color(0x4f8bff) },       // brighter pulse crest
    };
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,          // keep the decal off the snow z-buffer
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      uniforms,
      vertexShader: `
        attribute float aSeq;
        varying float vSeq;
        void main() {
          vSeq = aSeq;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uColor;
        uniform vec3 uHi;
        varying float vSeq;
        void main() {
          // a bright pulse travels downhill along the arrow trail
          float wave = 0.5 + 0.5 * sin((vSeq * 34.0) - uTime * 3.2);
          vec3 col = mix(uColor, uHi, pow(wave, 2.0));
          gl_FragColor = vec4(col, 0.9);
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2; // over the snow, under the HUD
    this.staticGroup.add(mesh);
    this.idealLine = mesh;
    this.idealLineMat = mat;
    this.lineVisible = true;
  }

  /** Toggle / set the optimal-line ribbon. Returns the resulting visibility. */
  setLineVisible(on) {
    this.lineVisible = on === undefined ? !this.lineVisible : !!on;
    if (this.idealLine) this.idealLine.visible = this.lineVisible;
    return this.lineVisible;
  }

  /* ------------------------------------------------------------ populate */

  populate(index) {
    if (this.chunkGroups.has(index)) return;
    const zStart = -index * CHUNK_LEN;
    if (zStart < this.finishZ - CHUNK_LEN * 1.2) {
      this.chunkGroups.set(index, new THREE.Group()); // past the finish: nothing
      return;
    }

    const t = this.terrain;
    const r = this.resort;
    const flora = r.flora;
    const rng = makeRng(r.seed * 7919 + index * 104729);
    const merged = [];
    const mergedFar = [];   // flank forest: no shadow casting, it is far outside the map
    const hazards = [];
    const group = new THREE.Group();

    for (let z = zStart; z > zStart - CHUNK_LEN; z -= 4) {
      const cx = t.centerX(z);

      // --- treeline on both flanks
      if (this.lib.tree && rng() < flora.density * 0.42) {
        const side = rng() < 0.5 ? -1 : 1;
        const off = t.pisteHalf + flora.lineGap + rng() * 34;
        const x = cx + side * off;
        const s = lerp(flora.scale[0], flora.scale[1], rng());
        merged.push(place(this.lib.tree, x, t.elevation(x, z), z, s, rng() * 6.28));
      }
      // --- flank forest: fills the ground between the piste treeline and the painted
      //     forest band on the massif, so the shoulders are not bare white slabs
      if (this.lib.farTree) {
        for (let k = 0; k < 4; k++) {
          if (rng() > flora.density * 0.62) continue;
          const side = rng() < 0.5 ? -1 : 1;
          const off = t.width * 0.5 - 4 + Math.pow(rng(), 0.75) * 210;
          const x = cx + side * off;
          const zz = z - rng() * 4;
          const s = lerp(flora.scale[0], flora.scale[1], rng()) * (0.9 + rng() * 0.55);
          // sink slightly: the massif is coarse, and buried trunks beat floating ones
          mergedFar.push(place(this.lib.farTree, x, t.massifY(x, zz) - 0.7, zz, s, rng() * 6.28));
          if (off < 92) hazards.push({ x, z: zz, r: 1.7 * s, type: 'tree' });
        }
      }
      // --- occasional tree island *inside* the piste = real obstacle
      if (this.lib.tree && z < -180 && rng() < 0.055) {
        const x = cx + (rng() - 0.5) * (t.pisteHalf * 1.5);
        merged.push(place(this.lib.tree, x, t.elevation(x, z), z, 1.05, rng() * 6.28));
        hazards.push({ x, z, r: 1.9, type: 'tree' });
      }
      // --- rocks
      if (z < -140 && rng() < 0.05) {
        const x = cx + (rng() - 0.5) * (t.pisteHalf * 2.1);
        const s = 0.6 + rng() * 0.9;
        merged.push(place(this.lib.rock, x, t.elevation(x, z) + 0.35 * s, z, s, rng() * 6.28));
        hazards.push({ x, z, r: 1.5 * s, type: 'rock' });
      }
      // --- flank rock cliffs: exposed strata walls that frame steep runs (大山质感).
      // Placed well beyond the piste edge so they line the run without blocking it; steeper
      // resorts (bigger terrain.pitch) get more, grander walls. Snowy/forested green runs
      // (deer valley) stay clear of big rock. Sunk into the massif so no base floats.
      const cliffChance = this.cliffDensity;
      if (this.lib.cliff && cliffChance > 0 && z < -120 && rng() < cliffChance) {
        const side = rng() < 0.5 ? -1 : 1;
        const off = t.pisteHalf + 16 + rng() * 46;         // far outside the run
        const x = cx + side * off;
        const s = 0.9 + rng() * (0.8 + this.cliffScale);   // steeper runs => taller walls
        const yTop = Math.max(t.elevation(x, z), t.massifY ? t.massifY(x, z) : t.elevation(x, z));
        merged.push(place(this.lib.cliff, x, yTop - 1.2, z, s, rng() * 6.28));
        // only close cliffs are a real hazard; distant ones are pure backdrop
        if (off < t.pisteHalf + 26) hazards.push({ x, z, r: 3.6 * s, type: 'rock' });
      }
      // --- resort-specific dressing
      if (r.props.serac && z < -150 && rng() < 0.06) {
        const x = cx + (rng() < 0.5 ? -1 : 1) * (t.pisteHalf + 4 + rng() * 16);
        const s = 0.7 + rng() * 0.8;
        merged.push(place(this.lib.serac, x, t.elevation(x, z), z, s, rng() * 6.28));
        hazards.push({ x, z, r: 2.2 * s, type: 'ice' });
      }
      if (r.props.bamboo && rng() < 0.3) {
        for (const side of [-1, 1]) {
          const x = cx + side * (t.pisteHalf + 1.6);
          merged.push(place(this.lib.bamboo, x, t.elevation(x, z), z, 1, 0));
        }
      }
      if (r.props.snowgun && rng() < 0.05) {
        const x = cx + (rng() < 0.5 ? -1 : 1) * (t.pisteHalf + 3);
        merged.push(place(this.lib.snowgun, x, t.elevation(x, z), z, 1, rng() * 6.28));
      }
      // --- piste edge markers
      if (rng() < 0.22) {
        const xl = cx - t.pisteHalf + 1.2;
        const xr = cx + t.pisteHalf - 1.2;
        merged.push(place(this.lib.markerL, xl, t.elevation(xl, z), z, 1, Math.PI));
        merged.push(place(this.lib.markerR, xr, t.elevation(xr, z), z, 1, 0));
      }
    }

    if (merged.length) {
      const mesh = new THREE.Mesh(mergeGeometries(merged, false), this.decorMat);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
    if (mergedFar.length) {
      // Kept as a separate mesh purely so it stays out of the shadow pass: these trees sit
      // 60-220 m off the piste, well outside the sun's shadow frustum, so casting from them
      // costs a second pass over thousands of triangles and changes nothing on screen.
      const far = new THREE.Mesh(mergeGeometries(mergedFar, false), this.decorMat);
      far.castShadow = false;
      far.receiveShadow = false;
      group.add(far);
    }

    // --- lift line every 3rd chunk, alpine hut every 5th
    if (index > 0 && index % 3 === 0) group.add(this.buildLift(zStart - 40));
    if (r.props.hut && index > 0 && index % 5 === 0) group.add(this.buildHut(zStart - 60));
    if (r.props.village && index > 0 && index % 7 === 0) group.add(this.buildVillage(zStart - 55));

    // --- slalom gates: the core scoring objective.
    // Coordinates come from planChunkGates() (deterministic) so the ideal-line spline can
    // reproduce them without replaying this RNG stream. Burn a fixed 2 rng() per gate slot
    // (matching the common all-gates-kept path) so the downstream kicker RNG stays put.
    for (let k = 0; k < 3; k++) { rng(); rng(); }
    for (const gp of planChunkGates(r, t, index, this.finishZ)) {
      const gate = this.buildGate(gp.x, gp.z, gp.blue);
      group.add(gate.group);
      this.gates.push(gate);
    }

    // --- terrain park kicker
    if (index > 1 && rng() < 0.5) {
      const z = zStart - 45 - rng() * 30;
      // `z` is negative going downhill, so "before the finish" means z is GREATER than finishZ.
      if (z > this.finishZ + 40) {
        const kicker = this.buildKicker(t.centerX(z) + (rng() - 0.5) * 8, z);
        group.add(kicker.mesh);
        this.kickers.push(kicker);
      }
    }

    this.chunkGroups.set(index, group);
    this.hazardsByChunk.set(index, hazards);
    this.staticGroup.add(group);
  }

  buildGate(x, z, blue) {
    const t = this.terrain;
    const y = t.elevation(x, z);
    const group = new THREE.Group();
    group.position.set(x, y, z);
    const half = 3.6;
    const color = blue ? 0x2b7de0 : 0xe23b45;
    const poleMat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, emissive: color, emissiveIntensity: 0.35 });
    const panelMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    for (const sx of [-half, half]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.4, 6), poleMat);
      pole.position.set(sx, 1.7, 0);
      pole.castShadow = true;
      group.add(pole);
    }
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, 1.1), panelMat);
    panel.position.y = 3.0;
    group.add(panel);
    return { group, x, z, half, passed: false, resolved: false, mat: poleMat, panel };
  }

  buildKicker(x, z) {
    const t = this.terrain;
    const len = 11;
    const width = 9;
    const rise = 2.3;
    const segs = 8;
    const pos = [];
    const idx = [];
    for (let i = 0; i <= segs; i++) {
      const f = i / segs;
      const zc = z - f * len;
      const h = Math.pow(f, 1.7) * rise;
      for (let j = 0; j <= 1; j++) {
        const xx = x + (j === 0 ? -width / 2 : width / 2);
        pos.push(xx, t.elevation(xx, zc) + h + 0.06, zc);
      }
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: 0xeaf4ff, roughness: 0.78, flatShading: true,
    }));
    mesh.receiveShadow = true;
    return { mesh, x, z, halfWidth: width / 2, len, rise, lipZ: z - len };
  }

  buildLift(z) {
    const kind = this.resort.props.lift;
    const t = this.terrain;
    const side = 1;
    const x = t.centerX(z) + side * (t.pisteHalf + 26);
    const g = new THREE.Group();
    g.position.set(x, t.elevation(x, z), z);
    const steel = new THREE.MeshStandardMaterial({ color: 0x2a3948, roughness: 0.55, metalness: 0.5, flatShading: true });

    const mastH = kind === 'tram' ? 22 : kind === 'tbar' ? 6 : 13;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.44, mastH, 8), steel);
    mast.position.y = mastH / 2;
    mast.castShadow = true;
    g.add(mast);

    const armW = kind === 'tram' ? 9 : 6;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(armW, 0.36, 0.5), steel);
    arm.position.y = mastH - 0.7;
    g.add(arm);

    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 260, 6), steel);
    cable.rotation.x = Math.PI / 2;
    cable.position.set(0, mastH - 0.9, -100);
    g.add(cable);

    if (kind !== 'tbar') {
      const carriers = new THREE.Group();
      const count = kind === 'tram' ? 2 : 6;
      for (let i = 0; i < count; i++) {
        const c = new THREE.Group();
        c.position.set(0, mastH - 1.2, -i * (kind === 'tram' ? 120 : 34));
        const hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.4, 5), steel);
        hanger.position.y = -1.2;
        c.add(hanger);
        if (kind === 'gondola' || kind === 'tram') {
          const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(kind === 'tram' ? 4.4 : 1.9, kind === 'tram' ? 3.2 : 2.3, kind === 'tram' ? 3.6 : 1.9),
            new THREE.MeshStandardMaterial({ color: kind === 'tram' ? 0xd8452e : 0xe8eef4, roughness: 0.5, metalness: 0.2 })
          );
          cabin.position.y = -3.4;
          cabin.castShadow = true;
          c.add(cabin);
        } else {
          const seat = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.16, 0.6), steel);
          seat.position.y = -2.5;
          c.add(seat);
          const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.0, 0.14), steel);
          back.position.set(0, -2.0, -0.32);
          c.add(back);
        }
        carriers.add(c);
      }
      g.add(carriers);
      const step = kind === 'tram' ? 120 : 34;
      this.animated.push({
        obj: carriers,
        fn: (o, time) => { o.position.z = -((time * 3.2) % step); },
      });
    }
    return g;
  }

  buildHut(z) {
    const t = this.terrain;
    const x = t.centerX(z) - (t.pisteHalf + 22 + this.rng() * 12);
    const g = new THREE.Group();
    g.position.set(x, t.elevation(x, z), z);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(8, 4.2, 6.4),
      new THREE.MeshStandardMaterial({ color: 0x5c3a26, roughness: 0.95, flatShading: true }));
    wall.position.y = 2.1;
    wall.castShadow = true;
    g.add(wall);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(6.2, 2.8, 4),
      new THREE.MeshStandardMaterial({ color: 0xf3f9ff, roughness: 0.85, flatShading: true }));
    roof.position.y = 5.5;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    g.add(roof);
    const win = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.1),
      new THREE.MeshBasicMaterial({ color: 0xffcf7a }));
    win.position.set(0, 2.4, 3.25);
    g.add(win);
    const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 2.4, 6),
      new THREE.MeshStandardMaterial({ color: 0x33414d, roughness: 0.9 }));
    chimney.position.set(2.2, 6.2, -1);
    g.add(chimney);
    return g;
  }

  buildVillage(z) {
    const t = this.terrain;
    const g = new THREE.Group();
    const baseX = t.centerX(z) + (t.pisteHalf + 40);
    for (let i = 0; i < 5; i++) {
      const x = baseX + (this.rng() - 0.5) * 40;
      const zz = z - this.rng() * 60;
      const h = 4 + this.rng() * 4;
      const b = new THREE.Mesh(new THREE.BoxGeometry(5 + this.rng() * 4, h, 5 + this.rng() * 3),
        new THREE.MeshStandardMaterial({ color: 0x3b4653, roughness: 0.9, flatShading: true }));
      b.position.set(x, t.elevation(x, zz) + h / 2, zz);
      g.add(b);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(6.6, 0.7, 6.4),
        new THREE.MeshStandardMaterial({ color: 0xf1f8ff, roughness: 0.85 }));
      roof.position.set(x, t.elevation(x, zz) + h + 0.35, zz);
      g.add(roof);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.9),
        new THREE.MeshBasicMaterial({ color: 0xffbb66 }));
      glow.position.set(x - 2.6, t.elevation(x, zz) + h * 0.55, zz + 2.7);
      g.add(glow);
    }
    return g;
  }

  /* ----------------------------------------------------------- lifecycle */

  update(riderPos, camera, time) {
    // mirror the terrain's active chunk window
    for (const index of this.terrain.chunks.keys()) this.populate(index);
    for (const [index, group] of this.chunkGroups) {
      if (!this.terrain.chunks.has(index)) {
        this.staticGroup.remove(group);
        group.traverse((o) => { if (o.isMesh && o.geometry && o.name !== 'shared') o.geometry.dispose?.(); });
        this.chunkGroups.delete(index);
        this.hazardsByChunk.delete(index);
      }
    }
    this.gates = this.gates.filter((g) => g.group.parent);
    this.kickers = this.kickers.filter((k) => k.mesh.parent);

    this.sky.position.copy(camera.position);
    this.vista.position.set(riderPos.x * 0.25, riderPos.y, riderPos.z);
    this.sunTarget.position.copy(riderPos);
    const d = new THREE.Vector3(...this.resort.palette.sunDir).normalize().multiplyScalar(150);
    this.sun.position.set(riderPos.x + d.x, riderPos.y + Math.max(90, d.y + 110), riderPos.z + d.z);

    for (const a of this.animated) a.fn(a.obj, time);
    if (this.idealLineMat) this.idealLineMat.uniforms.uTime.value = time;
  }

  hazardsAround(z) {
    const i = Math.max(0, Math.floor(-z / CHUNK_LEN));
    const out = [];
    for (const k of [i - 1, i, i + 1]) {
      const arr = this.hazardsByChunk.get(k);
      if (arr) out.push(...arr);
    }
    return out;
  }

  dispose() {
    this.scene.remove(this.staticGroup, this.sky, this.vista, this.hemi, this.sun, this.sunTarget);
    this.staticGroup.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
    this.decorMat.dispose();
    this.gates = [];
    this.kickers = [];
    this.animated = [];
    this.chunkGroups.clear();
    this.hazardsByChunk.clear();
  }
}
