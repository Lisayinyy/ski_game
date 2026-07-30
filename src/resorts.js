/**
 * Resort registry — six Ikon Pass destinations, translated into gameplay + art direction.
 *
 * IMPORTANT / LEGAL: no Ikon Pass or resort photography, logos, trail maps or branding are
 * used anywhere in this project. Everything is original low-poly geometry and shader work.
 * Resort, lift and trail names are used descriptively (they are real-world place names).
 * `facts.*` numbers are ROUGH published mountain stats used for flavour only — they are
 * labelled with "≈" in the UI and must not be treated as official figures.
 */

export const DIFFICULTY = {
  green: { label: '绿道 · 初级', mark: '●', color: '#3ba55d' },
  blue: { label: '蓝道 · 中级', mark: '■', color: '#3b82f6' },
  black: { label: '黑道 · 高级', mark: '◆', color: '#111827' },
  double: { label: '双黑 · 专家', mark: '◆◆', color: '#7c1d3f' },
};

export const RESORTS = [
  {
    id: 'deer-valley',
    name: 'Deer Valley',
    cn: '鹿谷',
    region: 'Utah, USA',
    cn_region: '美国 犹他州',
    difficulty: 'green',
    seed: 1041,
    blurb: '晨间压雪机刚走过，整条道是完美的灯芯绒。宽、缓、干净——最适合把双板平行式的节奏找回来。',
    facts: { verticalRefM: 915, summitRefM: 2917, note: '只允许双板（不开放单板）' },
    trails: ['Big Stick', "Stein's Way", 'Success', 'Wide West'],
    tags: ['压雪灯芯绒', '宽缓道', '云杉林', '只有双板'],
    run: { name: 'Bald Mountain · Corduroy', lengthM: 1900, parSec: 78 },
    terrain: {
      pitch: 0.20, pisteHalf: 26, wallSteep: 0.9, rollAmp: 2.0,
      mogul: 0.10, rough: 0.5, curve: [0.0060, 22, 0.017, 7], width: 130,
      // Deer Valley is famous for corduroy grooming — keep it (almost) mogul-free.
      mogulField: { bands: [], amp: 0.0, size: 1.0, speedTax: 0.0 },
    },
    physics: { drag: 0.0052, carve: 1.55, maxSpeed: 27, grip: 1.05, deepDrag: 2.4, brake: 0.85 },
    palette: {
      skyTop: [0.13, 0.30, 0.58], skyMid: [0.44, 0.68, 0.90], skyLow: [0.93, 0.90, 0.86],
      sunDir: [-0.42, 0.36, 0.83], sunTint: [1.0, 0.86, 0.62], sunSharp: 22,
      fog: 0xc9dcf0, fogNear: 90, fogFar: 900,
      snowLo: [0.93, 0.96, 1.0], snowHi: [1.0, 1.0, 1.0], offPiste: [0.80, 0.87, 0.97],
      rock: 0x7d8ea4, tree: 0x1b4a3c, treeSnow: 0xf6fbff, corduroy: 0.055,
      hemiSky: 0xcfe8ff, hemiGround: 0x37536f, hemiInt: 2.0, sunInt: 3.0, exposure: 1.05,
    },
    flora: { kind: 'spruce', density: 0.95, lineGap: 6, scale: [0.85, 1.45] },
    props: { lift: 'chair', hut: true, snowgun: true, bamboo: false, serac: false, village: false },
    weather: { snowfall: 420, flakeSize: 0.11, wind: 0.25, drift: 3.5 },
    vista: { kind: 'rounded', height: 1.0, ridges: 3 },
  },
  {
    id: 'aspen-snowmass',
    name: 'Aspen Snowmass',
    cn: '阿斯本',
    region: 'Colorado, USA',
    cn_region: '美国 科罗拉多州',
    difficulty: 'blue',
    seed: 2207,
    blurb: '下午三点的科州阳光，穿过白桦一样的杨树林。Big Burn 的长坡能让你一路刻到腿软。',
    facts: { verticalRefM: 1343, summitRefM: 3813, note: '四山联票 · Big Burn 长坡' },
    trails: ['Big Burn', 'Sneaky’s', 'Powerline Glades', 'Long Shot'],
    tags: ['长距离刻滑', '杨树林道', '午后金光', '高海拔'],
    run: { name: 'Big Burn · Long Carve', lengthM: 2500, parSec: 95 },
    terrain: {
      pitch: 0.245, pisteHalf: 23, wallSteep: 1.1, rollAmp: 3.2,
      mogul: 0.22, rough: 0.8, curve: [0.0072, 30, 0.021, 10], width: 140,
      // one modest mogul stretch on the lower Big Burn — a blue-run taste, not a wall.
      mogulField: { bands: [[0.46, 0.66]], amp: 0.75, size: 1.05, speedTax: 0.12 },
    },
    physics: { drag: 0.0044, carve: 1.5, maxSpeed: 31, grip: 1.0, deepDrag: 3.0, brake: 0.8 },
    palette: {
      // Late-afternoon Colorado gold: warm low sky feeding a cool zenith. Low sun (y≈0.16)
      // rakes across the snow so trees and moguls throw long amber shadows.
      skyTop: [0.10, 0.22, 0.48], skyMid: [0.52, 0.60, 0.82], skyLow: [1.0, 0.72, 0.42],
      sunDir: [0.60, 0.16, 0.78], sunTint: [1.0, 0.62, 0.28], sunSharp: 13,
      // Warm afternoon light on *white* snow. The old warm snow + warm fog combination
      // tinted the whole mountain sand-beige and read as a desert.
      fog: 0xe6d9cc, fogNear: 110, fogFar: 1050,
      snowLo: [0.95, 0.955, 0.97], snowHi: [1.0, 1.0, 1.0], offPiste: [0.86, 0.87, 0.93],
      rock: 0x8b7a6c, tree: 0x2f5138, treeSnow: 0xfff4e2, corduroy: 0.03,
      // Ambient stays *cool* — snow in shade is lit by blue sky, and the warmth belongs to
      // the directional sun only. A warm hemisphere light turned the whole run beige.
      hemiSky: 0xd9e4ff, hemiGround: 0x5a4c3a, hemiInt: 1.9, sunInt: 3.6, exposure: 1.12,
    },
    flora: { kind: 'aspen', density: 1.0, lineGap: 5, scale: [0.9, 1.5] },
    props: { lift: 'gondola', hut: true, snowgun: false, bamboo: false, serac: false, village: false },
    weather: { snowfall: 200, flakeSize: 0.09, wind: 0.2, drift: 2.5 },
    vista: { kind: 'twin', height: 1.15, ridges: 3 },
  },
  {
    id: 'niseko',
    name: 'Niseko United',
    cn: '二世谷',
    region: 'Hokkaido, Japan',
    cn_region: '日本 北海道',
    difficulty: 'blue',
    seed: 3301,
    blurb: '雪一直下，能见度很差，但每一个转弯都会炸起胸口高的粉雪。远处那座完美的圆锥是羊蹄山。',
    facts: { verticalRefM: 900, summitRefM: 1308, note: '年均降雪 ≈ 14 m 级的粉雪' },
    trails: ['Hanazono', 'Miharashi', 'Strawberry Fields', 'Superstition'],
    tags: ['深粉雪', '白桦林', '低能见度', '羊蹄山'],
    run: { name: 'Hanazono · Powder Day', lengthM: 2100, parSec: 100 },
    terrain: {
      pitch: 0.235, pisteHalf: 21, wallSteep: 0.8, rollAmp: 2.6,
      mogul: 0.30, rough: 1.1, curve: [0.0085, 26, 0.024, 9], width: 130,
      // powder day: softer, rounder rollers rather than hard bumps — one mid stretch.
      mogulField: { bands: [[0.40, 0.62]], amp: 0.9, size: 1.25, speedTax: 0.10 },
    },
    physics: { drag: 0.0060, carve: 1.32, maxSpeed: 26, grip: 0.86, deepDrag: 1.7, brake: 0.95 },
    palette: {
      skyTop: [0.42, 0.50, 0.60], skyMid: [0.68, 0.74, 0.80], skyLow: [0.88, 0.91, 0.94],
      sunDir: [-0.2, 0.5, 0.84], sunTint: [0.9, 0.92, 0.98], sunSharp: 5,
      fog: 0xdfe6ec, fogNear: 40, fogFar: 420,
      snowLo: [0.97, 0.98, 1.0], snowHi: [1.0, 1.0, 1.0], offPiste: [0.95, 0.97, 1.0],
      rock: 0x8d94a0, tree: 0x2b3a44, treeSnow: 0xffffff, corduroy: 0.012,
      hemiSky: 0xeef4fa, hemiGround: 0x6b7684, hemiInt: 2.6, sunInt: 1.5, exposure: 1.02,
    },
    flora: { kind: 'birch', density: 1.15, lineGap: 4.5, scale: [0.9, 1.35] },
    props: { lift: 'chair', hut: true, snowgun: false, bamboo: true, serac: false, village: true },
    weather: { snowfall: 2600, flakeSize: 0.17, wind: 0.55, drift: 7.5 },
    vista: { kind: 'cone', height: 1.05, ridges: 2 },
  },
  {
    id: 'palisades-tahoe',
    name: 'Palisades Tahoe',
    cn: '帕利塞德太浩',
    region: 'California, USA',
    cn_region: '美国 加州',
    difficulty: 'black',
    seed: 4407,
    blurb: 'KT-22 底下抬头看，全是花岗岩。Sierra 的阳光很硬，雪偏重，落差来得非常直接。',
    facts: { verticalRefM: 870, summitRefM: 2760, note: '1960 冬奥举办地 · KT-22' },
    trails: ['KT-22', 'Siberia Bowl', 'Headwall', 'Granite Chief'],
    tags: ['花岗岩', '陡峭碗', 'Sierra 重雪', '缆车'],
    run: { name: 'KT-22 · Granite Line', lengthM: 2300, parSec: 88 },
    terrain: {
      pitch: 0.315, pisteHalf: 19, wallSteep: 1.5, rollAmp: 4.6,
      mogul: 0.40, rough: 1.4, curve: [0.0090, 27, 0.026, 11], width: 140,
      // KT-22 is bump country: two big mogul fields, tight and punishing.
      mogulField: { bands: [[0.22, 0.44], [0.58, 0.82]], amp: 1.5, size: 0.92, speedTax: 0.22 },
    },
    physics: { drag: 0.0040, carve: 1.62, maxSpeed: 35, grip: 1.08, deepDrag: 3.4, brake: 0.78 },
    palette: {
      skyTop: [0.05, 0.19, 0.50], skyMid: [0.26, 0.55, 0.87], skyLow: [0.78, 0.89, 0.98],
      sunDir: [-0.62, 0.42, 0.66], sunTint: [1.0, 0.80, 0.48], sunSharp: 26,
      fog: 0xb9d3ee, fogNear: 110, fogFar: 1050,
      snowLo: [0.90, 0.94, 1.0], snowHi: [1.0, 1.0, 1.0], offPiste: [0.76, 0.84, 0.96],
      rock: 0x6e7686, tree: 0x1d3f30, treeSnow: 0xf2f9ff, corduroy: 0.025,
      hemiSky: 0xbfe0ff, hemiGround: 0x2d4358, hemiInt: 1.9, sunInt: 3.6, exposure: 1.08,
    },
    flora: { kind: 'spruce', density: 0.7, lineGap: 7, scale: [0.8, 1.6] },
    props: { lift: 'tram', hut: true, snowgun: false, bamboo: false, serac: false, village: false },
    weather: { snowfall: 300, flakeSize: 0.10, wind: 0.35, drift: 4.0 },
    vista: { kind: 'granite', height: 1.1, ridges: 3 },
  },
  {
    id: 'big-sky',
    name: 'Big Sky',
    cn: '大天空',
    region: 'Montana, USA',
    cn_region: '美国 蒙大拿州',
    difficulty: 'black',
    seed: 5503,
    blurb: 'Lone Peak 那个金字塔就在正前方。日落把树线以上的雪染成粉金色，空气干冷，只有你和风。',
    facts: { verticalRefM: 1326, summitRefM: 3403, note: 'Lone Peak Tram · 大落差' },
    trails: ['Liberty Bowl', 'Marx', 'Lenin', 'Big Rock Tongue'],
    tags: ['树线以上', '日落粉金', '大落差', 'Lone Peak'],
    run: { name: 'Liberty Bowl · Lone Peak', lengthM: 2800, parSec: 96 },
    terrain: {
      pitch: 0.335, pisteHalf: 24, wallSteep: 1.2, rollAmp: 5.2,
      mogul: 0.26, rough: 1.2, curve: [0.0055, 34, 0.019, 12], width: 150,
      // Liberty Bowl: wide, big-amplitude bumps below the ridge — two broad fields.
      mogulField: { bands: [[0.30, 0.52], [0.64, 0.86]], amp: 1.35, size: 1.15, speedTax: 0.20 },
    },
    physics: { drag: 0.0036, carve: 1.48, maxSpeed: 38, grip: 1.0, deepDrag: 3.0, brake: 0.75 },
    palette: {
      // Alpenglow at last light: a hot pink-orange horizon climbing into deep dusk blue.
      // The sun sits right on the horizon (y≈0.10) so Lone Peak and every bump throws a
      // long rose-gold shadow across the bowl.
      skyTop: [0.06, 0.10, 0.34], skyMid: [0.46, 0.42, 0.66], skyLow: [1.0, 0.55, 0.46],
      sunDir: [0.40, 0.10, 0.86], sunTint: [1.0, 0.55, 0.40], sunSharp: 22,
      fog: 0xd9bfc6, fogNear: 130, fogFar: 1150,
      // snow at dusk picks up the warm sky low and cool shade high — keep the base bright
      // so it still reads as snow, the warmth comes from the directional sun.
      snowLo: [0.94, 0.93, 0.96], snowHi: [1.0, 0.99, 0.98], offPiste: [0.82, 0.86, 0.96],
      rock: 0x6b6270, tree: 0x24303f, treeSnow: 0xffe9e0, corduroy: 0.02,
      hemiSky: 0xcabfe0, hemiGround: 0x3a3550, hemiInt: 1.9, sunInt: 3.5, exposure: 1.08,
    },
    flora: { kind: 'sparse', density: 0.4, lineGap: 9, scale: [0.7, 1.2] },
    props: { lift: 'tram', hut: false, snowgun: false, bamboo: false, serac: false, village: false },
    weather: { snowfall: 520, flakeSize: 0.08, wind: 0.75, drift: 9.0 },
    vista: { kind: 'pyramid', height: 1.3, ridges: 3 },
  },
  {
    id: 'zermatt',
    name: 'Zermatt',
    cn: '采尔马特',
    region: 'Valais, Switzerland',
    cn_region: '瑞士 瓦莱州',
    difficulty: 'double',
    seed: 6609,
    blurb: '冰川上，海拔三千八。天空是发黑的蓝，脚下是冰裂缝和冰塔。右边那个牛角一样的东西你认识。',
    facts: { verticalRefM: 2200, summitRefM: 3899, note: '欧洲最高冰川滑雪区之一' },
    trails: ['Gornergrat', 'Hörnli', 'Theodul Glacier', 'Furggsattel'],
    tags: ['冰川', '冰裂缝', '极高海拔', '马特洪峰'],
    run: { name: 'Theodul Glacier · Descent', lengthM: 3200, parSec: 104 },
    terrain: {
      pitch: 0.365, pisteHalf: 20, wallSteep: 1.7, rollAmp: 5.8,
      mogul: 0.16, rough: 1.5, curve: [0.0095, 29, 0.028, 12], width: 150,
      // Glacier: hard, tight, icy bumps — two demanding fields, smaller & sharper.
      mogulField: { bands: [[0.24, 0.46], [0.60, 0.84]], amp: 1.2, size: 0.85, speedTax: 0.24 },
    },
    physics: { drag: 0.0033, carve: 1.70, maxSpeed: 41, grip: 1.18, deepDrag: 3.8, brake: 0.70 },
    palette: {
      skyTop: [0.02, 0.08, 0.32], skyMid: [0.13, 0.38, 0.76], skyLow: [0.66, 0.84, 0.98],
      sunDir: [-0.30, 0.52, 0.80], sunTint: [1.0, 0.93, 0.78], sunSharp: 34,
      fog: 0xa9c9ec, fogNear: 150, fogFar: 1250,
      snowLo: [0.86, 0.94, 1.0], snowHi: [0.98, 1.0, 1.0], offPiste: [0.72, 0.86, 0.99],
      rock: 0x5f6a7c, tree: 0x1c3a33, treeSnow: 0xeef8ff, corduroy: 0.03,
      hemiSky: 0xb4dcff, hemiGround: 0x21384f, hemiInt: 1.8, sunInt: 3.8, exposure: 1.12,
    },
    flora: { kind: 'none', density: 0.0, lineGap: 12, scale: [0.6, 1.0] },
    props: { lift: 'tbar', hut: true, snowgun: false, bamboo: false, serac: true, village: false },
    weather: { snowfall: 260, flakeSize: 0.09, wind: 0.6, drift: 6.0 },
    vista: { kind: 'horn', height: 1.45, ridges: 3 },
  },
];

export const resortById = (id) => RESORTS.find((r) => r.id === id) || RESORTS[0];
