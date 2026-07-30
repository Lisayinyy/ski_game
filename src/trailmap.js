/**
 * Trail map ("地形图") — drawn from the *real* terrain, not hand-authored artwork.
 *
 * Everything here is sampled straight out of `Terrain` / `World`, so the map can never
 * drift from the slope you actually ski: the ribbon follows `terrain.centerX(z)`, the
 * profile follows `terrain.elevation()`, the shaded bump zones follow `terrain.mogulMask()`
 * and the gate markers come from the same deterministic gate plan the 3D gates use.
 *
 * Two renderers share one sampled dataset:
 *   - `drawTrailMap()`  the pre-run briefing map: top-down piste + elevation profile
 *   - `drawMiniMap()`   the compact in-run HUD strip with a live rider dot
 *
 * All original vector drawing on a canvas; no resort trail-map artwork is used.
 */

import { clamp } from './util.js';

/* --------------------------------------------------------------- sampling */

/** Grade bands, in percent (rise/run) — mirrors how runs are actually signed. */
const GRADE_BANDS = [
  { max: 25, key: 'green', color: '#3fa65a', label: '缓' },
  { max: 34, key: 'blue', color: '#2f7fd0', label: '中' },
  { max: 46, key: 'black', color: '#2b3340', label: '陡' },
  { max: Infinity, key: 'double', color: '#7a1f2b', label: '极陡' },
];

export function gradeBand(pct) {
  for (const b of GRADE_BANDS) if (pct < b.max) return b;
  return GRADE_BANDS[GRADE_BANDS.length - 1];
}

/**
 * Walk the fall line from start to finish and record the shape of the run.
 * `samples` controls resolution only; every value is read from the live terrain.
 */
export function sampleRun(resort, terrain, world, samples = 240) {
  const lengthM = resort.run.lengthM;
  const pisteHalf = resort.terrain.pisteHalf;

  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const z = -t * lengthM;
    const cx = terrain.centerX(z);
    pts.push({
      d: t * lengthM,               // metres travelled down the run
      z,
      cx,
      y: terrain.elevation(cx, z),  // elevation on the centre line
      mogul: terrain.mogulMask(z),
      grade: 0,
    });
  }

  // central-difference grade so the first/last sample isn't special-cased to 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const run = b.d - a.d;
    pts[i].grade = run > 0 ? Math.max(0, (a.y - b.y) / run) * 100 : 0;
  }

  // Mogul zones as metre ranges, so the map can label them ("雪包区 620-900 m").
  const zones = [];
  let open = null;
  for (const p of pts) {
    if (p.mogul > 0.25) {
      if (!open) open = { from: p.d, to: p.d };
      else open.to = p.d;
    } else if (open) { zones.push(open); open = null; }
  }
  if (open) zones.push(open);

  // Gates come from the same plan the 3D gates use (see World.buildIdealLine).
  const gates = (world?.idealLinePts ?? [])
    .filter((p) => p.gate)
    .map((p) => ({ d: clamp(-p.z, 0, lengthM), x: p.x, blue: !!p.blue }))
    .sort((a, b) => a.d - b.d);

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const p of pts) {
    xMin = Math.min(xMin, p.cx - pisteHalf);
    xMax = Math.max(xMax, p.cx + pisteHalf);
    yMin = Math.min(yMin, p.y);
    yMax = Math.max(yMax, p.y);
  }
  for (const g of gates) { xMin = Math.min(xMin, g.x); xMax = Math.max(xMax, g.x); }

  const avgGrade = pts.reduce((s, p) => s + p.grade, 0) / pts.length;
  let maxGrade = 0;
  for (const p of pts) maxGrade = Math.max(maxGrade, p.grade);

  return {
    resortId: resort.id,
    lengthM, pisteHalf,
    points: pts,
    gates,
    zones,
    xMin, xMax, yMin, yMax,
    dropM: yMax - yMin,
    avgGrade, maxGrade,
  };
}

/* ---------------------------------------------------------------- canvas */

/** Size a canvas for the current DPR and return a ready 2D context in CSS pixels. */
function prep(canvas, cssW, cssH) {
  const dpr = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  return g;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/* ------------------------------------------------------------ pre-run map */

const MAP_W = 720;
const MAP_H = 348;

/**
 * The briefing map: a top-down view of the piste on the left, the elevation profile on
 * the right. Horizontal distance in the top-down view is exaggerated (a 2.5 km run is
 * only ~140 m wide) exactly as printed trail maps do.
 */
export function drawTrailMap(canvas, data) {
  const g = prep(canvas, MAP_W, MAP_H);

  const mapX = 14, mapW = 236;
  const proX = 286, proW = MAP_W - proX - 14;
  const topY = 30, botY = MAP_H - 26;
  const H = botY - topY;

  g.font = '600 11px system-ui, -apple-system, "PingFang SC", sans-serif';
  g.fillStyle = '#8ea6c4';
  g.fillText('俯视雪道图 · 起点在上', mapX, 18);
  g.fillText('高度剖面 · 按坡度分色', proX, 18);

  /* ------------------------------------------------------ top-down view */

  const xSpan = Math.max(28, data.xMax - data.xMin);
  const sx = (x) => mapX + ((x - data.xMin) / xSpan) * mapW;
  const sy = (d) => topY + (d / data.lengthM) * H;

  g.fillStyle = 'rgba(148,178,208,0.10)';
  roundRect(g, mapX - 6, topY - 8, mapW + 12, H + 16, 10);
  g.fill();

  // the piste ribbon, following the real curving centre line
  g.beginPath();
  data.points.forEach((p, i) => {
    const x = sx(p.cx - data.pisteHalf);
    if (i) g.lineTo(x, sy(p.d)); else g.moveTo(x, sy(p.d));
  });
  for (let i = data.points.length - 1; i >= 0; i--) {
    const p = data.points[i];
    g.lineTo(sx(p.cx + data.pisteHalf), sy(p.d));
  }
  g.closePath();
  const rib = g.createLinearGradient(0, topY, 0, botY);
  rib.addColorStop(0, 'rgba(255,255,255,0.96)');
  rib.addColorStop(1, 'rgba(226,240,255,0.88)');
  g.fillStyle = rib;
  g.fill();
  g.strokeStyle = 'rgba(74,104,140,0.5)';
  g.lineWidth = 1;
  g.save();
  g.clip();                       // keep the bump shading inside the ribbon

  for (const z of data.zones) {
    const y0 = sy(z.from), y1 = sy(z.to);
    g.fillStyle = 'rgba(120,86,160,0.20)';
    g.fillRect(mapX - 6, y0, mapW + 12, Math.max(2, y1 - y0));
    g.fillStyle = 'rgba(92,62,132,0.42)';
    let row = 0;
    for (let y = y0 + 4; y < y1; y += 9, row++) {
      for (let k = 0; k < 5; k++) {
        const jx = mapX + 14 + (k * (mapW - 28)) / 4 + (row % 2 ? 9 : 0);
        g.beginPath();
        g.arc(jx, y, 1.7, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  g.restore();
  g.stroke();

  // fall line
  g.beginPath();
  data.points.forEach((p, i) => (i ? g.lineTo(sx(p.cx), sy(p.d)) : g.moveTo(sx(p.cx), sy(p.d))));
  g.strokeStyle = 'rgba(70,100,140,0.35)';
  g.setLineDash([4, 5]);
  g.stroke();
  g.setLineDash([]);

  // gates
  for (const gate of data.gates) {
    g.fillStyle = gate.blue ? '#2f7fd0' : '#d8434f';
    g.fillRect(sx(gate.x) - 3.4, sy(gate.d) - 1.3, 6.8, 2.6);
  }

  // start / finish caps
  const cap = (y, text, color) => {
    g.fillStyle = color;
    roundRect(g, mapX + mapW / 2 - 27, y - 7, 54, 14, 7);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '700 9px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(text, mapX + mapW / 2, y + 3);
    g.textAlign = 'left';
  };
  cap(topY - 1, '起点 START', '#2c6e4a');
  cap(botY + 1, '终点 FINISH', '#8a2530');

  /* -------------------------------------------------------- profile view */

  const span = Math.max(1, data.yMax - data.yMin);
  const py = (y) => topY + (1 - (y - data.yMin) / span) * H;
  const px = (d) => proX + (d / data.lengthM) * proW;

  g.fillStyle = 'rgba(148,178,208,0.10)';
  roundRect(g, proX - 6, topY - 8, proW + 12, H + 16, 10);
  g.fill();

  // grade-coloured columns under the surface line
  g.globalAlpha = 0.55;
  for (let i = 1; i < data.points.length; i++) {
    const a = data.points[i - 1], b = data.points[i];
    g.fillStyle = gradeBand(b.grade).color;
    g.beginPath();
    g.moveTo(px(a.d), py(a.y));
    g.lineTo(px(b.d), py(b.y));
    g.lineTo(px(b.d), botY);
    g.lineTo(px(a.d), botY);
    g.closePath();
    g.fill();
  }
  g.globalAlpha = 1;

  // the snow surface
  g.beginPath();
  data.points.forEach((p, i) => (i ? g.lineTo(px(p.d), py(p.y)) : g.moveTo(px(p.d), py(p.y))));
  g.strokeStyle = '#f3f8ff';
  g.lineWidth = 2;
  g.stroke();
  g.lineWidth = 1;

  // bump zones along the floor
  for (const z of data.zones) {
    g.fillStyle = 'rgba(150,110,196,0.9)';
    g.fillRect(px(z.from), botY - 4, Math.max(2, px(z.to) - px(z.from)), 4);
  }

  // gate ticks along the top
  for (const gate of data.gates) {
    g.fillStyle = gate.blue ? 'rgba(80,150,225,0.9)' : 'rgba(224,96,108,0.9)';
    g.fillRect(px(gate.d) - 0.8, topY - 6, 1.6, 5);
  }

  // labels
  g.font = '600 9px system-ui, sans-serif';
  g.fillStyle = '#8ea6c4';
  g.fillText('0 m', proX, botY + 13);
  g.fillText(`落差 ${Math.round(data.dropM)} m`, proX, topY - 12);
  g.textAlign = 'right';
  g.fillText(`${data.lengthM} m`, proX + proW, botY + 13);
  g.fillText(`平均 ${data.avgGrade.toFixed(0)}% · 最陡 ${data.maxGrade.toFixed(0)}%`, proX + proW, topY - 12);
  g.textAlign = 'left';

  return { width: MAP_W, height: MAP_H };
}

/* --------------------------------------------------------- in-run minimap */

const MINI_W = 92;
const MINI_H = 208;

/** Compact HUD strip: the whole run end to end, with a live rider dot. */
export function drawMiniMap(canvas, data, rider) {
  const g = prep(canvas, MINI_W, MINI_H);
  const topY = 12, botY = MINI_H - 12, H = botY - topY;
  const xSpan = Math.max(28, data.xMax - data.xMin);
  const sx = (x) => 10 + ((x - data.xMin) / xSpan) * (MINI_W - 20);
  const sy = (d) => topY + clamp(d / data.lengthM, 0, 1) * H;

  g.fillStyle = 'rgba(10,20,34,0.42)';
  roundRect(g, 1, 1, MINI_W - 2, MINI_H - 2, 10);
  g.fill();

  g.beginPath();
  data.points.forEach((p, i) => {
    const x = sx(p.cx - data.pisteHalf);
    if (i) g.lineTo(x, sy(p.d)); else g.moveTo(x, sy(p.d));
  });
  for (let i = data.points.length - 1; i >= 0; i--) {
    g.lineTo(sx(data.points[i].cx + data.pisteHalf), sy(data.points[i].d));
  }
  g.closePath();
  g.fillStyle = 'rgba(236,246,255,0.86)';
  g.fill();

  for (const z of data.zones) {
    const y0 = sy(z.from), y1 = sy(z.to);
    g.fillStyle = 'rgba(138,98,182,0.55)';
    g.fillRect(8, y0, MINI_W - 16, Math.max(2, y1 - y0));
  }

  for (const gate of data.gates) {
    g.fillStyle = gate.blue ? 'rgba(47,127,208,0.95)' : 'rgba(216,67,79,0.95)';
    g.fillRect(sx(gate.x) - 2.2, sy(gate.d) - 0.9, 4.4, 1.8);
  }

  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(8, botY - 1, MINI_W - 16, 2);

  if (rider) {
    const rx = sx(rider.x), ry = sy(rider.d);
    g.beginPath();
    g.arc(rx, ry, 5.4, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,120,60,0.28)';
    g.fill();
    g.beginPath();
    g.arc(rx, ry, 2.9, 0, Math.PI * 2);
    g.fillStyle = '#ff7a3c';
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 1;
    g.stroke();
  }
  return { width: MINI_W, height: MINI_H };
}
