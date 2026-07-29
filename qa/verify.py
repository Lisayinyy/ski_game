#!/usr/bin/env python3
"""Headless verification for ALPINE RUSH.

Real WebGL rendering via Chromium + ANGLE/SwiftShader so the screenshots show the actual
game, not a loading screen. Gameplay is driven through the ON-SCREEN BUTTONS (the primary
control scheme). Physics assertions use the deterministic fixed-step `simulate()` hook,
because software rendering only manages a few FPS and the loop clamps dt.
"""
import io
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

try:
    from PIL import Image
except ImportError:  # pixel checks degrade to a skip rather than a hard failure
    Image = None

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "qa" / "shots"
BASE = "http://127.0.0.1:8099/"

GL_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
]

results = {"checks": [], "ok": True}


def check(name, passed, detail=""):
    results["checks"].append({"name": name, "pass": bool(passed), "detail": str(detail)})
    if not passed:
        results["ok"] = False
    print(f"{'PASS' if passed else 'FAIL'}  {name}  {detail}")


def state(page):
    return page.evaluate("() => window.__SKI__.state()")


def sim(page, seconds):
    page.evaluate(f"() => window.__SKI__.simulate({seconds})")


def hold(page, btn):
    return page.evaluate(f"() => window.__SKI__.clickButton('{btn}')")


def release(page, btn):
    return page.evaluate(f"() => window.__SKI__.releaseButton('{btn}')")


def sample(page, points):
    """Average RGB at each (x, y) of the live frame, read back from a screenshot."""
    if Image is None:
        return None
    im = Image.open(io.BytesIO(page.screenshot())).convert("RGB")
    w, h = im.size
    out = []
    for fx, fy in points:
        px = im.getpixel((min(w - 1, int(fx * w)), min(h - 1, int(fy * h))))
        out.append(sum(px) / 3.0)
    return out


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    console_errors = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=GL_ARGS)
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))

        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_function("() => window.__SKI_READY__ === true", timeout=45000)
        check("boot: __SKI_READY__", True)

        renderer = page.evaluate(
            "() => { const c=document.createElement('canvas');"
            "const g=c.getContext('webgl2')||c.getContext('webgl');"
            "return g? g.getParameter(g.VERSION) : 'none'; }"
        )
        check("webgl context", renderer != "none", renderer)

        page.wait_for_timeout(2500)
        page.screenshot(path=str(SHOTS / "01-title.png"))
        cards = page.locator(".resort-card").count()
        check("title: 6 resort cards", cards == 6, f"{cards} cards")

        # -------------------------------------------------- every resort loads
        for rid in page.evaluate("() => window.__SKI__.resorts()"):
            page.evaluate(f"() => window.__SKI__.select('{rid}')")
            page.wait_for_timeout(250)
            page.evaluate("() => window.__SKI__.start()")
            auto = page.evaluate("() => window.__SKI__.autopilot(9)")
            page.wait_for_timeout(900)
            st = page.evaluate("() => window.__SKI__.sceneStats()")
            check(f"resort {rid}: geometry + gates + kickers",
                  st["triangles"] > 5000 and st["gates"] > 0 and st["kickers"] > 0,
                  json.dumps(st))
            # Only the turn buttons are used, so this doubles as proof that the button-only
            # control scheme can actually hold a line down every run.
            check(f"resort {rid}: button-only autopilot stays on the piste",
                  auto["offPiste"] < 0.5 and auto["mode"] == "run",
                  f"x {auto['x']:.1f} vs centre {auto['center']:.1f}, offPiste {auto['offPiste']:.2f}")

            # Regression guards for the scenery bugs fixed in the visual pass.
            geo = page.evaluate("""() => {
              const g = window.__SKI__.dev();
              const chunk = [...g.terrain.chunks.values()][2] || [...g.terrain.chunks.values()][0];
              const n = chunk.geometry.attributes.normal;
              let up = 0;
              for (let i = 0; i < n.count; i++) up += n.getY(i);
              return {
                normalUp: up / n.count,
                massif: !!g.terrain.massif,
                vistaGroupOrder: g.world.vista.renderOrder,
                vistaLayers: g.world.vista.children.length,
                vistaAheadOfTerrain: g.world.vista.children.every(c => c.renderOrder < 0),
                skyBehindVista: g.world.sky.renderOrder < Math.min(...g.world.vista.children.map(c => c.renderOrder)),
              };
            }""")
            check(f"resort {rid}: terrain normals point at the sky", geo["normalUp"] > 0.5,
                  f"mean normal.y = {geo['normalUp']:.2f}")
            check(f"resort {rid}: massif backdrop built", geo["massif"] is True)
            check(f"resort {rid}: vista sorts after the sky, before the terrain",
                  geo["vistaGroupOrder"] == 0 and geo["vistaLayers"] > 0
                  and geo["vistaAheadOfTerrain"] and geo["skyBehindVista"],
                  json.dumps(geo))

            # Deliberately off-centre: the skier occupies the middle of the frame.
            px = sample(page, [(0.5, 0.86), (0.12, 0.72), (0.88, 0.72), (0.24, 0.56), (0.76, 0.56)])
            if px is None:
                check(f"resort {rid}: snow reads as lit snow (needs Pillow)", True, "skipped")
            else:
                check(f"resort {rid}: snow reads as lit snow, not grey concrete",
                      min(px) > 120 and max(px) < 253,
                      "luma " + ", ".join(f"{v:.0f}" for v in px))
                # The strip used to end in mid-air with sky underneath it; the massif has to
                # fill the whole lower frame now.
                check(f"resort {rid}: no sky gap under the piste", min(px[:3]) > 130,
                      "lower-frame luma " + ", ".join(f"{v:.0f}" for v in px[:3]))
            page.screenshot(path=str(SHOTS / f"resort-{rid}.png"))

        # ------------------------------------------------------------ start run
        page.evaluate("() => window.__SKI__.select('palisades-tahoe')")
        page.wait_for_timeout(400)
        page.locator("#btn-start").click()
        s0 = state(page)
        check("run starts via START button", s0["mode"] == "run", s0["mode"])

        sim(page, 4)
        s1 = state(page)
        check("skier accelerates down the fall line",
              s1["speed"] > s0["speed"] + 3 and s1["z"] < s0["z"] - 20 and s1["y"] < s0["y"] - 5,
              f"speed {s0['speed']:.1f}->{s1['speed']:.1f} m/s, descended {s0['y']-s1['y']:.1f} m")
        page.wait_for_timeout(700)
        page.screenshot(path=str(SHOTS / "02-run.png"))

        # ---------------------------------------------- button-only steering
        check("btn-left press sets active state", page.evaluate(
            "() => { window.__SKI__.clickButton('btn-left');"
            "const on = document.getElementById('btn-left').classList.contains('is-active');"
            "window.__SKI__.releaseButton('btn-left'); return on; }"), "")

        before = state(page)
        hold(page, "btn-left")
        sim(page, 1.6)
        mid = state(page)
        release(page, "btn-left")
        check("BUTTON 左转 steers left", mid["heading"] < before["heading"] - 0.2 and mid["x"] < before["x"],
              f"heading {before['heading']:.2f}->{mid['heading']:.2f}, x {before['x']:.1f}->{mid['x']:.1f}")
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / "03-carve-left.png"))

        hold(page, "btn-right")
        sim(page, 2.4)
        right = state(page)
        release(page, "btn-right")
        check("BUTTON 右转 steers right", right["heading"] > mid["heading"] + 0.2,
              f"heading {mid['heading']:.2f}->{right['heading']:.2f}")
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / "04-carve-right.png"))

        # ------------------------------ carving across the fall line costs speed
        # Controlled A/B from an identical clean state (centred on the piste, heading 0).
        page.evaluate("() => window.__SKI__.aimNextGate()")
        sim(page, 3.5)
        straight = state(page)
        page.evaluate("() => window.__SKI__.aimNextGate()")
        hold(page, "btn-left")
        sim(page, 3.5)
        carved = state(page)
        release(page, "btn-left")
        check("carving across the fall line costs speed (real ski behaviour)",
              carved["speed"] < straight["speed"] - 0.5,
              f"straight {straight['speed']:.1f} m/s vs carving {carved['speed']:.1f} m/s "
              f"at heading {carved['heading']:.2f} rad")
        page.evaluate("() => window.__SKI__.aimNextGate()")
        sim(page, 2)

        # ------------------------------------------------------------ snowplow
        pre = state(page)
        hold(page, "btn-brake")
        sim(page, 2.0)
        braked = state(page)
        release(page, "btn-brake")
        check("BUTTON 犁式刹车 slows on a black run", braked["speed"] < pre["speed"] - 2.0,
              f"{pre['speed']:.1f} -> {braked['speed']:.1f} m/s")
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / "05-snowplow.png"))

        # ----------------------------------------------------------- tuck/speed
        sim(page, 2)
        pre = state(page)
        hold(page, "btn-tuck")
        sim(page, 2.5)
        tucked = state(page)
        release(page, "btn-tuck")
        check("BUTTON 收腿加速 gains speed", tucked["speed"] > pre["speed"] + 0.5,
              f"{pre['speed']:.1f} -> {tucked['speed']:.1f} m/s")
        page.wait_for_timeout(600)
        page.screenshot(path=str(SHOTS / "06-tuck.png"))

        # ---------------------------------------------------------------- jump
        hold(page, "btn-jump")
        sim(page, 0.1)
        air = page.evaluate("() => window.__SKI__.state()")
        check("BUTTON 起跳 leaves the ground", air["airborne"] is True, f"airborne={air['airborne']}")
        page.wait_for_timeout(500)
        page.screenshot(path=str(SHOTS / "07-air.png"))
        sim(page, 2.5)
        landed = state(page)
        check("skier lands again", landed["airborne"] is False, f"airborne={landed['airborne']}")

        # --------------------------------------------------------------- gates
        aimed = page.evaluate("() => window.__SKI__.aimNextGate()")
        check("gate lookup works", aimed is not None, json.dumps(aimed))
        hit_before = state(page)["gatesHit"]
        sim(page, 3)
        after = state(page)
        check("passing between the poles scores a gate",
              after["gatesHit"] > hit_before and after["score"] > hit_before,
              f"hit {hit_before} -> {after['gatesHit']}, score {after['score']:.0f}, combo {after['combo']}")

        # ---------------------------------------------------------- finish line
        st = state(page)
        page.evaluate(f"() => window.__SKI__.teleport({st['finishZ'] + 12})")
        sim(page, 6)
        fin = state(page)
        check("crossing the finish shows the results card", fin["mode"] == "results", fin["mode"])
        page.wait_for_timeout(700)
        page.screenshot(path=str(SHOTS / "08-results.png"))
        check("results card rendered", page.locator(".res-medal").count() == 1)
        check("medal + stats populated", page.locator(".res-grid span").count() >= 8,
              f"{page.locator('.res-grid span').count()} stat cells")

        # ------------------------------------------------------------- replay
        page.locator("#btn-retry").click()
        page.wait_for_timeout(900)
        again = state(page)
        check("再滑一次 restarts a fresh run", again["mode"] == "run" and again["runTime"] < 3,
              f"mode={again['mode']} t={again['runTime']:.1f}")

        # -------------------------------------------------------------- pause
        page.locator("#btn-pause").click()
        page.wait_for_timeout(400)
        check("pause button reachable and works", state(page)["mode"] == "paused")
        page.locator("#btn-resume").click()
        page.wait_for_timeout(300)
        check("resume works", state(page)["mode"] == "run")

        # -------------------------------------- mobile layout / no overflow
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(1400)
        overflow = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
        check("mobile 390x844: no horizontal overflow", overflow <= 1, f"overflow={overflow}px")
        check("mobile: turn buttons visible", page.locator("#btn-left").is_visible() and page.locator("#btn-right").is_visible())
        check("mobile: pause not covered by the deck", page.evaluate(
            "() => { const b=document.getElementById('btn-pause').getBoundingClientRect();"
            "const el=document.elementFromPoint(b.x+b.width/2, b.y+b.height/2);"
            "return !!el && (el.id==='btn-pause' || el.closest('#btn-pause')!==null); }"))
        page.screenshot(path=str(SHOTS / "09-mobile.png"))

        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_timeout(600)

        real_errors = [e for e in console_errors if "favicon" not in e.lower()]
        check("no console/page errors", len(real_errors) == 0, "; ".join(real_errors[:4]))

        browser.close()

    out = ROOT / "qa" / "qa-results.json"
    passed = sum(1 for c in results["checks"] if c["pass"])
    results["summary"] = f"{passed}/{len(results['checks'])} passed"
    out.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n{results['summary']} — {'ALL PASS' if results['ok'] else 'FAILURES PRESENT'} -> {out}")
    return 0 if results["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
