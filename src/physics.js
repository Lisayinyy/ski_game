import { clamp, damp } from './util.js';

const G = 9.81;
// How far across the fall line you can point the skis. Wide enough to traverse and control
// speed, tight enough that holding a turn button carves instead of stalling you sideways.
const MAX_HEADING = 0.95;
const CRASH_LOCK = 1.35;

/**
 * SkiPhysics — a compact but genuinely physical alpine ski model.
 *
 * The core loop is the real thing that makes skiing feel like skiing:
 *   accel = g·sinθ·cos(heading) − μ·g·cosθ − k·v²
 * Turning away from the fall line (large |heading|) cuts the gravity term, so a carve costs
 * you speed and pointing them straight down (schuss) gains it. Snowplow (犁式) adds a big
 * friction term; deep off-piste snow adds both friction and drag.
 */
export class SkiPhysics {
  constructor(terrain, resort) {
    this.terrain = terrain;
    this.resort = resort;
    this.p = resort.physics;
    this.kickers = [];
    this.reset();
  }

  reset() {
    const t = this.terrain;
    this.z = -6;
    this.x = t.centerX(this.z);
    this.y = t.elevation(this.x, this.z);
    this.speed = 4.5;
    this.heading = 0;
    this.edge = 0;
    this.vy = 0;
    this.airborne = false;
    this.airTime = 0;
    this.spin = 0;
    this.spinAccum = 0;
    this.crash = 0;
    this.crashKind = null;
    this.grounded = true;
    this.onRampPrev = null;
    this.stats = {
      topSpeed: 0, airTimeTotal: 0, bigAir: 0, spins: 0,
      powderTime: 0, crashes: 0, vertical: 0,
    };
    this.startY = this.y;
    this.events = [];
  }

  /** Extra height contributed by a terrain-park kicker at a point, plus ramp progress. */
  rampAt(x, z) {
    for (const k of this.kickers) {
      if (Math.abs(x - k.x) > k.halfWidth) continue;
      if (z <= k.z && z >= k.lipZ) {
        const f = clamp((k.z - z) / k.len, 0, 1);
        return { h: Math.pow(f, 1.7) * k.rise, f, kicker: k };
      }
    }
    return { h: 0, f: 0, kicker: null };
  }

  groundHeight(x, z) {
    return this.terrain.elevation(x, z) + this.rampAt(x, z).h;
  }

  crashNow(kind) {
    if (this.crash > 0) return false;
    this.crash = CRASH_LOCK;
    this.crashKind = kind;
    this.speed *= 0.28;
    this.airborne = false;
    this.vy = 0;
    this.stats.crashes++;
    this.events.push({ type: 'crash', kind });
    return true;
  }

  step(dt, rawInput) {
    this.events.length = 0;
    const t = this.terrain;
    const p = this.p;

    const crashed = this.crash > 0;
    if (crashed) this.crash = Math.max(0, this.crash - dt);

    const input = crashed
      ? { steer: 0, brake: true, tuck: false, jump: false, spin: 0 }
      : rawInput;

    const dirX = Math.sin(this.heading);
    const dirZ = -Math.cos(this.heading);

    this.edge = damp(this.edge, clamp(input.steer, -1, 1), 8.5, dt);

    const off = t.offPiste(this.x, this.z);
    const brake = input.brake ? 1 : 0;
    const tuck = input.tuck && !this.airborne ? 1 : 0;

    const grad = t.gradient(this.x, this.z, dirX, dirZ, 2.5);
    const inv = 1 / Math.sqrt(1 + grad * grad);
    const sinT = -grad * inv;   // > 0 when the ground falls away ahead
    const cosT = inv;

    if (!this.airborne) {
      // ---- mogul field: bumps scrub speed unless you absorb them (slower = smoother).
      // The vertical chatter is already there because `y` tracks the bumpy `elevation()`;
      // this adds the felt drag so a fast straight-line through moguls actually costs you.
      const bump = t.mogulIntensity ? t.mogulIntensity(this.x, this.z) : 0;
      const mogulTax = bump * (t.mogulField?.speedTax || 0);

      // ---- longitudinal dynamics
      let mu = 0.042 / p.grip + off * 0.085;
      mu += Math.abs(this.edge) * 0.032;                       // edge scrub / skidding
      mu += mogulTax * 0.11;                                    // pounding through bumps
      const drag = p.drag * (tuck ? 0.56 : 1) * (1 + off * 0.45);
      let acc = G * sinT * Math.cos(this.heading) - mu * G * cosT - drag * this.speed * this.speed;
      acc -= (off * this.speed) / Math.max(1, p.deepDrag) * 0.5;
      // faster you charge a bump field, the more it slows you (unless you brake/absorb)
      acc -= mogulTax * this.speed * 0.06 * (1 - 0.5 * brake);
      // A wedge is not just extra friction — it is an authoritative brake. It has to be able
      // to hold speed on a black run, otherwise button-only play has no speed control.
      if (brake) acc -= p.brake * 9.2 * clamp(this.speed / 3, 0, 1);
      this.speed = Math.max(0, this.speed + acc * dt);

      // ---- turning: carve radius grows with speed, snowplow pivots faster
      const sr = clamp(this.speed / p.maxSpeed, 0, 1);
      let yawRate = this.edge * p.carve * (1 - 0.42 * sr) * (0.45 + 0.55 * clamp(this.speed / 7, 0, 1));
      if (brake) yawRate *= 1.55;
      yawRate *= 1 - off * 0.3;
      this.heading = clamp(this.heading + yawRate * dt, -MAX_HEADING, MAX_HEADING);
      // With no steering input gravity pulls the skis back toward the fall line.
      if (Math.abs(input.steer) < 0.06) this.heading = damp(this.heading, 0, 1.15, dt);

      // ---- ground tracking / natural air off rollers and lips
      const gy = this.groundHeight(this.x, this.z);
      this.y = damp(this.y, gy, 26, dt);
      this.spin = damp(this.spin, 0, 9, dt);

      if (input.jump) {
        this.vy = 4.3 + this.speed * 0.075;
        this.airborne = true;
        this.airTime = 0;
        this.events.push({ type: 'jump', power: this.vy });
      } else {
        const ramp = this.rampAt(this.x, this.z);
        const wasRamp = this.onRampPrev;
        if (wasRamp && !ramp.kicker && wasRamp.f > 0.55 && this.speed > 8) {
          this.vy = 2.2 + this.speed * 0.30;
          this.airborne = true;
          this.airTime = 0;
          this.events.push({ type: 'kicker', power: this.vy });
        } else if (grad < -0.62 && this.speed > 13) {
          this.vy = 1.1;
          this.airborne = true;
          this.airTime = 0;
        }
        this.onRampPrev = ramp.kicker ? ramp : null;
      }
      if (this.airborne) this.onRampPrev = null;

      if (off > 0.4) this.stats.powderTime += dt * off;
    } else {
      // ---- flight
      this.vy -= G * 1.18 * dt;
      this.y += this.vy * dt;
      this.airTime += dt;
      this.stats.airTimeTotal += dt;
      this.speed = Math.max(0, this.speed - p.drag * 0.35 * this.speed * this.speed * dt);
      if (input.spin) {
        const rate = 5.6 * input.spin;
        this.spin += rate * dt;
        this.spinAccum += Math.abs(rate) * dt;
      }
      const gy = this.groundHeight(this.x, this.z);
      if (this.y <= gy) {
        this.y = gy;
        this.airborne = false;
        const impact = -this.vy;
        const rotations = this.spinAccum / (Math.PI * 2);
        this.events.push({ type: 'land', airTime: this.airTime, impact, rotations });
        if (this.airTime > this.stats.bigAir) this.stats.bigAir = this.airTime;
        this.stats.spins += Math.floor(rotations + 0.28);
        // Landing sideways or from very high hurts.
        const sideways = Math.abs(((this.spin % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - 0) > 0.9
          && Math.abs(((this.spin % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI * 2) > 0.9;
        if (impact > 13.5 || (sideways && impact > 8)) {
          this.crashNow(impact > 13.5 ? 'hard-landing' : 'off-axis');
        } else {
          this.speed *= 0.94;
        }
        this.vy = 0;
        this.spinAccum = 0;
      }
    }

    // ---- integrate horizontally
    this.x += dirX * this.speed * dt;
    this.z += dirZ * this.speed * dt;

    // keep inside the generated terrain strip
    const cx = t.centerX(this.z);
    const limit = this.resort.terrain.width / 2 - 6;
    this.x = clamp(this.x, cx - limit, cx + limit);

    // ---- bookkeeping
    if (this.speed > this.stats.topSpeed) this.stats.topSpeed = this.speed;
    this.stats.vertical = Math.max(0, this.startY - this.y);

    // orientation helpers for the visual rig
    this.terrainPitch = Math.atan(grad);
    const latGrad = (t.elevation(this.x + 1.2, this.z) - t.elevation(this.x - 1.2, this.z)) / 2.4;
    this.terrainRoll = Math.atan(latGrad);
    this.offPiste = off;
    this.mogul = t.mogulIntensity ? t.mogulIntensity(this.x, this.z) : 0;
    return this.events;
  }
}
