# ALPINE RUSH · 双板高山滑雪

浏览器里的低多边形（low-poly）**双板**高山滑雪游戏。六条以 Ikon Pass 目的地为灵感的雪道，
全程可以**只用屏幕上的按钮**玩通 —— 桌面端和手机端都一样。

```bash
# 没有构建步骤，直接起一个静态服务器
python3 -m http.server 8099 --bind 127.0.0.1
# 然后打开 http://127.0.0.1:8099/
```

---

## 玩法

按钮是**主控制方式**，键盘只是它的别名。按钮常驻显示，不是手机端的降级方案。

| 按钮 | 键盘 | 作用 |
|---|---|---|
| 左转 / 右转 | `A` `D` / `←` `→` | 长按走刻滑（carve），弧线半径随速度增大；轻点也能吃到一个可用的小转向 |
| 犁式刹车 | `S` / `↓` | 双板内八（A 字），是真正的减速手段，不只是加摩擦 |
| 起跳 | `空格` | 起跳；配合台跳（kicker）能飞更远 |
| 收腿加速 | `Shift` | 低姿态，减风阻涨速 |
| 空中转体 | `Q` `E` | 只在空中生效，落地朝向要收回来，否则摔 |
| 最优走线 | `L` / 🎯 按钮 | 开关贴着雪面的发光引导线（默认开），下详 |

得分来自**过旗门**（连续过门累计连击倍率）、腾空时间与转体。撞树、撞石、撞冰塔会摔。

### 雪包（moguls）按难度分级

雪道上成片的圆丘（moguls）是真实滑雪里黑道的典型地形。每条雪场用 `terrain.mogulField`
声明自己的雪包区（以赛道进度 0~1 表示的若干区段），按难度分级：

- **绿道**（Deer Valley）：几乎无雪包，保持晨间压雪灯芯绒的顺滑。
- **蓝道**（Aspen / Niseko）：一段中等雪包区，尝个味道。
- **黑道 / 双黑**（Palisades / Big Sky / Zermatt）：两段成片、密集的雪包场。

雪包起伏用两组交错的正弦点阵整流成圆润的丘顶（`terrain.mogulHeight`），只长在雪道内、
区段边缘平滑淡入淡出。物理上，冲得越快雪包越"拍"你（`physics` 里按 `mogulIntensity`
加摩擦与掉速），逼你用犁式或收腿吸收节奏——手感是真实的。

### 最优滑雪路径（走线）

一条发光的青蓝色引导带贴着雪面，从起点平滑地穿过**每一个旗门**直到终点，带有向下
流动的箭纹。它由 `world.buildIdealLine()` 用与旗门完全相同的确定性坐标
（`planChunkGates`）预计算成 Catmull-Rom 样条，所以开局即完整、不依赖分块流式加载，
也永远精确压在门上。用屏幕 🎯 按钮或 `L` 键随时开关（默认开，老手可关）。

### 双板，不是单板

`src/skier.js` 里是一套完整的双板装备：两条带侧切（sidecut）、翘头（tip rocker）、
反弓（camber）和钢边的板，加一对雪杖。转向时有内倾 + 立刃角，刹车时是 A 字犁式，
过门时有点杖动作（pole plant）。

---

## 六个雪场

| 雪场 | 难度 | 招牌远景 | 特色 |
|---|---|---|---|
| Deer Valley（鹿谷） | 绿 | 圆钝雪岭 | 宽缓压雪灯芯绒、云杉林 |
| Aspen Snowmass | 蓝 | Maroon Bells 双峰 | 长距离刻滑、白杨林、暖阳斜射 |
| Niseko United（二世谷） | 蓝 | 羊蹄山火山锥 | 粉雪日、低能见度、白桦林、竹竿边界 |
| Palisades Tahoe | 黑 | 花岗岩锯齿岩脊 | 陡、包（mogul）多、岩石 |
| Big Sky | 黑 | Lone Peak 金字塔 | 大碗地形、长坡、高落差 |
| Zermatt | 双黑 | 马特洪峰 | 冰川、冰塔（serac）、最陡最长 |

**关于数据与版权**：落差 / 海拔一律标注为 `≈ 参考值`，来源是公开资料的近似值，
只用于氛围呈现，**不是官方数据**。全部场景是原创低多边形建模与着色器，
**没有使用任何 Ikon Pass 或各雪场的照片、Logo、雪道图或标识**，
雪场名 / 雪道名仅作描述性引用。

---

## 代码结构

静态 ES modules + importmap，从 jsdelivr 直接加载 `three@0.160.1`，**没有构建步骤**。

```
index.html          importmap + DOM 骨架
styles/main.css     HUD / 按钮面板 / 卡片
src/
  main.js           入口
  game.js           Game 编排：主循环、计分、相机、window.__SKI__ 测试钩子
  resorts.js        六个雪场的全部参数（地形/物理/配色/植被/道具/天气/远景/赛道）
  terrain.js        Terrain：压雪道分块网格 + massif 大范围山体 + 雪面着色器
  world.js          World：天空、远景山脉、光照阴影、旗门、台跳、缆车、小屋、道具
  skier.js          双板滑雪者装备与动作
  physics.js        滑行物理：重力分量、摩擦、风阻、刻滑、犁式、腾空、落地、摔倒
  fx.js             降雪、雪雾、雪痕、bloom + 速度拉丝后处理
  controls.js       按钮优先的输入层（含轻点判定）
  audio.js          合成音效（风声、刃声、过门、起跳、落地、摔、终点）
  ui.js             雪场卡片、赛前说明、HUD、成绩与奖牌、localStorage 最佳成绩
qa/verify.py        无头真实 WebGL 验证（Playwright + ANGLE/SwiftShader）
```

### 地形是两层曲面

1. **压雪道分块（chunks）** —— 跟着滑雪者滚动的高分辨率条带，`width` 130~150 m。
   物理只读这一层的 `elevation()`。
2. **massif 大范围山体** —— 整条赛道只建一次的低分辨率大网格，向两侧铺到 1150 m，
   向前延伸到终点之后 1500 m。它在条带内部沉降 1.1 m 藏在 chunks 底下，
   向外把岸壁坡度接着往外延展成开阔雪原、森林带和裸岩。
   **没有这一层，压雪道就是一条飘在天上的白带子。**

岸壁剖面是「二次曲线 → 线性」：纯二次曲线在 150 m 宽的条带上会长到 66 m 高，
把雪道变成一条峡谷缝。

### 雪面质感走着色器，不走顶点色

压雪机的灯芯绒纹（corduroy）、道外的风吹波纹、细颗粒感都在 fragment shader 里
按世界坐标算，并随距离淡出以免摩尔纹。原先烘到顶点色上时，纹理周期比顶点间距还密，
直接消失了 —— 雪面看起来就是一块死白的平板。

---

## 验证

```bash
python3 -m http.server 8099 --bind 127.0.0.1 &
python3 qa/verify.py     # 需要 playwright + pillow
```

`qa/verify.py` 用 Chromium + ANGLE/SwiftShader 做**真实 WebGL 渲染**（不是截 loading 态），
并且**通过点击屏幕按钮**驱动游戏。物理断言走 `window.__SKI__.simulate()` 的确定性定步长，
因为软件渲染只有几帧、主循环还会 clamp `dt`，靠墙上时间等待验证不了物理。

当前：**67/67 通过**，截图在 `qa/shots/`。覆盖内容包括：

- 六个雪场都能加载，几何 / 旗门 / 台跳齐全
- **仅用转向按钮的 autopilot 能在六条道上全程守住压雪道**（按钮可玩性的硬证据）
- 每个按钮的实际效果：转向改朝向、刻滑掉速（真实滑雪行为）、犁式刹住、收腿涨速、起跳离地并落地
- 过门计分与连击、终点成绩卡与奖牌、再滑一次、暂停恢复
- 手机 390×844 无横向溢出、按钮可见、暂停键不被面板遮挡
- 场景回归断言：地形法线朝上、massif 已建、远景山脉的渲染顺序在天空之后地形之前、
  近景雪面亮度在合理区间、压雪道下方没有露天空
- 零 console / page error

### `window.__SKI__` 测试钩子

`resorts()` `select(id)` `start()` `pause(on)` `press/release(name)` `jump()`
`clickButton(id)` `releaseButton(id)` `state()` `sceneStats()` `teleport(z)`
`simulate(seconds, step)` `autopilot(seconds)` `aimNextGate()` `dev()`

---

## 踩过的坑（别再踩回去）

- **地形三角形绕序**：反了的话 `computeVertexNormals()` 会让法线全部朝下，雪面被暗蓝的
  半球底光照亮（看起来像水泥），阴影的 `normalBias` 也会往错的方向推。
- **不要给 `THREE.Group` 设 `renderOrder`**：three 会把它变成 `groupOrder`，优先级**高于**
  子物件自己的 `renderOrder`。远景山脉因此被排到天空穹顶之前绘制，又都不写深度，
  于是被天空整片盖掉 —— 不透明的那几层直接消失。
- **雪的反照率接近 1**：光照强度必须按它标定（`HEMI_CAL` / `SUN_CAL`），
  否则整帧过曝成一片白。
- **环境光要冷**：阴影里的雪是被蓝天照亮的，暖色只属于方向光太阳。
  暖色半球光会把整座山染成沙漠。
- **`mergeGeometries()` 要求属性一致**：`IcosahedronGeometry` 是非索引的，Box/Cylinder/Cone
  是索引的；uv 也要先剥掉（见 `stripUV()` / `paint()`）。
- `sizeAttenuation` 的雪花，离相机最近的会变得巨大 —— 粉雪日会变成满屏白色光斑。
