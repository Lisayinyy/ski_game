import * as THREE from 'three';
import { Terrain } from './terrain.js';
import { World } from './world.js';
import { Skier } from './skier.js';
import { SkiPhysics } from './physics.js';
import { Snowfall, Spray, Trails, createComposer, tuneGrade } from './fx.js';
import { Controls } from './controls.js';
import { Audio } from './audio.js';
import { UI, medalFor } from './ui.js';
import { resortById, RESORTS } from './resorts.js';
import { clamp, damp, lerp } from './util.js';

const COMBO_WINDOW = 4.2;

export class Game {
  constructor(host) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 2400);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    const { composer, grade } = createComposer(this.renderer, this.scene, this.camera);
    this.composer = composer;
    this.grade = grade;

    this.ui = new UI();
    this.controls = new Controls();
    this.audio = new Audio();

    this.mode = 'title';
    this.resort = RESORTS[0];
    this.time = 0;
    this.runTime = 0;
    this.camYaw = 0;
    this.tmp = new THREE.Vector3();
    this.tmp2 = new THREE.Vector3();

    this.bindUI();
    this.loadResort(RESORTS[0].id, { preview: true });
    this.ui.setScreen('title');

    addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.mode === 'run') this.pause(true);
    });

    this.exposeTestHooks();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  /* ------------------------------------------------------------------ ui */

  bindUI() {
    const el = (id) => document.getElementById(id);
    const c = this.controls;

    this.ui.onPick = (id) => {
      this.loadResort(id, { preview: true });
      this.ui.showBrief(this.resort);
    };

    c.bindTap(el('btn-start'), () => this.startRun());
    c.bindTap(el('btn-back'), () => this.ui.setScreen('title'));
    c.bindTap(el('btn-retry'), () => this.startRun());
    c.bindTap(el('btn-pick-other'), () => { this.ui.fillResorts(); this.ui.setScreen('title'); });
    c.bindTap(el('btn-resume'), () => this.pause(false));
    c.bindTap(el('btn-quit'), () => { this.mode = 'title'; this.ui.fillResorts(); this.ui.setScreen('title'); });
    c.bindTap(el('btn-pause'), () => this.pause(this.mode === 'run'));
    c.bindTap(el('btn-line'), () => this.toggleLine());
    c.bindTap(el('btn-mute'), () => {
      const m = !this.audio.muted;
      this.audio.setMuted(m);
      el('btn-mute').textContent = m ? '🔇' : '🔊';
    });

    c.bindHold(el('btn-left'), 'left');
    c.bindHold(el('btn-right'), 'right');
    c.bindHold(el('btn-brake'), 'brake');
    c.bindHold(el('btn-tuck'), 'tuck');
    c.bindHold(el('btn-spin'), 'spinR');
    c.bindTap(el('btn-jump'), () => c.queueJump(), 'jump');

    c.onPause = () => { if (this.mode === 'run' || this.mode === 'paused') this.pause(this.mode === 'run'); };
    c.onRestart = () => { if (this.mode === 'run' || this.mode === 'results') this.startRun(); };
    c.onToggleLine = () => this.toggleLine();
  }

  /** Show/hide the optimal-line ribbon and keep the toggle button in sync. */
  toggleLine(on) {
    const vis = this.world ? this.world.setLineVisible(on) : true;
    const btn = document.getElementById('btn-line');
    if (btn) btn.classList.toggle('is-active', vis);
    return vis;
  }

  /* -------------------------------------------------------------- loading */

  loadResort(id, { preview = false } = {}) {
    const resort = resortById(id);
    this.teardownWorld();
    this.resort = resort;
    this.scene.fog = new THREE.Fog(resort.palette.fog, resort.palette.fogNear, resort.palette.fogFar);
    // Fallback clear colour = the sky's mid tone. The sky dome normally covers the frame, but
    // at a low sun angle with a high FOV the very top of the dome can fall behind the far plane
    // for a sliver; without a background that sliver reads as a hard black triangle. Painting
    // the clear colour with the sky mid keeps any gap indistinguishable from the sky.
    {
      const t = resort.palette.skyTop;
      this.scene.background = new THREE.Color(t[0], t[1], t[2]);
    }
    this.renderer.toneMappingExposure = resort.palette.exposure;

    this.terrain = new Terrain(this.scene, resort);
    this.world = new World(this.scene, resort, this.terrain);
    this.skier = new Skier(this.scene);
    this.physics = new SkiPhysics(this.terrain, resort);
    this.snowfall = new Snowfall(this.scene, resort);
    this.spray = new Spray(this.scene);
    this.trails = new Trails(this.scene, Math.ceil(resort.run.lengthM / 0.55) + 200);

    this.terrain.update(this.physics.z);
    this.world.update(this.physics, this.camera, 0);
    this.physics.kickers = this.world.kickers;

    this.resetRunState();
    this.placeSkier();
    this.snapCamera();
    this.preview = preview;
  }

  teardownWorld() {
    this.snowfall?.dispose();
    this.spray?.dispose();
    this.trails?.dispose();
    this.world?.dispose();
    this.terrain?.dispose();
    if (this.skier) this.scene.remove(this.skier.root);
    this.skier = null;
  }

  resetRunState() {
    this.runTime = 0;
    this.score = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.gatesHit = 0;
    this.gatesSeen = 0;
    this.prevZ = this.physics.z;
    this.finished = false;
    this.introTimer = 0;
  }

  /* ----------------------------------------------------------- lifecycle */

  startRun() {
    this.audio.resume();
    this.loadResort(this.resort.id);
    this.preview = false;
    this.mode = 'run';
    this.introTimer = 0.9;
    this.spray.clear();
    this.trails.clear();
    this.ui.setScreen('run');
    this.ui.toast('GO!', 'go');
    this.audio.start();
    document.getElementById('run-label').textContent = `${this.resort.name} · ${this.resort.run.name}`;
  }

  pause(on) {
    if (on && this.mode === 'run') {
      this.mode = 'paused';
      this.controls.releaseAll();
      this.ui.setScreen('pause');
    } else if (!on && this.mode === 'paused') {
      this.mode = 'run';
      this.ui.setScreen('run');
    }
  }

  finishRun() {
    if (this.finished) return;
    this.finished = true;
    this.mode = 'results';
    const st = this.physics.stats;
    // end-of-run bonuses
    const timeBonus = Math.max(0, Math.round((this.resort.run.parSec * 1.4 - this.runTime) * 40));
    const speedBonus = Math.round(st.topSpeed * 12);
    this.score += timeBonus + speedBonus;
    const medal = medalFor(this.resort, this.runTime, this.gatesHit, this.gatesSeen, st.crashes);
    this.audio.finish();
    this.ui.showResults(this.resort, {
      score: this.score, time: this.runTime, medal,
      gatesHit: this.gatesHit, gatesSeen: this.gatesSeen,
      topSpeed: st.topSpeed, vertical: st.vertical,
      airTimeTotal: st.airTimeTotal, bigAir: st.bigAir,
      spins: st.spins, crashes: st.crashes,
      timeBonus, speedBonus,
    });
  }

  /* -------------------------------------------------------------- scoring */

  addScore(points, label) {
    this.score += points * this.combo;
    if (label) this.ui.toast(`${label} +${Math.round(points * this.combo)}`);
  }

  bumpCombo(step = 0.5) {
    this.combo = Math.min(8, this.combo + step);
    this.comboTimer = COMBO_WINDOW;
  }

  breakCombo() {
    this.combo = 1;
    this.comboTimer = 0;
  }

  checkGates() {
    const p = this.physics;
    for (const gate of this.world.gates) {
      if (gate.resolved) continue;
      if (this.prevZ > gate.z && p.z <= gate.z) {
        gate.resolved = true;
        this.gatesSeen++;
        const inside = Math.abs(p.x - gate.x) <= gate.half + 0.5;
        if (inside) {
          gate.passed = true;
          this.gatesHit++;
          this.bumpCombo();
          this.addScore(200, '过门');
          this.audio.gate(this.combo);
          gate.mat.emissiveIntensity = 1.6;
          gate.panel.material.opacity = 0.85;
        } else {
          this.breakCombo();
          this.ui.toast('漏门', 'bad');
          this.audio.miss();
          gate.mat.color.set(0x555f6b);
        }
      }
    }
  }

  checkHazards() {
    const p = this.physics;
    if (p.crash > 0 || p.airborne) return;
    for (const h of this.world.hazardsAround(p.z)) {
      if (Math.abs(h.z - p.z) > 2.2) continue;
      if (Math.abs(h.x - p.x) > h.r + 0.5) continue;
      if (p.crashNow(h.type)) {
        this.breakCombo();
        this.score = Math.max(0, this.score - 150);
        this.ui.toast(h.type === 'tree' ? '撞树了！' : h.type === 'ice' ? '撞上冰塔！' : '撞到岩石！', 'bad');
        this.audio.crash();
        this.grade.uniforms.uFlash.value = 0.32;
      }
      break;
    }
  }

  handleEvents(events) {
    for (const e of events) {
      if (e.type === 'jump' || e.type === 'kicker') {
        this.audio.jump();
        if (e.type === 'kicker') this.ui.toast('起跳！');
      } else if (e.type === 'land') {
        this.audio.land(e.impact);
        this.burstLanding(e.impact);
        if (e.airTime > 0.45) {
          this.addScore(Math.round(e.airTime * 120), `滞空 ${e.airTime.toFixed(1)}s`);
          this.bumpCombo(0.3);
        }
        const rot = Math.floor(e.rotations + 0.25);
        if (rot >= 1) {
          this.addScore(rot * 180, `${rot * 360}° 转体`);
          this.bumpCombo(0.5);
        }
      } else if (e.type === 'crash') {
        this.breakCombo();
      }
    }
  }

  /* ---------------------------------------------------------------- visual */

  placeSkier() {
    const p = this.physics;
    this.skier.root.position.set(p.x, p.y, p.z);
    this.skier.root.rotation.y = p.heading;
  }

  snapCamera() {
    const p = this.physics;
    this.camYaw = p.heading * 0.5;
    this.camera.position.set(p.x + Math.sin(this.camYaw) * 9.5 * -1, p.y + 3.6, p.z + Math.cos(this.camYaw) * 9.5);
    this.camera.lookAt(p.x, p.y + 1.2, p.z - 12);
  }

  updateCamera(dt, speedRatio) {
    const p = this.physics;
    this.camYaw = damp(this.camYaw, p.heading * 0.55, 3.4, dt);
    const dist = 9.0 + speedRatio * 3.4 + (p.crash > 0 ? 2.5 : 0);
    const height = 3.3 + speedRatio * 0.9 + (p.airborne ? 0.6 : 0);
    const bx = -Math.sin(this.camYaw);
    const bz = Math.cos(this.camYaw);
    this.tmp.set(p.x + bx * dist, p.y + height, p.z + bz * dist);
    // don't let the camera sink into the mountain
    const ground = this.terrain.elevation(this.tmp.x, this.tmp.z) + 1.4;
    this.tmp.y = Math.max(this.tmp.y, ground);
    this.camera.position.lerp(this.tmp, 1 - Math.pow(0.0022, dt));

    const fx = Math.sin(p.heading);
    const fz = -Math.cos(p.heading);
    this.tmp2.set(p.x + fx * 13, p.y + 1.3, p.z + fz * 13);
    this.camera.lookAt(this.tmp2);
    this.camera.fov = damp(this.camera.fov, 66 + speedRatio * 13, 3, dt);
    this.camera.updateProjectionMatrix();
  }

  emitSpray(dt, input) {
    const p = this.physics;
    if (p.airborne || p.speed < 2.0) return;
    const edge = Math.abs(p.edge);
    // Only a genuinely HARD carve throws a plume. Small steering corrections must stay clear
    // so they never block the view of the piste ahead. Below the dead-zone the carve
    // contributes nothing; past it, it ramps up fast. Deep powder and braking still spray
    // (those are expected and don't sit in front of the camera the same way).
    const CARVE_DEADZONE = 0.62;
    const hardCarve = edge > CARVE_DEADZONE
      ? (edge - CARVE_DEADZONE) / (1 - CARVE_DEADZONE)   // 0..1 past the dead-zone
      : 0;
    const intensity = hardCarve * 1.9 + p.offPiste * 1.4 + (input.brake ? 1.1 : 0);
    if (intensity < 0.12) return;
    const count = Math.min(22, Math.floor((0.4 + intensity) * p.speed * dt * 5.0));
    if (count <= 0) return;
    const dirX = Math.sin(p.heading);
    const dirZ = -Math.cos(p.heading);
    // faster + harder carve => bigger, higher plume
    const power = clamp(intensity * (0.7 + p.speed * 0.06), 0.15, 3.4);
    for (let i = 0; i < count; i++) {
      const side = i % 2;
      this.skier.skiTailWorld(side, this.tmp);
      const back = 0.35 + Math.random() * 0.6;
      this.spray.emit(
        this.tmp.x, this.tmp.y + 0.05, this.tmp.z,
        -dirX * p.speed * back + Math.sign(p.edge || 1) * edge * 4.0,
        1.9 + p.speed * 0.09 + p.offPiste * 3.0 + power * 0.8,
        -dirZ * p.speed * back,
        0.45 + Math.random() * 0.55,
        0.8 + p.offPiste * 1.8,
        0.6 + power * 0.6           // particle base size grows with carve power
      );
    }
  }

  /** One-shot ring of powder kicked up when the skier touches down from a jump. */
  burstLanding(impact) {
    const p = this.physics;
    const puff = clamp(impact * 0.9 + 0.4, 0.5, 2.6);
    const n = Math.round(18 + puff * 16);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1.4 + Math.random() * 2.2;
      this.spray.emit(
        p.x + Math.cos(a) * 0.5, p.y + 0.1, p.z + Math.sin(a) * 0.5,
        Math.cos(a) * r, 2.4 + puff * 1.6 + Math.random() * 2.0, Math.sin(a) * r,
        0.55 + Math.random() * 0.5, 1.4,
        0.75 + puff * 0.5
      );
    }
  }

  /* ------------------------------------------------------------------ loop */

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.034, Math.max(0.0005, (now - this.last) / 1000));
    this.last = now;
    this.time += dt;

    try {
      this.step(dt);
    } catch (err) {
      this.ui.showError(err);
      this.mode = 'error';
    }

    this.composer.render();
  }

  step(dt) {
    const p = this.physics;
    if (!p) return;
    const running = this.mode === 'run';

    if (this.introTimer > 0) this.introTimer = Math.max(0, this.introTimer - dt);

    const input = running
      ? this.controls.read()
      : { steer: 0, brake: false, tuck: false, spin: 0, jump: false };

    if (running) {
      this.prevZ = p.z;
      this.runTime += dt;
      const events = p.step(dt, input);
      this.handleEvents(events);
      this.checkGates();
      this.checkHazards();

      if (this.comboTimer > 0) {
        this.comboTimer -= dt;
        if (this.comboTimer <= 0) this.combo = Math.max(1, this.combo - 0.5);
      }
      if (p.offPiste > 0.5 && p.speed > 8 && !p.airborne) this.score += 14 * dt * this.combo;

      if (p.z <= this.world.finishZ) this.finishRun();
    } else if (this.mode === 'paused' || this.mode === 'results') {
      // hold the world still but keep rendering
    } else {
      // title / brief preview: let the skier idle-glide slowly so the scene is alive
      p.step(dt, { steer: Math.sin(this.time * 0.35) * 0.55, brake: false, tuck: false, spin: 0, jump: false });
      if (p.z < -140) { p.reset(); this.trails.clear(); this.spray.clear(); }
    }

    const speedRatio = clamp(p.speed / this.resort.physics.maxSpeed, 0, 1);

    this.terrain.update(p.z);
    this.world.update(p, this.camera, this.time);
    this.physics.kickers = this.world.kickers;

    // ---- skier rig
    this.skier.root.position.set(p.x, p.y, p.z);
    this.skier.root.rotation.y = p.heading + p.spin;
    this.skier.update(dt, {
      edge: p.edge,
      brake: input.brake,
      tuck: input.tuck,
      airborne: p.airborne,
      crash: p.crash,
      speedRatio,
      terrainPitch: p.terrainPitch,
      terrainRoll: p.terrainRoll,
    });

    if (!p.airborne && p.speed > 2 && p.crash <= 0) {
      this.trails.push(p.x, p.y, p.z, p.heading, 0.075);
    }
    this.emitSpray(dt, input);
    this.spray.update(dt);
    this.snowfall.update(dt, this.camera.position, this.time);

    this.updateCamera(dt, speedRatio);
    tuneGrade(this.grade, speedRatio, dt);
    this.grade.uniforms.uTime.value = this.time;
    this.audio.ambience(speedRatio, Math.abs(p.edge), p.offPiste);

    if (running || this.mode === 'paused') {
      this.ui.updateHud({
        speedKmh: p.speed * 3.6,
        vertical: p.stats.vertical,
        time: this.runTime,
        score: this.score,
        combo: this.combo,
        gatesHit: this.gatesHit,
        gatesSeen: this.gatesSeen,
        progress: clamp(-p.z / this.resort.run.lengthM, 0, 1),
        airborne: p.airborne,
        airTime: p.airTime,
        offPiste: p.offPiste,
      });
    }
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
  }

  /* ------------------------------------------------------- test/debug hooks */

  exposeTestHooks() {
    const self = this;
    window.__SKI__ = {
      resorts: () => RESORTS.map((r) => r.id),
      select: (id) => { self.ui.pick(id); },
      start: () => self.startRun(),
      pause: (on) => self.pause(on),
      press: (name) => self.controls.setHeld(name, true),
      release: (name) => self.controls.setHeld(name, false),
      jump: () => self.controls.queueJump(),
      clickButton: (id) => {
        const el = document.getElementById(id);
        if (!el) return false;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
        return true;
      },
      releaseButton: (id) => {
        const el = document.getElementById(id);
        if (!el) return false;
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
        return true;
      },
      state: () => ({
        mode: self.mode,
        resort: self.resort.id,
        x: self.physics.x, y: self.physics.y, z: self.physics.z,
        speed: self.physics.speed, heading: self.physics.heading, edge: self.physics.edge,
        airborne: self.physics.airborne, crash: self.physics.crash,
        offPiste: self.physics.offPiste,
        score: self.score, combo: self.combo,
        gatesHit: self.gatesHit, gatesSeen: self.gatesSeen,
        runTime: self.runTime, vertical: self.physics.stats.vertical,
        finishZ: self.world.finishZ,
        runLength: self.resort.run.lengthM,
        progress: clamp(-self.physics.z / self.resort.run.lengthM, 0, 1),
      }),
      /**
       * Advance the simulation in deterministic fixed steps without waiting on rAF.
       * Headless software rendering only manages a few FPS, and the loop clamps dt to avoid
       * tunnelling, so wall-clock waiting is useless for verifying physics.
       */
      simulate: (seconds, step = 1 / 60) => {
        const n = Math.max(1, Math.round(seconds / step));
        for (let i = 0; i < n; i++) self.step(step);
        return self.mode;
      },
      /** Line the skier up just above the next unresolved gate, centred on it. */
      aimNextGate: () => {
        const gates = self.world.gates
          .filter((g) => !g.resolved && g.z < self.physics.z - 6)
          .sort((a, b) => b.z - a.z);
        const g = gates[0];
        if (!g) return null;
        const p = self.physics;
        p.z = g.z + 5;
        p.x = g.x;
        p.y = self.terrain.elevation(p.x, p.z);
        p.heading = 0;
        p.edge = 0;
        self.prevZ = p.z;
        return { x: g.x, z: g.z, half: g.half };
      },
      sceneStats: () => {
        let meshes = 0; let triangles = 0; let points = 0;
        self.scene.traverse((o) => {
          if (o.isPoints) points++;
          if (!o.isMesh || !o.geometry) return;
          meshes++;
          const g = o.geometry;
          if (g.index) triangles += g.index.count / 3;
          else if (g.attributes.position) triangles += g.attributes.position.count / 3;
        });
        return { meshes, points, triangles: Math.round(triangles), gates: self.world.gates.length, kickers: self.world.kickers.length };
      },
      teleport: (z) => {
        const p = self.physics;
        p.z = z;
        p.x = self.terrain.centerX(z);
        p.y = self.terrain.elevation(p.x, p.z);
        self.prevZ = z + 1;
      },
      /** Escape hatch for visual QA: renderer / scene / world / terrain internals. */
      dev: () => self,
      /**
       * Drive the run using nothing but the turn buttons, steering back toward the piste
       * centre. Doubles as proof that the button-only control scheme can actually hold a
       * line, and keeps QA screenshots on the groomed snow instead of in the trees.
       */
      autopilot: (seconds, step = 1 / 60) => {
        const n = Math.max(1, Math.round(seconds / step));
        let held = null;
        for (let i = 0; i < n; i++) {
          const p = self.physics;
          const aim = self.terrain.centerX(p.z - Math.max(8, p.speed * 1.1));
          const err = p.x - aim;
          const want = err > 1.6 ? 'left' : err < -1.6 ? 'right' : null;
          if (want !== held) {
            if (held) self.controls.setHeld(held, false);
            if (want) self.controls.setHeld(want, true);
            held = want;
          }
          self.step(step);
          if (self.mode !== 'run') break;
        }
        if (held) self.controls.setHeld(held, false);
        const p = self.physics;
        return {
          x: p.x, center: self.terrain.centerX(p.z), offPiste: p.offPiste,
          speed: p.speed, mode: self.mode,
        };
      },
      /** Toggle / set the optimal-line ribbon; returns resulting visibility. */
      toggleLine: (on) => self.toggleLine(on),
      /**
       * Verify the ideal line actually threads the gates: for every gate, find the closest
       * point on the precomputed spline and report the worst lateral miss. A good line keeps
       * every gate within its half-width.
       */
      lineInfo: () => {
        const w = self.world;
        if (!w || !w.idealCurve) return { present: false };
        const pts = [];
        const N = 600;
        for (let i = 0; i <= N; i++) pts.push(w.idealCurve.getPoint(i / N));
        let worst = 0; let count = 0;
        for (const g of w.gates) {
          let best = Infinity;
          for (const q of pts) {
            if (Math.abs(q.z - g.z) > 6) continue;
            const d = Math.abs(q.x - g.x);
            if (d < best) best = d;
          }
          if (best === Infinity) continue;
          count++;
          if (best > worst) worst = best;
        }
        return {
          present: true, visible: !!w.lineVisible,
          gatesChecked: count, worstMissM: +worst.toFixed(2),
          planPoints: w.idealLinePts ? w.idealLinePts.length : 0,
        };
      },
      /** Sample mogul intensity + surface height along the run centre (bump-field probe). */
      mogulProfile: (samples = 40) => {
        const t = self.terrain; const L = self.resort.run.lengthM;
        const out = [];
        for (let i = 0; i <= samples; i++) {
          const z = -(i / samples) * L;
          const x = t.centerX(z);
          out.push({
            p: +(i / samples).toFixed(3),
            m: +(t.mogulIntensity ? t.mogulIntensity(x, z) : 0).toFixed(3),
            y: +t.elevation(x, z).toFixed(2),
          });
        }
        return out;
      },
    };
    window.__SKI_READY__ = true;
  }
}

export { lerp };
