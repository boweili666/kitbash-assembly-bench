#!/usr/bin/env python3
"""mini 和宿主(ARISTOS 前端)之间那份合约的自测 —— 和 smoke_mini.py 互补。

    /home/wenhel/miniconda3/envs/gemmaft/bin/python tests/smoke_host_contract.py

smoke_mini.py 发的是整数 step, 但**生产里前端发的是 uuid**:
`MiniSimulator.tsx` 收到的 step 来自 `step_map.json` 的 `map[<任务图节点 uuid>]`,
值是台子这边的 step uuid。这个脚本验的就是那条真实路径:

  1. step_map.json 的 46 个非空值, 每个都能被 KBMini.stepIndex 解成一个
     不重复的 0..45 —— 这是前端点一个节点能不能演对那一步的唯一判据
  2. 按名兜底(kb:init 的 stepNames)真的能用:uuid 故意写错时, 传 stepNames
     还能落到同一步 —— 生产里没有调用方传 stepNames, 所以这条只是保底路径
  3. 重播:再发一次同一个 kb:showStep(宿主那个 Replay 按钮做的就是这件事),
     零件从 path[0] 重新飞一遍, 不是原地不动 —— 所以 mini 自己不需要按钮
"""
import functools
import http.server
import json
import socketserver
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BENCH = (ROOT.parent / "feature-simulator-bowei" / "handle-callbacks").resolve()
KIT = ROOT.parent / "feature-simulator-bowei" / "kit.json"
STEP_MAP = (ROOT.parents[1] / "gin-dev-latest" / "external" / "aristos_frontend"
            / "src" / "components" / "Simulator" / "step_map.json")

results = []


def check(name, ok, detail=""):
    results.append(bool(ok))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))


def serve(root: Path):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    handler.log_message = lambda *a, **k: None
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def in_bench(page, js):
    return page.evaluate("(s)=>document.getElementById('bench').contentWindow.eval(s)", js)


def jbench(page, js):
    return json.loads(in_bench(page, f"JSON.stringify(({js}))"))


# 在渲染循环里记每一帧(父页面轮询只能在两帧之间挤进去, 采样率等于帧率)。
REC = """(function(){
  window.__rec = null;
  KB.onFrame(function(){
    if (!window.__rec) return;
    var s = KBMini.status();
    window.__rec.push([s.playing, KBMini.plan().filter(function(p){return p.step===s.step;})
      .map(function(p){return [p.id, p.at];})]);
  });
})()"""

# 等 playing 起来再等 done。只等 done 是错的:重播前 status 已经是 done,
# 循环会在消息处理之前就退出 —— 看起来"重播没动", 其实是在量空气。
FLIGHT = """async ([ref, idx]) => {
  const w = document.getElementById('bench').contentWindow;
  w.__rec = [];
  let sawPlaying = false;
  w.postMessage({type: 'kb:showStep', step: ref}, '*');
  const t0 = Date.now();
  for (;;) {
    const s = w.KBMini.status();
    if (s.step === idx && s.playing) sawPlaying = true;
    if (sawPlaying && s.step === idx && s.done && !s.flying) break;
    if (Date.now() - t0 > 60000) break;
    await new Promise(r => setTimeout(r, 20));
  }
  const rec = w.__rec; w.__rec = null;
  return { rec: rec, sawPlaying: sawPlaying };
}"""

def interior(rec, mine):
    """每件在被画出来的帧里落在 from->to 之间的次数(严格不等号:被跳过的飞行
    给的是精确的端点)。"""
    per = {}
    for p in mine:
        a, b = p["from"], p["to"]
        span2 = sum((y - x) ** 2 for x, y in zip(a, b))
        if span2 < 1e-18:
            per[p["id"]] = None
            continue
        n = 0
        for _playing, rows in rec:
            for pid, at in rows:
                if pid != p["id"]:
                    continue
                u = sum((at[k] - a[k]) * (b[k] - a[k]) for k in range(3)) / span2
                if 1e-6 < u < 1 - 1e-6:
                    n += 1
        per[p["id"]] = n
    return per


def lowest_u(rec, mine):
    """重播有没有从头开始:回到 u < 0.5 才算重新起飞, 而不是从终点原地抖一下。"""
    best = 9e9
    for p in mine:
        a, b = p["from"], p["to"]
        span2 = sum((y - x) ** 2 for x, y in zip(a, b))
        if span2 < 1e-18:
            continue
        for _playing, rows in rec:
            for pid, at in rows:
                if pid != p["id"]:
                    continue
                best = min(best, sum((at[k] - a[k]) * (b[k] - a[k]) for k in range(3)) / span2)
    return best


def main():
    if not STEP_MAP.exists():
        raise SystemExit(f"step_map.json not found at {STEP_MAP}")
    kit = json.loads(KIT.read_text())
    smap = json.loads(STEP_MAP.read_text())["map"]
    uuids = [v for v in smap.values() if v]
    print(f"step_map: {len(smap)} nodes, {len(uuids)} carry a bench step uuid "
          f"({len(set(uuids))} distinct)\n")

    httpd, base = serve(ROOT)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome",
                                     args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(base + "/tests/host.html")
        page.wait_for_function(
            "() => { const w = document.getElementById('bench').contentWindow;"
            " return w.KB && w.KBParts && w.KBParts.ready() && w.KBMini; }", timeout=120000)
        page.evaluate("(scene)=>window.send({type:'kb:init', scene, options:{}})", kit)
        page.wait_for_function(
            "() => document.getElementById('bench').contentWindow.KBMini.ready()", timeout=30000)

        print("-- step_map uuid -> step index (the path the frontend actually uses) --")
        idx = {u: in_bench(page, "KBMini.stepIndex(%s)" % json.dumps(u)) for u in set(uuids)}
        bad = {u: i for u, i in idx.items() if not (isinstance(i, int) and 0 <= i <= 45)}
        check("every step_map uuid resolves to a step index", not bad,
              f"{len(bad)} unresolved: {list(bad)[:3]}")
        check("they cover all 46 steps, one each",
              sorted(idx.values()) == list(range(46)),
              f"{len(set(idx.values()))} distinct indices from {len(idx)} uuids")
        step_ids = jbench(page, "KBParts.answer().steps.map(s=>s.id)")
        check("uuid set == the manifest's own step ids", set(uuids) == set(step_ids),
              f"map-only {len(set(uuids) - set(step_ids))}, manifest-only {len(set(step_ids) - set(uuids))}")

        print("\n-- by-name fallback (kb:init stepNames) --")
        names = jbench(page, "KBParts.answer().steps.map(s=>s.name)")
        fake = "00000000-dead-beef-0000-000000000000"
        check("an unknown uuid alone does not resolve",
              in_bench(page, "KBMini.stepIndex(%s)" % json.dumps(fake)) == -1)
        got = in_bench(page, "KBMini.stepIndex(%s, %s)"
                       % (json.dumps(fake), json.dumps({fake: names[20]})))
        check("with stepNames it resolves by name", got == 20, f"got {got}")

        print("\n-- replay: the host Replay button re-sends the same kb:showStep --")
        in_bench(page, REC)
        ref = step_ids[20]
        r1 = page.evaluate(FLIGHT, [ref, 20])
        plan = jbench(page, "KBMini.plan()")
        mine = [p for p in plan if p["step"] == 20]
        i1 = interior(r1["rec"], mine)
        check("first play: the bench reported it playing", r1["sawPlaying"])
        check("first play travelled through interior poses",
              all(v > 0 for v in i1.values() if v is not None),
              f"{len(r1['rec'])} frames; " + ", ".join(f"{p['name']}={i1[p['id']]}" for p in mine))
        plan1 = jbench(page, "KBMini.plan()")
        check("landed on path[-1]",
              all(max(abs(x - y) for x, y in zip(p["at"], p["to"])) < 2e-4
                  for p in plan1 if p["step"] == 20))

        r2 = page.evaluate(FLIGHT, [ref, 20])
        i2 = interior(r2["rec"], mine)
        check("replay: the bench reported it playing again", r2["sawPlaying"])
        check("replay travelled again (not a no-op)",
              all(v > 0 for v in i2.values() if v is not None),
              f"{len(r2['rec'])} frames; " + ", ".join(f"{p['name']}={i2[p['id']]}" for p in mine))
        lo = lowest_u(r2["rec"], mine)
        check("replay starts over from path[0], not from where it ended", lo < 0.5,
              f"lowest u seen on replay = {lo:.3f}")
        plan2 = jbench(page, "KBMini.plan()")
        check("replay lands on path[-1] again",
              all(max(abs(x - y) for x, y in zip(p["at"], p["to"])) < 2e-4
                  for p in plan2 if p["step"] == 20))

        check("no page errors", not errors, "; ".join(errors[:3])[:300])
        browser.close()
    httpd.shutdown()
    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
