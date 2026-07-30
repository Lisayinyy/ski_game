import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './util.js';

/**
 * Terrain — the mountain itself.
 *
 * Coordinate convention for the whole game:
 *   forward / downhill = -Z      (so `z` is negative and gets more negative as you descend)
 *   world +X           = skier's right
 *   elevation          = y, decreasing as z decreases
 *
 * Two surfaces make up the mountain:
 *
 *   1. **Piste chunks** — a high resolution strip `t.width` wide that follows the skier.
 *      This is the surface physics reads from (`elevation`). Inside `pisteHalf` it is
 *      groomed and fast; outside the ground curves up into banks and the snow gets deep.
 *
 *   2. **Massif** — one low resolution sheet, built once for the whole run, spanning
 *      `MASSIF_HALF` metres either side of the piste and running well past the finish.
 *      It reuses `elevation()` inside the strip (sunk by `dip` so the chunks always win)
 *      and continues the bank profile outwards into open snowfields, forest bands and
 *      rock. Without it the piste reads as a white ribbon floating in the sky.
 */

export const CHUNK_LEN = 100;
const CHUNK_AHEAD = 9;
const CHUNK_BEHIND = 2;
const ROWS = 44;
const COLS = 44;

/** Massif extent. */
const MASSIF_HALF = 1150;     // metres either side of the piste centre
const MASSIF_ROW = 24;        // metres between rows
const MASSIF_TAIL = 1500;     // metres of terrain kept beyond the finish line
const MASSIF_HEAD = 200;      // metres of terrain kept above the start gate
const MASSIF_INNER = 22;      // columns spanning the piste strip
const MASSIF_OUTER = 22;      // columns per side, from the strip edge outwards
const DIP = 1.1;              // how far the massif sinks under the piste chunks
const BANK_KNEE = 14;         // metres of quadratic bank before it straightens out
const BANK_RELAX = 0.8;       // slope multiplier past the knee

const mix3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const hexRgb = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

export class Terrain {
  constructor(scene, resort) {
    this.resort = resort;
    this.t = resort.terrain;
    this.pal = resort.palette;
    this.runLength = resort.run.lengthM;
    // Mogul fields: bands are expressed as run-progress fractions [0..1] so a resort's
    // bump zones stay put regardless of course length. Defaults keep old resorts smooth.
    this.mogulField = this.t.mogulField || { bands: [], amp: 0, size: 1, speedTax: 0 };
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    scene.add(this.group);

    this.material = this.makeSnowMaterial();
    this.massifMaterial = this.makeSnowMaterial({ massif: true });

    this.chunks = new Map(); // chunk index -> Mesh
    this.buildMassif();
  }

  /* ------------------------------------------------------------- material */

  /**
   * Snow is one flat white surface, so all of the readability has to come from the
   * shader: groomer corduroy on the piste, wind ripples off it, and a fine grain that
   * keeps the highlights from going completely dead. Doing it per-fragment (instead of
   * baking it into vertex colours) means the ribs stay crisp no matter how coarse the
   * mesh is — the old vertex-colour corduroy was finer than the vertex spacing and
   * simply vanished.
   */
  makeSnowMaterial({ massif = false } = {}) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: massif ? 0.95 : 0.9,
      metalness: 0.0,
      // background flanks read better smooth-shaded; 24 m facets are too obvious flat
      flatShading: !massif,
      vertexColors: true,
      // snow bounces a huge amount of light around; without this lift the shaded sides
      // fall straight to the (dark blue) hemisphere ground colour and look like concrete
      emissive: new THREE.Color(massif ? 0xc6dcf2 : 0xd6e6f6),
      emissiveIntensity: massif ? 0.085 : 0.03,
    });
    const uniforms = {
      uCord: { value: massif ? 0.0 : Math.max(0.085, this.pal.corduroy * 1.9) },
      uGrain: { value: massif ? 0.03 : 0.05 },
      uFade: { value: massif ? new THREE.Vector2(120, 420) : new THREE.Vector2(38, 190) },
    };
    mat.userData.snowUniforms = uniforms;

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aOff;
           varying float vOffT;
           varying vec3 vWPosT;
           varying float vDepthT;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vOffT = aOff;
           vWPosT = (modelMatrix * vec4(position, 1.0)).xyz;`
        )
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
           vDepthT = -mvPosition.z;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uCord;
           uniform float uGrain;
           uniform vec2 uFade;
           varying float vOffT;
           varying vec3 vWPosT;
           varying float vDepthT;
           float snowHash(vec2 p) {
             return fract(sin(dot(p, vec2(41.317, 78.233))) * 43758.5453);
           }`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           {
             // distance fade: fine detail would alias into moire far away
             float near = 1.0 - smoothstep(uFade.x, uFade.y, vDepthT);

             // groomer corduroy — parallel ribs left by the cat, piste only
             float rib = sin(vWPosT.x * 7.6 + sin(vWPosT.z * 0.02) * 1.4);
             rib = sign(rib) * pow(abs(rib), 0.65);
             float cord = uCord * (1.0 - vOffT) * near;
             diffuseColor.rgb *= 1.0 + rib * cord;

             // second, coarser pass so the piste still reads at middle distance
             float wide = sin(vWPosT.x * 1.55 + vWPosT.z * 0.03);
             diffuseColor.rgb *= 1.0 + wide * uCord * 0.42 * (1.0 - vOffT) * near;

             // wind-drifted ripples on the untracked snow
             float dune = sin(vWPosT.x * 0.42 + vWPosT.z * 0.26)
                        + 0.6 * sin(vWPosT.x * 0.17 - vWPosT.z * 0.11);
             diffuseColor.rgb *= 1.0 + dune * 0.035 * vOffT;

             // fine grain keeps big white areas from flattening out completely
             float g = snowHash(floor(vWPosT.xz * 1.7)) - 0.5;
             diffuseColor.rgb *= 1.0 + g * uGrain * near;
           }`
        );
    };
    return mat;
  }

  /** Convenience accessors so callers don't have to reach into `.t`. */
  get pisteHalf() { return this.t.pisteHalf; }
  get width() { return this.t.width; }
  get pitch() { return this.t.pitch; }

  /** Piste centre line drifts left/right down the mountain. */
  centerX(z) {
    const [c0, a0, c1, a1] = this.t.curve;
    return Math.sin(z * c0) * a0 + Math.sin(z * c1 + 1.7) * a1;
  }

  /** 0 = groomed piste, 1 = deep off-piste snow. */
  offPiste(x, z) {
    const dx = Math.abs(x - this.centerX(z));
    return smoothstep(this.t.pisteHalf * 0.86, this.t.pisteHalf * 1.3, dx);
  }

  /**
   * How strongly the current point down the course sits inside a mogul band.
   * Bands are progress fractions [0..1]; the mask ramps up/down over `EDGE` metres so a
   * field grows into bumps and eases back to smooth corduroy instead of popping on.
   * Returns 0 outside every band, up to 1 in the heart of one.
   */
  mogulMask(z) {
    const bands = this.mogulField.bands;
    if (!bands || !bands.length) return 0;
    const p = clamp(-z / this.runLength, 0, 1); // run progress at this z
    const EDGE = 0.05;
    let m = 0;
    for (const [a, b] of bands) {
      const inn = smoothstep(a - EDGE, a + EDGE, p) * (1 - smoothstep(b - EDGE, b + EDGE, p));
      if (inn > m) m = inn;
    }
    return m;
  }

  /**
   * Bump height at (x,z). Real mogul fields are rounded mounds packed in an offset grid,
   * not a single sine — so two staggered lattices (a coarse primary + a finer secondary
   * rotated 90°) are summed and rectified toward rounded crests. Only rendered where the
   * mask is on, and faded out toward the piste edge so the bumps live on the run itself.
   */
  mogulHeight(x, z) {
    const f = this.mogulField;
    const mask = this.mogulMask(z);
    if (mask <= 0 || f.amp <= 0) return 0;
    const inPiste = 1 - smoothstep(this.t.pisteHalf * 0.75, this.t.pisteHalf * 1.15, Math.abs(x - this.centerX(z)));
    if (inPiste <= 0) return 0;
    const s = 0.62 / Math.max(0.4, f.size); // spatial frequency; bigger size => wider bumps
    // primary lattice
    let h = Math.cos(x * s) * Math.cos(z * s * 0.92);
    // secondary lattice, offset + rotated, gives the packed offset-grid look
    h += 0.55 * Math.cos((x + z) * s * 0.9 + 1.3) * Math.cos((x - z) * s * 0.8);
    // rectify toward rounded mounds (mostly positive humps, shallow troughs)
    h = 0.5 + 0.5 * Math.sin(h * 1.15);
    h = Math.pow(h, 0.8);
    return (h - 0.35) * f.amp * mask * inPiste;
  }

  /** 0..1 bump intensity for physics (speed tax + camera shake). */
  mogulIntensity(x, z) {
    const f = this.mogulField;
    if (f.amp <= 0) return 0;
    const inPiste = 1 - smoothstep(this.t.pisteHalf * 0.75, this.t.pisteHalf * 1.15, Math.abs(x - this.centerX(z)));
    return this.mogulMask(z) * inPiste;
  }

  /**
   * Height the ground gains `over` metres outside the groomed piste.
   *
   * A pure quadratic (what this used to be) is fine for the first few metres but runs
   * away badly: on a 150 m strip with `wallSteep` 1.7 it reached a 66 m wall, turning
   * the run into a slot canyon. So the quadratic only lasts to the knee, then it
   * continues linearly at a slightly relaxed slope — steep banks, open bowls.
   */
  bankRise(over) {
    const k = 0.0115 * this.t.wallSteep;
    if (over <= BANK_KNEE) return over * over * k;
    return BANK_KNEE * BANK_KNEE * k + this.bankSlopeAt(over) * (over - BANK_KNEE);
  }

  bankSlopeAt(over) {
    const k = 0.0115 * this.t.wallSteep;
    return over <= BANK_KNEE ? 2 * over * k : 2 * BANK_KNEE * k * BANK_RELAX;
  }

  elevation(x, z) {
    const t = this.t;
    const dx = x - this.centerX(z);
    const adx = Math.abs(dx);

    let y = z * t.pitch;
    y += Math.sin(z * 0.0042) * t.rollAmp;
    y += Math.sin(z * 0.013 + 1.1) * t.rollAmp * 0.35;

    y += this.bankRise(Math.max(0, adx - t.pisteHalf));

    const inPiste = 1 - smoothstep(t.pisteHalf * 0.7, t.pisteHalf, adx);
    // faint always-on chatter so the piste is never glassy...
    y += Math.sin(dx * 0.62) * Math.sin(z * 0.58) * t.mogul * 0.35 * inPiste;
    // ...and the real mogul fields where the resort declares them.
    y += this.mogulHeight(x, z);
    // long rollers — wide enough to catch the light and give the eye some relief
    y += Math.sin(z * 0.031) * Math.cos(dx * 0.055) * 0.55;
    y += Math.sin(z * 0.205 + dx * 0.17) * 0.22 * t.rough;
    y += Math.sin(z * 0.62 + dx * 0.41) * 0.09 * t.rough;
    return y;
  }

  /** Downhill gradient (dy per metre) along a horizontal direction. */
  gradient(x, z, dirX, dirZ, step = 2.2) {
    const here = this.elevation(x, z);
    const there = this.elevation(x + dirX * step, z + dirZ * step);
    return (there - here) / step;
  }

  normal(x, z, out = new THREE.Vector3()) {
    const e = 1.2;
    const hL = this.elevation(x - e, z);
    const hR = this.elevation(x + e, z);
    const hB = this.elevation(x, z - e);
    const hF = this.elevation(x, z + e);
    return out.set(hL - hR, 2 * e, hB - hF).normalize();
  }

  vertexColor(x, z) {
    const pal = this.pal;
    const off = this.offPiste(x, z);
    return mix3(pal.snowLo, pal.offPiste, off);
  }

  /* --------------------------------------------------------------- massif */

  /**
   * Height of the surrounding mountain. Matches `elevation` exactly inside the piste
   * strip, then carries the bank's slope outwards, easing it off so the flanks open into
   * broad snowfields instead of vertical walls.
   */
  massifY(x, z) {
    const t = this.t;
    const edge = t.width * 0.5;
    const cx = this.centerX(z);
    const dx = x - cx;
    const adx = Math.abs(dx);

    if (adx <= edge) {
      // sink under the piste chunks; the offset reaches 0 exactly at the strip edge so
      // there is no ledge where the two surfaces meet
      const dip = DIP * smoothstep(edge, edge - 16, adx);
      return this.elevation(x, z) - dip;
    }

    const s = Math.sign(dx);
    const base = this.elevation(cx + s * edge, z);
    const slope0 = this.bankSlopeAt(edge - t.pisteHalf);
    const far = adx - edge;

    // bank slope decays over ~55 m, then a gentle constant rise out to the ridges
    const L = 55;
    let y = base + slope0 * L * (1 - Math.exp(-far / L)) + far * 0.105;
    // ridge / gully relief, growing with distance so it never disturbs the seam
    const relief = Math.min(far * 0.11, 20);
    y += Math.sin(far * 0.019 + z * 0.0032 + s * 1.7) * relief;
    y += Math.sin(far * 0.0072 - z * 0.0015 + s * 0.4) * relief * 1.6;

    // the outer third rolls over a crest and falls away, so the silhouette against the
    // sky is an undulating ridge line rather than the cut edge of a sheet
    const span = MASSIF_HALF - edge;
    const over2 = smoothstep(span * 0.62, span, far);
    y -= over2 * (150 + Math.sin(z * 0.0026 + s * 2.3) * 55);
    return y;
  }

  massifColor(x, z) {
    const pal = this.pal;
    const t = this.t;
    const adx = Math.abs(x - this.centerX(z));
    const edge = t.width * 0.5;

    let col = this.vertexColor(x, z);

    if (adx > edge) {
      const far = adx - edge;
      // forest band: mottled, thinning out above the tree line. Snow sits in the
      // canopy, so the distant forest is far lighter than the tree prop colour.
      const treeCol = mix3(hexRgb(pal.tree), hexRgb(pal.treeSnow), 0.14);
      const band = smoothstep(80, 230, far) * (1 - smoothstep(430, 640, far));
      const mottle = clamp(
        0.5
        + 0.30 * Math.sin(far * 0.055 + z * 0.021)
        + 0.24 * Math.sin(far * 0.13 - z * 0.047)
        + 0.16 * Math.sin(far * 0.31 + z * 0.09), 0, 1);
      const density = this.resort.flora?.density ?? 0.8;
      col = mix3(col, treeCol, band * mottle * 0.72 * density);

      // exposed rock on the steepest ground high on the flanks
      const dy = this.massifY(x + 9, z) - this.massifY(x - 9, z);
      const steep = smoothstep(0.30, 1.0, Math.abs(dy) / 18);
      const high = smoothstep(220, 560, far);
      col = mix3(col, hexRgb(pal.rock), steep * high * 0.5);

      // only the very far ridges get an extra lift; scene fog handles the rest
      col = mix3(col, hexRgb(pal.fog), smoothstep(MASSIF_HALF * 0.55, MASSIF_HALF, far) * 0.35);
    }
    return col;
  }

  buildMassif() {
    const t = this.t;
    const edge = t.width * 0.5;
    const zTop = MASSIF_HEAD;
    const zEnd = -(this.resort.run.lengthM + MASSIF_TAIL);
    const rows = Math.ceil((zTop - zEnd) / MASSIF_ROW);

    // column offsets from the piste centre: dense across the strip, stretching outwards
    const offsets = [];
    for (let i = MASSIF_OUTER; i >= 1; i--) {
      offsets.push(-(edge + Math.pow(i / MASSIF_OUTER, 2.1) * (MASSIF_HALF - edge)));
    }
    for (let i = 0; i <= MASSIF_INNER; i++) {
      offsets.push(lerp(-edge, edge, i / MASSIF_INNER));
    }
    for (let i = 1; i <= MASSIF_OUTER; i++) {
      offsets.push(edge + Math.pow(i / MASSIF_OUTER, 2.1) * (MASSIF_HALF - edge));
    }
    const cols = offsets.length;

    const pos = [];
    const col = [];
    const off = [];
    const idx = [];

    for (let r = 0; r <= rows; r++) {
      const z = zTop - (r / rows) * (zTop - zEnd);
      const cx = this.centerX(z);
      for (let c = 0; c < cols; c++) {
        const x = cx + offsets[c];
        pos.push(x, this.massifY(x, z), z);
        const rgb = this.massifColor(x, z);
        col.push(rgb[0], rgb[1], rgb[2]);
        off.push(clamp(Math.abs(offsets[c]) / (t.pisteHalf * 1.3), 0, 1));
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = (r + 1) * cols + c;
        const e = d + 1;
        // CCW seen from above, so computeVertexNormals() points them at the sky
        idx.push(a, b, d, b, e, d);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aOff', new THREE.Float32BufferAttribute(off, 1));
    g.setIndex(idx);
    g.computeVertexNormals();

    this.massif = new THREE.Mesh(g, this.massifMaterial);
    this.massif.name = 'massif';
    this.massif.receiveShadow = false;
    this.massif.castShadow = false;
    this.massif.frustumCulled = false;
    this.group.add(this.massif);
  }

  /* --------------------------------------------------------------- chunks */

  buildChunk(index) {
    const zStart = -index * CHUNK_LEN;
    const width = this.t.width;
    const pos = [];
    const col = [];
    const off = [];
    const idx = [];

    for (let r = 0; r <= ROWS; r++) {
      const z = zStart - (r / ROWS) * CHUNK_LEN;
      const cx = this.centerX(z);
      for (let c = 0; c <= COLS; c++) {
        const x = cx - width / 2 + (c / COLS) * width;
        pos.push(x, this.elevation(x, z), z);
        const rgb = this.vertexColor(x, z);
        col.push(rgb[0], rgb[1], rgb[2]);
        off.push(this.offPiste(x, z));
      }
    }
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const a = r * (COLS + 1) + c;
        const b = a + 1;
        const d = (r + 1) * (COLS + 1) + c;
        const e = d + 1;
        // NOTE: winding matters. Wound the other way the vertex normals come out
        // pointing at the ground, the snow gets lit by the (dark blue) hemisphere
        // ground colour and the shadow normalBias pushes the wrong way.
        idx.push(a, b, d, b, e, d);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aOff', new THREE.Float32BufferAttribute(off, 1));
    g.setIndex(idx);
    g.computeVertexNormals();

    const mesh = new THREE.Mesh(g, this.material);
    mesh.receiveShadow = true;
    mesh.name = `chunk-${index}`;
    return mesh;
  }

  /** Keep a window of chunks alive around the skier; returns newly created chunk indices. */
  update(riderZ) {
    const current = Math.max(0, Math.floor(-riderZ / CHUNK_LEN));
    const from = Math.max(0, current - CHUNK_BEHIND);
    const to = current + CHUNK_AHEAD;
    const created = [];

    for (let i = from; i <= to; i++) {
      if (!this.chunks.has(i)) {
        const mesh = this.buildChunk(i);
        this.chunks.set(i, mesh);
        this.group.add(mesh);
        created.push(i);
      }
    }
    for (const [i, mesh] of this.chunks) {
      if (i < from || i > to) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.chunks.delete(i);
      }
    }
    return created;
  }

  dispose() {
    for (const [, mesh] of this.chunks) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.chunks.clear();
    if (this.massif) {
      this.group.remove(this.massif);
      this.massif.geometry.dispose();
      this.massif = null;
    }
    this.material.dispose();
    this.massifMaterial.dispose();
    this.group.parent?.remove(this.group);
  }
}
