import { clamp } from './util.js';

/**
 * Controls — button-first input.
 *
 * The on-screen deck is the PRIMARY control scheme (visible on desktop and touch alike),
 * with keyboard as an equivalent alias. Every hold button also honours a short "tap" so a
 * single click still produces a usable turn — playing purely by clicking has to feel good.
 */

const TAP_HOLD_MS = 170;

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowDown: 'brake', KeyS: 'brake',
  ShiftLeft: 'tuck', ShiftRight: 'tuck',
  KeyQ: 'spinL', KeyE: 'spinR',
};

export class Controls {
  constructor() {
    this.held = { left: false, right: false, brake: false, tuck: false, spinL: false, spinR: false };
    this.tapUntil = {};
    this.jumpQueued = false;
    this.enabled = true;
    this.buttons = new Map();
    this.onPause = null;
    this.onRestart = null;
    this.onJump = null;

    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.releaseAll());
  }

  onKey(e, down) {
    if (e.repeat && down) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (down) this.queueJump();
      return;
    }
    if (down && e.code === 'KeyP') { this.onPause?.(); return; }
    if (down && e.code === 'KeyR') { this.onRestart?.(); return; }
    const name = KEYMAP[e.code];
    if (!name) return;
    e.preventDefault();
    this.setHeld(name, down);
  }

  queueJump() {
    if (!this.enabled) return;
    this.jumpQueued = true;
    this.flash('jump');
    this.onJump?.();
  }

  setHeld(name, down) {
    if (!this.enabled && down) return;
    this.held[name] = down;
    if (!down) this.tapUntil[name] = this.tapUntil[name] ?? 0;
    this.reflect(name, down);
  }

  /** Register a DOM button as a hold control. */
  bindHold(el, name) {
    if (!el) return;
    this.buttons.set(name, el);
    const down = (ev) => {
      ev.preventDefault();
      // Synthetic / already-released pointers make setPointerCapture throw; never let that
      // swallow the press itself.
      try { el.setPointerCapture?.(ev.pointerId); } catch { /* ignore */ }
      this.tapUntil[name] = performance.now() + TAP_HOLD_MS;
      this.setHeld(name, true);
    };
    const up = (ev) => {
      ev?.preventDefault?.();
      this.setHeld(name, false);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Register a DOM button as a one-shot action. */
  bindTap(el, fn, name) {
    if (!el) return;
    if (name) this.buttons.set(name, el);
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      fn();
      if (name) this.flash(name);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  reflect(name, active) {
    const el = this.buttons.get(name);
    if (el) el.classList.toggle('is-active', !!active);
  }

  flash(name) {
    const el = this.buttons.get(name);
    if (!el) return;
    el.classList.add('is-active');
    setTimeout(() => el.classList.remove('is-active'), 130);
  }

  releaseAll() {
    for (const k of Object.keys(this.held)) this.setHeld(k, false);
  }

  active(name) {
    if (this.held[name]) return true;
    const until = this.tapUntil[name] || 0;
    return performance.now() < until;
  }

  /** Snapshot for the physics step. Consumes the queued jump. */
  read() {
    const left = this.active('left');
    const right = this.active('right');
    const jump = this.jumpQueued;
    this.jumpQueued = false;
    // reflect tap-extended state so the button lights up for its whole effect
    this.reflect('left', left);
    this.reflect('right', right);
    return {
      steer: clamp((right ? 1 : 0) - (left ? 1 : 0), -1, 1),
      brake: this.active('brake'),
      tuck: this.active('tuck'),
      spin: (this.active('spinR') ? 1 : 0) - (this.active('spinL') ? 1 : 0),
      jump,
    };
  }
}
