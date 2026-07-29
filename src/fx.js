import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clamp } from './util.js';

/* ---------------------------------------------------------- soft dot sprite */

let dotTexture = null;
function softDot() {
  if (dotTexture) return dotTexture;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.75)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  dotTexture = new THREE.CanvasTexture(c);
  return dotTexture;
}

/* ------------------------------------------------------------- snowfall */

export class Snowfall {
  constructor(scene, resort) {
    const w = resort.weather;
    this.count = w.snowfall;
    this.wind = w.wind;
    this.drift = w.drift;
    this.spanXZ = 90;
    this.spanY = 46;

    const pos = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.spanXZ;
      pos[i * 3 + 1] = Math.random() * this.spanY;
      pos[i * 3 + 2] = (Math.random() - 0.5) * this.spanXZ;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      // sizeAttenuation makes the nearest flakes enormous; at *6 a Niseko powder day
      // turned into a screen full of white bokeh discs.
      map: softDot(), color: 0xffffff, size: w.flakeSize * 3.4,
      transparent: true, opacity: 0.62, depthWrite: false,
      sizeAttenuation: true, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.origin = new THREE.Vector3();
  }

  update(dt, focus, time) {
    this.points.position.set(focus.x, focus.y - 6, focus.z - 18);
    const arr = this.points.geometry.attributes.position.array;
    const fall = this.drift;
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      arr[j + 1] -= fall * dt;
      arr[j] += Math.sin(time * 0.7 + i * 0.13) * this.wind * dt * 5;
      arr[j + 2] += this.wind * dt * 3;
      if (arr[j + 1] < -4) {
        arr[j] = (Math.random() - 0.5) * this.spanXZ;
        arr[j + 1] = this.spanY;
        arr[j + 2] = (Math.random() - 0.5) * this.spanXZ;
      }
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.points.parent?.remove(this.points);
  }
}

/* ---------------------------------------------------------------- spray */

/** Snow thrown up by the edges — the visual payoff of a hard carve or a powder turn. */
export class Spray {
  constructor(scene, max = 1400) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.size = new Float32Array(max);
    this.head = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      map: softDot(), color: 0xf2fbff, size: 0.34,
      transparent: true, opacity: 0.9, depthWrite: false,
      sizeAttenuation: true, blending: THREE.AdditiveBlending,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -9999;
  }

  emit(x, y, z, vx, vy, vz, life, spread) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx + (Math.random() - 0.5) * spread;
    this.vel[i * 3 + 1] = vy + Math.random() * spread * 0.7;
    this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * spread;
    this.life[i] = life;
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      this.vel[j + 1] -= 7.5 * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.life[i] <= 0) this.pos[j + 1] = -9999;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.max; i++) { this.life[i] = 0; this.pos[i * 3 + 1] = -9999; }
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.points.parent?.remove(this.points);
  }
}

/* --------------------------------------------------------------- trails */

/** Two carved grooves in the snow, one per ski. */
export class Trails {
  constructor(scene, maxSamples = 4200) {
    this.maxSamples = maxSamples;
    this.tracks = [];
    const mat = new THREE.MeshBasicMaterial({
      color: 0x8fb6d8, transparent: true, opacity: 0.38,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.material = mat;
    for (let k = 0; k < 2; k++) {
      const positions = new Float32Array(maxSamples * 2 * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const idx = new Uint32Array((maxSamples - 1) * 6);
      for (let i = 0; i < maxSamples - 1; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx[i * 6] = a; idx[i * 6 + 1] = c; idx[i * 6 + 2] = b;
        idx[i * 6 + 3] = b; idx[i * 6 + 4] = c; idx[i * 6 + 5] = d;
      }
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.setDrawRange(0, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      scene.add(mesh);
      this.tracks.push({ mesh, positions, count: 0 });
    }
    this.lastX = null;
    this.lastZ = null;
  }

  /** Called every frame; samples the track every ~0.55 m. */
  push(x, y, z, heading, width) {
    if (this.lastX !== null) {
      const d = Math.hypot(x - this.lastX, z - this.lastZ);
      if (d < 0.55) return;
    }
    this.lastX = x; this.lastZ = z;
    const rx = Math.cos(heading);
    const rz = Math.sin(heading);
    const offsets = [-0.17, 0.17];
    for (let k = 0; k < 2; k++) {
      const tr = this.tracks[k];
      if (tr.count >= this.maxSamples) continue;
      const cx = x + rx * offsets[k];
      const cz = z + rz * offsets[k];
      const i = tr.count * 6;
      tr.positions[i] = cx - rx * width; tr.positions[i + 1] = y + 0.035; tr.positions[i + 2] = cz - rz * width;
      tr.positions[i + 3] = cx + rx * width; tr.positions[i + 4] = y + 0.035; tr.positions[i + 5] = cz + rz * width;
      tr.count++;
      tr.mesh.geometry.attributes.position.needsUpdate = true;
      tr.mesh.geometry.setDrawRange(0, Math.max(0, (tr.count - 1) * 6));
    }
  }

  clear() {
    this.lastX = null;
    for (const tr of this.tracks) {
      tr.count = 0;
      tr.mesh.geometry.setDrawRange(0, 0);
    }
  }

  dispose() {
    for (const tr of this.tracks) {
      tr.mesh.geometry.dispose();
      tr.mesh.parent?.remove(tr.mesh);
    }
    this.material.dispose();
  }
}

/* ---------------------------------------------------------- postprocess */

export function createComposer(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
    // Snow legitimately sits near the top of the range, so the bloom threshold has to be
  // high or the entire frame turns into a white haze.
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.16, 0.5, 0.95));

  const grade = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uSpeed: { value: 0 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float uSpeed, uTime, uFlash;
      varying vec2 vUv;
      void main(){
        vec2 c = vUv - 0.5;
        float r = length(c);
        // radial speed smear that ramps up with velocity
        float amt = uSpeed * 0.020;
        vec3 col = vec3(0.0);
        col += texture2D(tDiffuse, vUv).rgb * 0.55;
        col += texture2D(tDiffuse, vUv - c * amt * 0.5).rgb * 0.25;
        col += texture2D(tDiffuse, vUv - c * amt).rgb * 0.20;
        // slight chromatic separation at the edges
        float ca = uSpeed * 0.0016 * r;
        col.r = mix(col.r, texture2D(tDiffuse, vUv + c * ca).r, 0.6);
        col.b = mix(col.b, texture2D(tDiffuse, vUv - c * ca).b, 0.6);
        // vignette + a *restrained* alpine cool: too much of this and sunlit snow
        // turns into grey-blue concrete
        col *= 1.0 - smoothstep(0.42, 0.92, r) * 0.20;
        col = mix(col, col * vec3(0.985, 1.0, 1.028), 0.20);
        // gentle S-curve so the snow keeps some sparkle and the shadows stay blue
        col = clamp((col - 0.5) * 1.075 + 0.5 + 0.018, 0.0, 1.0);
        col += uFlash * vec3(1.0, 0.96, 0.9);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  composer.addPass(grade);
  composer.addPass(new OutputPass());
  return { composer, grade };
}

export function tuneGrade(grade, speedRatio, dt) {
  const u = grade.uniforms;
  u.uSpeed.value += (clamp(speedRatio, 0, 1) * 1.0 - u.uSpeed.value) * Math.min(1, dt * 4);
  u.uFlash.value = Math.max(0, u.uFlash.value - dt * 2.2);
}
