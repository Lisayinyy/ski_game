import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, damp, lerp } from './util.js';

/**
 * Skier — an alpine (two-plank / 双板) rig.
 *
 * Deliberately NOT a snowboard: two independent skis with real sidecut and tip rocker,
 * a parallel stance that can be driven onto its edges, an A-frame snowplow (犁式) brake,
 * ski poles that get planted through each turn, and a tuck (含胸收腿) schuss position.
 *
 * Hierarchy:
 *   root   — yaw (heading) + terrain pitch, positioned by physics
 *     lean — inward lean / roll of the whole body through a carve
 *       lower — legs, boots, bindings, skis
 *       upper — hips, torso, arms, poles, head
 */

const JACKET = 0xf05a2c;
const JACKET_DARK = 0xc7401d;
const PANTS = 0x1f2f44;
const SKIN = 0xf0c39a;
const HELMET = 0xf3f6f9;
const LENS = 0x1d6fb8;
const SKI_TOP = 0xffc93c;
const SKI_BASE = 0x14293d;
const STEEL = 0xc9d4de;

/** mergeGeometries() requires identical attribute sets — drop UVs everywhere. */
function stripUV(geo) {
  geo.deleteAttribute('uv');
  geo.deleteAttribute('uv1');
  geo.deleteAttribute('uv2');
  return geo;
}

function makeMesh(geo, color, opts = {}) {
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.72, metalness: opts.metalness ?? 0.0,
    flatShading: true, emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
  }));
  m.castShadow = true;
  return m;
}

/**
 * A real ski profile: tip rocker, sidecut (wide tip → narrow waist → wide tail),
 * variable thickness, steel edges. Local +Z is the tail, -Z is the tip.
 */
function makeSkiGeometry(len = 1.92) {
  const N = 20;
  const pos = [];
  const idx = [];
  const col = [];
  const top = new THREE.Color(SKI_TOP);
  const base = new THREE.Color(SKI_BASE);
  const edge = new THREE.Color(STEEL);

  const halfWidth = (t) => {
    const d = Math.abs(t - 0.52) * 2;                    // 0 at waist, 1 at ends
    const tipBias = t < 0.5 ? 1.06 : 0.97;               // shovel a touch wider than tail
    return (0.0425 + 0.0165 * Math.pow(d, 1.5)) * tipBias;
  };
  const rise = (t) => {
    let y = 0;
    if (t < 0.20) y += Math.pow((0.20 - t) / 0.20, 2.0) * 0.105;   // tip rocker
    if (t > 0.92) y += Math.pow((t - 0.92) / 0.08, 2.0) * 0.045;   // tail kick
    y += Math.sin(t * Math.PI) * 0.012;                            // camber
    return y;
  };
  const thick = (t) => 0.016 + Math.sin(clamp(t, 0, 1) * Math.PI) * 0.020;

  const rows = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = -len / 2 + t * len;
    const w = halfWidth(t);
    const y0 = rise(t);
    const y1 = y0 + thick(t);
    const bi = pos.length / 3;
    // 0:botL 1:botR 2:topL 3:topR
    pos.push(-w, y0, z, w, y0, z, -w, y1, z, w, y1, z);
    for (const c of [base, base, top, top]) col.push(c.r, c.g, c.b);
    rows.push(bi);
  }
  for (let i = 0; i < N; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    // top
    idx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
    // bottom
    idx.push(a + 0, b + 0, a + 1, a + 1, b + 0, b + 1);
    // left side
    idx.push(a + 0, a + 2, b + 0, a + 2, b + 2, b + 0);
    // right side
    idx.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();

  // steel edges as thin strips just under the sidewall
  const edges = [];
  for (const sx of [-1, 1]) {
    const strip = stripUV(new THREE.BoxGeometry(0.008, 0.012, len * 0.96));
    strip.translate(sx * 0.048, 0.02, 0);
    const n = strip.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = edge.r; arr[i * 3 + 1] = edge.g; arr[i * 3 + 2] = edge.b; }
    strip.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
    edges.push(strip);
  }
  return mergeGeometries([stripUV(g), ...edges], false);
}

function makePole() {
  const g = new THREE.Group();
  const shaft = makeMesh(new THREE.CylinderGeometry(0.011, 0.008, 1.22, 5), 0x9aa7b4, { metalness: 0.5, roughness: 0.4 });
  shaft.position.y = -0.61;
  g.add(shaft);
  const grip = makeMesh(new THREE.CylinderGeometry(0.022, 0.019, 0.16, 6), 0x21262c);
  grip.position.y = -0.05;
  g.add(grip);
  const basket = makeMesh(new THREE.CylinderGeometry(0.055, 0.045, 0.02, 8), 0x2c3238);
  basket.position.y = -1.12;
  g.add(basket);
  return g;
}

export class Skier {
  constructor(scene) {
    this.root = new THREE.Group();
    this.lean = new THREE.Group();
    this.lower = new THREE.Group();
    this.upper = new THREE.Group();
    this.root.add(this.lean);
    this.lean.add(this.lower, this.upper);
    scene.add(this.root);

    const skiGeo = makeSkiGeometry();
    const skiMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.25, flatShading: true });

    this.skis = [];
    this.legs = [];
    for (const side of [-1, 1]) {
      const skiGroup = new THREE.Group();
      skiGroup.position.set(side * 0.17, 0.02, 0);
      const ski = new THREE.Mesh(skiGeo, skiMat);
      ski.castShadow = true;
      skiGroup.add(ski);

      const binding = makeMesh(new THREE.BoxGeometry(0.11, 0.045, 0.34), 0x2b3138);
      binding.position.y = 0.055;
      skiGroup.add(binding);

      const boot = makeMesh(new THREE.BoxGeometry(0.125, 0.24, 0.30), 0x2e3a46);
      boot.position.set(0, 0.19, 0.01);
      skiGroup.add(boot);
      const cuff = makeMesh(new THREE.BoxGeometry(0.135, 0.10, 0.24), JACKET_DARK);
      cuff.position.set(0, 0.33, -0.01);
      skiGroup.add(cuff);

      this.lower.add(skiGroup);
      this.skis.push(skiGroup);

      // shin + thigh drawn as tapered boxes so the knee flex reads clearly
      const leg = new THREE.Group();
      leg.position.set(side * 0.17, 0.40, 0);
      const shin = makeMesh(new THREE.BoxGeometry(0.15, 0.42, 0.17), PANTS);
      shin.position.y = 0.21;
      leg.add(shin);
      const thigh = new THREE.Group();
      thigh.position.y = 0.42;
      const thighMesh = makeMesh(new THREE.BoxGeometry(0.18, 0.46, 0.2), PANTS);
      thighMesh.position.y = 0.23;
      thigh.add(thighMesh);
      leg.add(thigh);
      leg.userData.thigh = thigh;
      this.lower.add(leg);
      this.legs.push(leg);
    }

    // ---- upper body
    const hips = makeMesh(new THREE.BoxGeometry(0.42, 0.22, 0.26), PANTS);
    hips.position.y = 0.90;
    this.upper.add(hips);

    this.torso = new THREE.Group();
    this.torso.position.y = 0.98;
    const chest = makeMesh(new THREE.BoxGeometry(0.46, 0.52, 0.30), JACKET);
    chest.position.y = 0.26;
    this.torso.add(chest);
    const shoulder = makeMesh(new THREE.BoxGeometry(0.52, 0.14, 0.30), JACKET_DARK);
    shoulder.position.y = 0.55;
    this.torso.add(shoulder);
    const collar = makeMesh(new THREE.BoxGeometry(0.2, 0.10, 0.2), JACKET_DARK);
    collar.position.y = 0.63;
    this.torso.add(collar);

    this.head = new THREE.Group();
    this.head.position.y = 0.70;
    const neck = makeMesh(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 6), SKIN);
    this.head.add(neck);
    const skull = makeMesh(new THREE.SphereGeometry(0.125, 10, 8), SKIN);
    skull.position.y = 0.13;
    this.head.add(skull);
    const helmet = makeMesh(new THREE.SphereGeometry(0.145, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.62), HELMET);
    helmet.position.y = 0.14;
    this.head.add(helmet);
    const goggles = makeMesh(new THREE.BoxGeometry(0.235, 0.085, 0.06), LENS,
      { emissive: 0x0d3c66, emissiveIntensity: 1.3, roughness: 0.15, metalness: 0.6 });
    goggles.position.set(0, 0.135, -0.115);
    this.head.add(goggles);
    const strap = makeMesh(new THREE.BoxGeometry(0.30, 0.05, 0.02), 0x232a31);
    strap.position.set(0, 0.14, 0.115);
    this.head.add(strap);
    this.torso.add(this.head);

    this.arms = [];
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.27, 0.52, 0);
      const upperArm = makeMesh(new THREE.BoxGeometry(0.12, 0.30, 0.13), JACKET);
      upperArm.position.y = -0.15;
      arm.add(upperArm);
      const fore = new THREE.Group();
      fore.position.y = -0.30;
      const foreMesh = makeMesh(new THREE.BoxGeometry(0.11, 0.28, 0.12), JACKET_DARK);
      foreMesh.position.y = -0.14;
      fore.add(foreMesh);
      const glove = makeMesh(new THREE.BoxGeometry(0.105, 0.11, 0.13), 0x2b3138);
      glove.position.y = -0.30;
      fore.add(glove);
      const pole = makePole();
      pole.position.set(side * 0.02, -0.30, 0);
      fore.add(pole);
      arm.add(fore);
      arm.userData = { fore, pole, side };
      this.torso.add(arm);
      this.arms.push(arm);
    }

    this.upper.add(this.torso);

    // internal animation state
    this.a = { edge: 0, brake: 0, tuck: 0, flex: 0, air: 0, plant: 0, tumble: 0 };
  }

  get group() { return this.root; }

  /** World position of a ski tail, used to emit snow spray. */
  skiTailWorld(index, out = new THREE.Vector3()) {
    return this.skis[index].localToWorld(out.set(0, 0.02, 0.75));
  }

  /**
   * @param {object} s  { edge, brake, tuck, airborne, crash, speedRatio, spin, terrainRoll }
   */
  update(dt, s) {
    const a = this.a;
    a.edge = damp(a.edge, clamp(s.edge, -1, 1), 9, dt);
    a.brake = damp(a.brake, s.brake ? 1 : 0, 10, dt);
    a.tuck = damp(a.tuck, s.tuck && !s.airborne ? 1 : 0, 7, dt);
    a.air = damp(a.air, s.airborne ? 1 : 0, 12, dt);

    const carving = Math.abs(a.edge);
    // Deeper knee flex when carving hard, braking, or tucked; extended in the air.
    const flexTarget = clamp(0.25 + carving * 0.45 + a.brake * 0.35 + a.tuck * 0.5 - a.air * 0.4, 0, 1);
    a.flex = damp(a.flex, flexTarget, 8, dt);

    // ---- body lean: into the turn, forward when tucked
    this.lean.rotation.z = -a.edge * (0.30 + 0.12 * (s.speedRatio ?? 0)) * (1 - a.air * 0.55);
    this.lean.rotation.x = lerp(0, -0.10, a.flex);
    this.torso.rotation.x = -(0.10 + a.tuck * 0.62 + a.brake * 0.10) + a.air * 0.12;
    this.torso.rotation.y = a.edge * 0.22 * (1 - a.air);      // shoulders stay down the fall line
    this.torso.rotation.z = a.edge * 0.10;
    this.head.rotation.y = -a.edge * 0.30;
    this.head.rotation.x = a.tuck * 0.35;

    // ---- legs
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const leg = this.legs[i];
      const thigh = leg.userData.thigh;
      const spread = 0.17 + a.brake * 0.14 + carving * 0.03;
      leg.position.x = side * spread + a.edge * 0.05;
      leg.position.y = 0.40 - a.flex * 0.16;
      leg.rotation.x = a.flex * 0.42;
      leg.rotation.z = -a.edge * 0.10;
      thigh.rotation.x = -a.flex * 0.78 - a.tuck * 0.25;
      // outside leg carries the load: it extends, inside leg folds
      const load = side === Math.sign(a.edge || 1) ? -1 : 1;
      thigh.rotation.x += load * carving * 0.12;
    }

    // ---- skis: parallel stance, on edge; A-frame when snowplowing
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const ski = this.skis[i];
      const spread = 0.17 + a.brake * 0.17 + a.air * -0.06 + carving * 0.02;
      ski.position.x = side * spread + a.edge * 0.05;
      ski.position.y = 0.02 + a.air * 0.03;
      ski.position.z = a.brake * 0.05 + (side === Math.sign(a.edge || 1) ? carving * 0.05 : -carving * 0.05);
      // snowplow: tips converge (tip is local -Z, so left ski needs negative yaw)
      ski.rotation.y = -side * a.brake * 0.34 + a.edge * 0.06;
      // edge angle — both skis roll together, that is what makes it a carve
      ski.rotation.z = -a.edge * (0.55 + 0.25 * (s.speedRatio ?? 0)) - side * a.brake * 0.16;
      ski.rotation.x = a.air * -0.16 + a.flex * 0.05;
    }

    // ---- pole plant: the inside pole reaches down and forward through the turn
    a.plant = damp(a.plant, carving > 0.35 && !s.airborne ? 1 : 0, 11, dt);
    for (const arm of this.arms) {
      const inside = arm.userData.side === Math.sign(a.edge || 1) ? 0 : 1;
      const planting = inside ? a.plant : 0;
      arm.rotation.x = -0.32 - a.tuck * 0.55 + planting * 0.55 + a.air * 0.25;
      arm.rotation.z = arm.userData.side * (0.28 + a.tuck * -0.14 + a.air * 0.35) - a.edge * 0.12;
      arm.userData.fore.rotation.x = -0.55 + a.tuck * -0.40 - planting * 0.45;
      arm.userData.pole.rotation.x = 1.15 - planting * 1.55 + a.tuck * 0.55;
    }

    // ---- crash tumble
    if (s.crash > 0) {
      a.tumble += dt * (6 + 8 * (s.speedRatio ?? 0));
      this.lean.rotation.z = Math.sin(a.tumble) * 0.9;
      this.lean.rotation.x = -0.4 + Math.sin(a.tumble * 0.8) * 0.6;
      this.torso.rotation.x = -1.0;
    } else {
      a.tumble = 0;
    }

    // ---- airborne spin is applied by the game on root.rotation.y
    this.root.rotation.x = damp(this.root.rotation.x, s.terrainPitch ?? 0, 8, dt);
    this.root.rotation.z = damp(this.root.rotation.z, (s.terrainRoll ?? 0) * 0.5, 6, dt);
  }
}
