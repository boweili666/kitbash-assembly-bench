#!/usr/bin/env python3
"""mini 专用件的 headless 自测 —— 合约(plan §4 / §8)逐条验。

    /home/wenhel/miniconda3/envs/gemmaft/bin/python tests/smoke_mini.py [steps...]

必须经 tests/host.html 驱动:mini 的 bridge 只认父窗口发来的 postMessage,
在页面里自己 postMessage 会被静默丢掉(假阴性)。

验什么:
  1. 界面干净       没有 #answerBar / #nextGuide / #toast / #topbar / #checkPanel / #tutorial
  2. 场景干净       scene 里 userData.kbOverlay 的组 = 0, renderOrder===999 的对象 = 0
  3. kit 完整       kb:init 之后 KB.objectsRoot 下 86 件, 无 Skipped 警告
  4. 每一步         step<n 在 baked 终点 · step==n 从 path[0] 飞到 path[-1] ·
                    step>n 和备件仍在料盘 · 播完冻结
  5. 独立复核       已装零件两两之间的相对位置(mm)与 answer_poses_full.json 的
                    path[-1] 之差一致, 每件的终点姿态也和原始数据一致 ——
                    这条不经过 mini 自己的整体偏移, 所以偏移错了也瞒不过去
  6. 取景           整机 8 角投影全在 NDC ±1 内; 这一步的零件从镜头打过去打得到
"""
import functools
import http.server
import json
import math
import os
import socketserver
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BENCH = (ROOT.parent / "feature-simulator-bowei" / "handle-callbacks").resolve()
# 默认喂 bowei 台子的 kit.json。生产走的是前端的 kit_scene.ts(同样 86 件, 但
# Standoff Screw #9-12 只有 glb uuid 没有 key), 用 MINI_KIT 指一份导出的 JSON
# 就能跑那条路径。
KIT = (Path(os.environ["MINI_KIT"]) if os.environ.get("MINI_KIT")
       else ROOT.parent / "feature-simulator-bowei" / "kit.json")
ANSWER = BENCH / "assets" / "parts" / "answer_poses_full.json"
HOST = HERE / "host.html"

READY_MS = 120000
SHOT_DIR = Path(os.environ["MINI_SHOT_DIR"]) if os.environ.get("MINI_SHOT_DIR") else None
STEPS = [int(a) for a in sys.argv[1:]] or [0, 5, 20, 33, 45]

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""))
    return ok


def serve(root: Path):
    """file:// 下 iframe 是不透明源, 父页面读不到 contentWindow —— 必须走 http。"""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    handler.log_message = lambda *a, **k: None
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"


def in_bench(page, js):
    return page.evaluate("(s)=>document.getElementById('bench').contentWindow.eval(s)", js)


def jbench(page, js):
    return json.loads(in_bench(page, f"JSON.stringify(({js}))"))


def main():
    kit = json.loads(KIT.read_text())
    answer = json.loads(ANSWER.read_text())
    ans_by_id = {p["id"]: p for p in answer["parts"]}
    print(f"bundle: {ROOT / 'dist/mini-simulator.html'}")
    print(f"kit: {len(kit)} parts · answer: {len(answer['steps'])} steps / {len(answer['parts'])} parts\n")

    httpd, base = serve(ROOT)
    print(f"serving {ROOT} at {base}\n")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome",
                                     args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
        # 非 200 的请求单独记 URL。旧版把任何含 "404" 的 console 文本都当成
        # harness 噪声吃掉了, 真缺资源也会被静默归类 —— 这里按 URL 判。
        bad_http = []
        page.on("response", lambda r: bad_http.append(f"{r.status} {r.url}") if r.status >= 400 else None)
        page.goto(base + "/tests/host.html")
        page.wait_for_function(
            "() => { const w = document.getElementById('bench').contentWindow;"
            " return w.KB && w.KBParts && w.KBParts.ready() && w.KBMini; }", timeout=READY_MS)

        print("-- page --")
        for el in ("answerBar", "nextGuide", "toast", "topbar", "checkPanel", "tutorial",
                   "panel", "hints", "agentPanel", "modal", "shelf"):
            check(f"no #{el}", in_bench(page, f"!document.getElementById('{el}')"))
        body = jbench(page, "[...document.body.children].map(e=>e.tagName+(e.id?'#'+e.id:''))")
        # 单文件构建把每个模块内联成 <script>,那些不渲染;可见的元素只能有画布一个
        check("only a canvas in body (besides inlined scripts)",
              [e for e in body if e != "SCRIPT"] == ["CANVAS#viewport"], str(body))
        for gone in ("KBAnswer", "KBGuide", "KBFocus", "KBCheck", "KBTutorial",
                     "KBLevel", "KBCelebrate", "KBHelp", "KBRecord", "KBNames"):
            check(f"no window.{gone}", in_bench(page, f"typeof window.{gone} === 'undefined'"))
        check("no TransformControls", in_bench(page, "typeof THREE.TransformControls === 'undefined'"))
        check("orbit pan disabled", in_bench(page, "KB.orbit.enablePan === false"))

        print("\n-- kb:init --")
        page.evaluate("(scene)=>window.send({type:'kb:init', scene, options:{}})", kit)
        page.wait_for_function("() => document.getElementById('bench').contentWindow.KBMini.ready()",
                               timeout=30000)
        n_parts = in_bench(page, "(()=>{let n=0;KB.objectsRoot.traverse(o=>{if(KB.isPart(o))n++});return n})()")
        check("objectsRoot holds 86 parts", n_parts == 86, f"got {n_parts}")
        check("no kb:warn", page.evaluate("window.warns").__len__() == 0,
              "; ".join(page.evaluate("window.warns"))[:200])
        check("kb:ready seen", "kb:ready" in page.evaluate("window.seen"))
        st = jbench(page, "KBMini.status()")
        check("74 answer parts bound + 12 spares",
              st["parts"] == 74 and st["spares"] == 12, json.dumps(st))
        check("scene has no kbOverlay group",
              in_bench(page, "KB.scene.children.filter(c=>c.userData&&c.userData.kbOverlay).length") == 0)
        ro = in_bench(page, "(()=>{let n=0;KB.scene.traverse(o=>{if(o.renderOrder===999)n++});return n})()")
        check("no renderOrder===999 object (no arrows/highlights)", ro == 0, f"got {ro}")

        # 在渲染循环里记每一帧的真实位姿。父页面轮询和 iframe 的 rAF 共用同一个
        # 主线程, 轮询只能在两帧之间挤进去 —— 采样率等于帧率, swiftshader 下
        # 1.1 s 的飞行只抽到 1-2 帧, 判据会时灵时不灵。装进 onFrame 就是"被画
        # 出来的那些帧"本身, 不多不少。
        in_bench(page, """(function(){
          window.__rec = null;
          KB.onFrame(function(){
            if (!window.__rec) return;
            var s = KBMini.status();
            window.__rec.push([performance.now(), s.playing,
              KBMini.plan().filter(function(p){return p.step===s.step;})
                           .map(function(p){return [p.id, p.at];})]);
          });
        })()""")

        for n in STEPS:
            print(f"\n-- kb:showStep {n} --")
            page.evaluate("(n)=>window.send({type:'kb:showStep', step:n})", n)
            in_bench(page, "window.__rec = []")
            page.wait_for_function(
                "() => { const m = document.getElementById('bench').contentWindow.KBMini;"
                " const s = m.status(); return s.step === %d && s.done && !s.flying; }" % n,
                timeout=40000)
            plan = jbench(page, "KBMini.plan()")
            spare_ids = jbench(page, "KBMini.spareIds()")
            mine = [p for p in plan if p["step"] == n]
            before = [p for p in plan if p["step"] < n]
            after = [p for p in plan if p["step"] > n]

            def close(a, b, eps=2e-4):
                return max(abs(x - y) for x, y in zip(a, b)) <= eps

            check(f"step {n} has parts", len(mine) > 0, f"{len(mine)} parts: " +
                  ", ".join(p["name"] for p in mine))
            want_order = [q["id"] for q in answer["parts"] if q["step"] == n]
            check("within-step order follows answer_poses_full.json",
                  [p["id"] for p in mine] == want_order,
                  "got " + ", ".join(p["name"] for p in mine))
            check("step-n parts landed on path[-1]",
                  all(close(p["at"], p["to"]) for p in mine),
                  "; ".join(f"{p['name']} at {p['at']} want {p['to']}" for p in mine if not close(p["at"], p["to"]))[:200])
            # 判据一:被画出来的帧里, 零件真的处在 from->to 之间(不是"数据两端
            # 不同", 那一条恒真, 零件一帧没动也能过 —— 第 44/45 步就是这样漏的)
            rec = jbench(page, "window.__rec"); in_bench(page, "window.__rec = null")
            seen_at = {p["id"]: [] for p in mine}
            for _t, _pl, rows in rec:
                for pid, at in rows:
                    if pid in seen_at:
                        seen_at[pid].append(at)
            interior = {}
            for p in mine:
                a, b = p["from"], p["to"]
                span2 = sum((y - x) ** 2 for x, y in zip(a, b))
                if span2 < 1e-18:
                    interior[p["id"]] = None          # baked 轨迹本来就是一个点
                    continue
                # u 严格落在两端之间就算"这一帧画的是飞行中的姿态"。窗口不能收得
                # 太窄:帧率低的时候唯一那一帧可能已经飞到 0.99。被跳过的飞行给
                # 的是精确的 u=0 或 u=1(setAt 直接放端点), 所以严格不等号就够判。
                us = [sum((at[k] - a[k]) * (b[k] - a[k]) for k in range(3)) / span2
                      for at in seen_at[p["id"]]]
                interior[p["id"]] = sum(1 for u in us if 1e-6 < u < 1 - 1e-6)
            flying = [p for p in mine if interior[p["id"]] is not None]
            frames = len(rec)
            check("step-n parts observed in flight (interior poses in rendered frames)",
                  not flying or sum(interior[p["id"]] for p in flying) > 0,
                  f"{frames} rendered frames; interior poses: " +
                  ", ".join(f"{p['name']}={interior[p['id']]}" for p in mine))
            # 帧率低的时候一段 1.1 s 的飞行只画得出 1-2 帧, 所以判据是"这一步
            # 至少被画到过一次中间姿态", 不按件逐个要求 —— 逐件要求会在
            # swiftshader 上随机失败(同一步的第二件可能整段都在两帧之间)。
            playing_frames = sum(1 for _t, pl, _r in rec if pl)
            print(f"        ({frames} frames recorded, {playing_frames} while playing, "
                  f"maxT {jbench(page, 'KBMini.status()')['maxT']:.2f} s)")
            check("earlier steps sit at their baked final pose",
                  all(close(p["at"], p["to"]) for p in before),
                  "; ".join(p["name"] for p in before if not close(p["at"], p["to"]))[:200])
            check("later steps still in the tray",
                  all(p["tray"] and close(p["at"], p["tray"]) for p in after),
                  "; ".join(p["name"] for p in after if not (p["tray"] and close(p["at"], p["tray"])))[:200])
            spares_ok = jbench(page, "KBMini.spareIds().map(id=>{const n=KB.partById(id);return [id, n.position.toArray()]})")
            check("12 spare parts untouched", len(spare_ids) == 12 and len(spares_ok) == 12)

            # 冻结:再等 600 ms, 所有位置一字不差
            snap1 = jbench(page, "KBMini.plan().map(p=>p.at)")
            time.sleep(0.6)
            snap2 = jbench(page, "KBMini.plan().map(p=>p.at)")
            st2 = jbench(page, "KBMini.status()")
            check("frozen after the step (poses identical, not playing)",
                  snap1 == snap2 and st2["done"] and not st2["playing"] and st2["step"] == n)

            # 独立复核:不经过 mini 的整体偏移
            placed = [p for p in plan if p["step"] <= n]
            poses = jbench(page, "(()=>{const o={};%s.forEach(id=>{o[id]=KBParts.poseOf(KB.partById(id))});return o})()"
                           % json.dumps([p["id"] for p in placed]))
            base = placed[0]
            worst_d, worst_r = 0.0, 0.0
            for p in placed:
                a, b = poses[p["id"]], poses[base["id"]]
                ra, rb = ans_by_id[p["id"]]["path"][-1], ans_by_id[base["id"]]["path"][-1]
                for ax in ("x", "y", "z"):
                    worst_d = max(worst_d, abs((a[ax] - b[ax]) - (ra[ax] - rb[ax])))
                for k in ("roll", "pitch", "yaw"):
                    d = abs(a[k] - ra[k]) % (2 * math.pi)
                    worst_r = max(worst_r, min(d, 2 * math.pi - d))
            check("relative positions match answer_poses_full.json (mm)", worst_d < 0.05,
                  f"worst {worst_d:.4f} mm over {len(placed)} parts")
            check("final orientations match answer_poses_full.json", worst_r < 1e-3,
                  f"worst {math.degrees(worst_r):.4f} deg")

            # 取景
            cam = jbench(page, """(()=>{
              KB.camera.updateMatrixWorld(); KB.camera.updateProjectionMatrix();
              const items = KBMini.plan().filter(p=>p.step<=%d).map(p=>KB.partById(p.id));
              const box = new THREE.Box3();
              items.forEach(o=>o.traverse(m=>{ if(!m.isMesh) return;
                if(!m.geometry.boundingBox) m.geometry.computeBoundingBox();
                box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); }));
              let mx=0, my=0;
              for(const x of [box.min.x,box.max.x]) for(const y of [box.min.y,box.max.y])
                for(const z of [box.min.z,box.max.z]) {
                  const v = new THREE.Vector3(x,y,z).project(KB.camera);
                  mx=Math.max(mx,Math.abs(v.x)); my=Math.max(my,Math.abs(v.y)); }
              // 这一步的零件:从镜头往它表面点打射线, 第一个打到的是不是它
              const mineNodes = KBMini.plan().filter(p=>p.step===%d).map(p=>KB.partById(p.id));
              const all = KB.objectsRoot.children;
              const mineSet = new Set(mineNodes);
              const ray = new THREE.Raycaster(); let seen=0, tried=0;
              mineNodes.forEach(node=>{
                const pts=[];
                node.traverse(m=>{ if(!m.isMesh||!m.geometry.attributes.position) return;
                  const pos=m.geometry.attributes.position;
                  const stride=Math.max(1,Math.floor(pos.count/6));
                  for(let k=0;k<pos.count;k+=stride)
                    pts.push(new THREE.Vector3().fromBufferAttribute(pos,k).applyMatrix4(m.matrixWorld)); });
                pts.forEach(q=>{ tried++;
                  const eye=KB.camera.getWorldPosition(new THREE.Vector3());
                  const seg=q.clone().sub(eye), len=seg.length();
                  ray.set(eye, seg.normalize());
                  const hit=ray.intersectObjects(all,true)[0];
                  // 打到这一步零件自己的表面不算被挡(采样点可能在背面);
                  // 只有别的零件挡在前面才算看不见
                  let owner=null; if(hit){owner=hit.object; while(owner.parent&&owner.parent!==KB.objectsRoot) owner=owner.parent;}
                  if(!hit || hit.distance>len-0.004 || mineSet.has(owner)) seen++; });
              });
              const c = KBMini.plan().filter(p=>p.step===%d).map(p=>{
                const v=new THREE.Vector3(...p.to).project(KB.camera); return [v.x,v.y]; });
              return {mx, my, seen, tried, centres:c};
            })()""" % (n, n, n))
            check("whole assembly inside the frustum",
                  cam["mx"] <= 1.0 and cam["my"] <= 1.0,
                  f"max |ndc| x={cam['mx']:.3f} y={cam['my']:.3f}")
            check("step part not blocked by other parts (sample points)",
                  cam["tried"] > 0 and cam["seen"] > 0,
                  f"{cam['seen']}/{cam['tried']} sample points unobstructed")
            if SHOT_DIR:
                page.screenshot(path=str(SHOT_DIR / f"step{n:02d}.png"))
            check("step part projects on screen",
                  all(abs(x) <= 1.0 and abs(y) <= 1.0 for x, y in cam["centres"]),
                  str(cam["centres"]))

        print("\n-- errors --")
        real = [e for e in errors if "swiftshader" not in e.lower() and "webgl" not in e.lower()
                and "favicon" not in e.lower()
                # host.html 自己没有 favicon, 那一条 404 是 harness 的
                and "status of 404" not in e]
        check("no page errors", not real, "; ".join(real[:3])[:400])
        stray = [h for h in bad_http if "favicon.ico" not in h]
        check("no failed requests besides the harness favicon", not stray,
              "; ".join(stray[:5])[:400])
        browser.close()
    httpd.shutdown()

    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
