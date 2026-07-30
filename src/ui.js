import { RESORTS, DIFFICULTY } from './resorts.js';
import { formatTime, clamp } from './util.js';
import { drawTrailMap, drawMiniMap } from './trailmap.js';

const BEST_KEY = (id) => `alpine-rush.best.${id}`;

export function loadBest(id) {
  try {
    const raw = localStorage.getItem(BEST_KEY(id));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveBest(id, record) {
  try {
    const prev = loadBest(id);
    if (!prev || record.score > prev.score) {
      localStorage.setItem(BEST_KEY(id), JSON.stringify(record));
      return true;
    }
  } catch { /* storage unavailable */ }
  return false;
}

export function medalFor(resort, timeSec, gatesHit, gatesTotal, crashes) {
  const par = resort.run.parSec;
  const gateRate = gatesTotal ? gatesHit / gatesTotal : 1;
  if (timeSec <= par && gateRate >= 0.8 && crashes === 0) return { key: 'gold', label: '金牌', icon: '🥇' };
  if (timeSec <= par * 1.16 && gateRate >= 0.6) return { key: 'silver', label: '银牌', icon: '🥈' };
  if (timeSec <= par * 1.4) return { key: 'bronze', label: '铜牌', icon: '🥉' };
  return { key: 'finish', label: '完赛', icon: '🎿' };
}

export class UI {
  constructor() {
    this.el = (id) => document.getElementById(id);
    this.screens = {
      title: this.el('screen-title'),
      brief: this.el('screen-brief'),
      results: this.el('screen-results'),
      pause: this.el('screen-pause'),
    };
    this.hud = this.el('hud');
    this.deck = this.el('deck');
    this.toastEl = this.el('toast');
    this.selected = null;
    this.onPick = null;
    this.onStart = null;
    this._toastTimer = null;
    this.fillResorts();
  }

  fillResorts() {
    const grid = this.el('resort-grid');
    grid.innerHTML = '';
    for (const r of RESORTS) {
      const d = DIFFICULTY[r.difficulty];
      const best = loadBest(r.id);
      const card = document.createElement('button');
      card.className = 'resort-card';
      card.dataset.id = r.id;
      card.innerHTML = `
        <span class="rc-diff" style="--diff:${d.color}">${d.mark} ${d.label}</span>
        <span class="rc-name">${r.name}</span>
        <span class="rc-cn">${r.cn} · ${r.cn_region}</span>
        <span class="rc-run">${r.run.name}</span>
        <span class="rc-stats">
          <b>${(r.run.lengthM / 1000).toFixed(1)}</b>km 赛道
          <i>·</i><b>${Math.round(r.terrain.pitch * 100)}</b>% 坡度
          <i>·</i>目标<b>${r.run.parSec}</b>s
        </span>
        <span class="rc-tags">${r.tags.map((t) => `<em>${t}</em>`).join('')}</span>
        <span class="rc-best">${best ? `个人最佳 ${best.score.toLocaleString()} · ${formatTime(best.time)}` : '尚未挑战'}</span>
      `;
      card.addEventListener('click', () => this.pick(r.id));
      grid.appendChild(card);
    }
  }

  pick(id) {
    this.selected = id;
    for (const c of document.querySelectorAll('.resort-card')) {
      c.classList.toggle('is-selected', c.dataset.id === id);
    }
    this.onPick?.(id);
  }

  showBrief(resort, runMap) {
    const d = DIFFICULTY[resort.difficulty];
    const best = loadBest(resort.id);
    const zoneText = runMap && runMap.zones.length
      ? runMap.zones.map((z) => `${Math.round(z.from)}–${Math.round(z.to)} m`).join(' · ')
      : '本条道无成片雪包';
    this.el('brief-body').innerHTML = `
      <div class="brief-head">
        <span class="rc-diff" style="--diff:${d.color}">${d.mark} ${d.label}</span>
        <h2>${resort.name}<small>${resort.cn}</small></h2>
        <p class="brief-region">${resort.region} · ${resort.cn_region}</p>
      </div>
      <p class="brief-blurb">${resort.blurb}</p>
      <div class="brief-run">
        <span><small>本条雪道</small><b>${resort.run.name}</b></span>
        <span><small>赛道长度</small><b>${resort.run.lengthM} m</b></span>
        <span><small>目标时间</small><b>${resort.run.parSec} s</b></span>
      </div>
      <div class="brief-facts">
        <span><small>参考落差</small><b>≈ ${resort.facts.verticalRefM} m</b></span>
        <span><small>参考顶部海拔</small><b>≈ ${resort.facts.summitRefM} m</b></span>
        <span><small>备注</small><b>${resort.facts.note}</b></span>
      </div>
      <div class="brief-map">
        <h3>雪道地形图 <small>由本条道的真实地形实时生成</small></h3>
        <div class="map-wrap"><canvas id="brief-map-canvas" class="map-canvas"></canvas></div>
        <ul class="map-legend">
          <li><i class="sw sw-green"></i>缓 &lt;25%</li>
          <li><i class="sw sw-blue"></i>中 25–34%</li>
          <li><i class="sw sw-black"></i>陡 34–46%</li>
          <li><i class="sw sw-double"></i>极陡 &gt;46%</li>
          <li><i class="sw sw-mogul"></i>雪包区</li>
          <li><i class="sw sw-gate-r"></i><i class="sw sw-gate-b"></i>旗门</li>
        </ul>
        <p class="map-note">雪包区：${zoneText}</p>
      </div>
      <div class="brief-controls">
        <h3>操作指南 <small>屏幕按钮 / 键盘 都行</small></h3>
        <ul class="key-list">
          <li><span class="ico">◀ ▶</span><kbd>A</kbd><kbd>D</kbd><em>左转 / 右转</em><span class="tip">长按走弧线，轻点小幅修正</span></li>
          <li><span class="ico">🍕</span><kbd>S</kbd><em>犁式刹车</em><span class="tip">双板内八减速</span></li>
          <li><span class="ico">⤒</span><kbd>Space</kbd><em>起跳</em><span class="tip">配合台跳飞更远</span></li>
          <li><span class="ico">↓</span><kbd>Shift</kbd><em>收腿加速</em><span class="tip">低姿态减风阻</span></li>
          <li><span class="ico">↻</span><kbd>Q</kbd><kbd>E</kbd><em>空中转体</em><span class="tip">只在腾空时生效，落地要收正</span></li>
          <li><span class="ico">🎯</span><kbd>L</kbd><em>最优走线</em><span class="tip">雪面上的深蓝箭头指向下一个旗门，可随时开关</span></li>
          <li><span class="ico">⏸</span><kbd>P</kbd> / <kbd>R</kbd><em>暂停 / 重滑</em><span class="tip">方向键 ← → ↓ 与 A/S/D 等价</span></li>
        </ul>
        <p class="key-goal">目标：过旗门连击拿分，别撞树石冰塔，尽量压着目标时间冲线。</p>
      </div>
      <p class="brief-note">参考数据为公开资料的近似值，仅用于氛围呈现，非官方数据。场景为原创低多边形建模，未使用任何 Ikon Pass 或雪场的图片与标识。</p>
      ${best ? `<p class="brief-best">个人最佳：<b>${best.score.toLocaleString()}</b> 分 · ${formatTime(best.time)} · ${best.medal}</p>` : ''}
    `;
    // The canvas only exists once the markup above is in the DOM.
    if (runMap) {
      const cv = this.el('brief-map-canvas');
      if (cv) { try { drawTrailMap(cv, runMap); } catch { /* map is decorative */ } }
    }
    this.setScreen('brief');
  }

  setScreen(name) {
    for (const [key, el] of Object.entries(this.screens)) {
      if (!el) continue;
      el.classList.toggle('is-open', key === name);
    }
    const inRun = name === 'run';
    this.hud.classList.toggle('is-on', inRun || name === 'pause');
    this.deck.classList.toggle('is-on', inRun);
    document.body.dataset.screen = name;
  }

  updateHud(s) {
    this.el('hud-speed').textContent = Math.round(s.speedKmh);
    this.el('hud-vert').textContent = Math.round(s.vertical);
    this.el('hud-time').textContent = formatTime(s.time);
    this.el('hud-score').textContent = Math.floor(s.score).toLocaleString();
    this.el('hud-combo').textContent = `x${s.combo.toFixed(s.combo % 1 ? 1 : 0)}`;
    this.el('hud-combo').classList.toggle('is-hot', s.combo >= 3);
    this.el('hud-gates').textContent = `${s.gatesHit}/${s.gatesSeen}`;
    this.el('hud-progress-fill').style.width = `${clamp(s.progress, 0, 1) * 100}%`;
    this.el('hud-progress-label').textContent = `${Math.round(clamp(s.progress, 0, 1) * 100)}%`;
    const air = this.el('hud-air');
    air.classList.toggle('is-on', s.airborne);
    air.textContent = s.airborne ? `AIR ${s.airTime.toFixed(1)}s` : 'AIR';
    this.el('hud-terrain').textContent = s.offPiste > 0.45 ? '深雪区' : '压雪道';
    this.el('hud-terrain').classList.toggle('is-powder', s.offPiste > 0.45);
    this.drawMini(s);
  }

  /** Hand the sampled run to the UI so both the briefing map and the minimap can use it. */
  setRunMap(map) {
    this.runMap = map;
    this._miniAt = 0;
  }

  /**
   * The minimap only needs to *look* live, so it is redrawn ~16x a second instead of on
   * every WebGL frame — the ribbon is a few hundred path points and repainting it at 60 fps
   * next to the 3D scene is pure waste.
   */
  drawMini(s, force = false) {
    const cv = this.el('hud-map-canvas');
    if (!cv || !this.runMap) return;
    const now = performance.now();
    if (!force && now - (this._miniAt || 0) < 62) return;
    this._miniAt = now;
    try {
      drawMiniMap(cv, this.runMap, {
        d: clamp(s.progress, 0, 1) * this.runMap.lengthM,
        x: s.x ?? 0,
      });
    } catch { /* minimap is decorative */ }
  }

  toast(text, kind = '') {
    const el = this.toastEl;
    el.textContent = text;
    el.className = `toast is-on ${kind}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.className = 'toast'; }, 1500);
  }

  showResults(resort, r) {
    const isNewBest = saveBest(resort.id, { score: Math.floor(r.score), time: r.time, medal: r.medal.label });
    const best = loadBest(resort.id);
    this.el('results-body').innerHTML = `
      <div class="res-medal ${r.medal.key}">${r.medal.icon}</div>
      <h2>${r.medal.label}${isNewBest ? ' · 新纪录' : ''}</h2>
      <p class="res-run">${resort.name} · ${resort.run.name}</p>
      <div class="res-grid">
        <span><small>总分</small><b>${Math.floor(r.score).toLocaleString()}</b></span>
        <span><small>用时</small><b>${formatTime(r.time)}</b></span>
        <span><small>目标</small><b>${resort.run.parSec}s</b></span>
        <span><small>旗门</small><b>${r.gatesHit}/${r.gatesSeen}</b></span>
        <span><small>最高速度</small><b>${Math.round(r.topSpeed * 3.6)} km/h</b></span>
        <span><small>累计落差</small><b>${Math.round(r.vertical)} m</b></span>
        <span><small>滞空</small><b>${r.airTimeTotal.toFixed(1)}s</b></span>
        <span><small>最长滞空</small><b>${r.bigAir.toFixed(1)}s</b></span>
        <span><small>转体</small><b>${r.spins}</b></span>
        <span><small>摔倒</small><b>${r.crashes}</b></span>
      </div>
      ${best ? `<p class="res-best">个人最佳 ${best.score.toLocaleString()} 分 · ${formatTime(best.time)}</p>` : ''}
    `;
    this.setScreen('results');
  }

  showError(err) {
    const el = this.el('error');
    el.textContent = String(err?.stack || err);
    el.classList.add('is-on');
    console.error(err);
  }
}
