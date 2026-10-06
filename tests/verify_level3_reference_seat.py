#!/usr/bin/env python3
"""Level-3 click-mate seats at the answer pose, driven by the real mouse.

The bug this guards: at level 3 a click-mate went through mate.js geometry,
which only aligns the two hole axes -- the turn about the axis was whatever
the part lay at in the tray (the step-1 screw ended up 90 deg off the answer).
levelrules.js now says level 3 seats a correct pair at the reference pose
(the level-2 path) and lets a wrong pair seat by geometry and report.

Every hole click below is a page.mouse.click on the disc the bench drew; the
only programmatic setup is translating the receiving part into the workspace
(the same XZ move a grid click does).

Cases, each on a fresh page:
  l3-correct     L3, Step-1 screw P1 (in the tray) -> Left Arm Wedge H1:
                 orientation equals the answer pose (< 2 deg), Step 1 complete,
                 seated without mate.js (no snapAttempt), then the arrow keys
                 still turn about / slide along the hole axis.
  l3-xlock       L3, both wedge assemblies built by mouse (screw P1 -> wedge
                 H1, auto-grouped by the bench), the left one turned 90 deg with
                 the bench's own yaw (click it, Shift+ArrowLeft), then each
                 screw P1 -> X-Lock H10 by mouse: each wedge lands at its answer
                 pose (< 2 deg) and Step 3 completes.
  l3-wrong       L3, Step-1 screw P1 -> X-Lock H2 (a wrong hole): seats by
                 geometry (snapAttempt success) and an error is reported.
  l3-later       L3, Step-2 screw P1 -> Right Arm Wedge H1 while Step 1 is
                 current: treated as a wrong mate -> geometry seat, no reference.
  l2-correct     L2, same pair as l3-correct: reference seat, Step 1 complete.
  l2-later       L2, same pair as l3-later: refused, the screw does not move.

    python tests/verify_level3_reference_seat.py (--root DIR | --url PAGE) [--case NAME ...] [--shots DIR]
"""
import argparse
import functools
import http.server
import json
import socketserver
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

BENCH = Path(__file__).resolve().parents[1]
CASES = ["l3-correct", "l3-xlock", "l3-wrong", "l3-later", "l2-correct", "l2-later"]

HELPERS = r"""
() => {
  const T = {};
  T.sleep = ms => new Promise(r => setTimeout(r, ms));
  T.byId = id => { let f = null; KB.objectsRoot.traverse(n => { if (KB.isPart(n) && n.userData.kbId === id) f = n; }); return f; };
  T.top = n => { while (n.parent && n.parent !== KB.objectsRoot) n = n.parent; return n; };
  T.slot = (step, key) => KBCheck.ref().slots.find(s => s.step === step && s.key === key);
  T.feature = (node, id, end) => {
    const spec = KBParts.spec(node.userData.kbType.slice(5));
    const list = id[0] === 'H' ? spec.holes : spec.pegs;
    return KBMate.worldFeature({ node, f: list.find(f => f.id === id), kind: id[0] === 'H' ? 'hole' : 'peg', end: end || 0 });
  };
  T.events = [];
  ['snapAttempt', 'handleMatch'].forEach(k => KB.on(k, e => T.events.push({ k, success: !!e.success,
    reason: e.reason || e.error || null, o1: e.object1 ? e.object1.name : (e.a && e.a.node ? e.a.node.name : null) })));
  // 把接收件平移进装配区(只动 XZ,和点网格挪零件一样),不碰朝向
  T.intoWorkspace = (node, dx) => {
    const c = KBWorkspace.center, top = T.top(node);
    top.position.x += c.x + dx - node.getWorldPosition(new THREE.Vector3()).x;
    top.position.z += c.z - node.getWorldPosition(new THREE.Vector3()).z;
    top.updateMatrixWorld(true);
    KB.pushSnapshot();
    KBCheck.evaluate();
    if (!KBWorkspace.contains(top)) throw new Error(node.name + ' did not land inside the workspace');
  };
  // 镜头对着这个孔口 / 销:沿孔口外法线(或销尖)稍微抬高一点看过去
  T.frame = async (node, id, end) => {
    const f = T.feature(node, id, end);
    const out = (f.n || f.tip || f.d).clone().normalize();
    const dir = out.clone().add(new THREE.Vector3(0, 0.7, 0)).normalize();
    const at = f.mouth || f.c;
    KB.flyCamera(at.clone().addScaledVector(dir, 2.2).toArray(), at.toArray());
    await T.sleep(1600);
  };
  // 页面自己画出来的圆片在屏幕上的位置(用户看到的就是这个)
  T.discs = (node, id) => {
    const out = {};
    KB.scene.traverse(o => {
      const m = o.userData && o.userData.marker;
      if (!m || m.node !== node || m.f.id !== id || !o.visible) return;
      let vis = true; for (let p = o; p; p = p.parent) if (!p.visible) vis = false;
      if (!vis) return;
      const v = o.getWorldPosition(new THREE.Vector3()).project(KB.camera);
      if (v.z > 1) return;
      out[m.end] = { end: m.end, x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight, z: v.z };
    });
    return Object.values(out);
  };
  T.settle = async () => {
    for (let i = 0; i < 80; i++) {
      if (!(KB.tweening && KB.tweening()) && !KBLevel.busy() && !KB.interacting()) break;
      await T.sleep(100);
    }
    await T.sleep(900);
    KBCheck.evaluate();
  };
  T.pose = node => {
    node.updateMatrixWorld(true);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    node.matrixWorld.decompose(p, q, s);
    return { p: p.toArray(), q: q.toArray() };
  };
  // 答案位姿(相对接收件现在的位置):接收件世界 x 它在答案里的逆 x 零件在答案里的位姿
  T.answerPose = (part, partSlot, host, hostSlot) => {
    host.updateMatrixWorld(true);
    const M = host.matrixWorld.clone().multiply(hostSlot.Minv).multiply(partSlot.M);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    M.decompose(p, q, s);
    return { p, q, M };
  };
  // 答案里螺丝头(P2)在孔的哪一侧:点那一侧的孔口
  T.entryEnd = (screw, screwSlot, host, hostSlot, hostFeat) => {
    const want = T.answerPose(screw, screwSlot, host, hostSlot), f = T.feature(host, hostFeat || 'H1', 1);
    const spec = KBParts.spec(screw.userData.kbType.slice(5));
    const head = new THREE.Vector3().fromArray(spec.pegs.find(x => x.id === 'P2').c).applyMatrix4(want.M);
    return head.sub(f.c).dot(f.d) > 0 ? 1 : -1;
  };
  window.__T = T;
  return true;
}
"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(root):
    handler = functools.partial(QuietHandler, directory=str(root))
    server = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def open_bench(browser, base, level):
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.goto(f"{base}?tools=1&level={level}")
    page.wait_for_function("() => window.KB && KBParts && KBParts.ready() && KBCheck && KBCheck.ref() && window.KBMate",
                           timeout=120000)
    page.evaluate(f"() => {{ try {{ localStorage.clear(); }} catch (e) {{}} KBLevel.set({level}, true); }}")
    page.evaluate("async () => { KB.loadKit(); await new Promise(r => setTimeout(r, 1500)); KBCheck.evaluate(); }")
    page.evaluate(HELPERS)
    return page


def click_disc(page, node_expr, fid, end_expr):
    """Frame the feature, then click its disc with the real mouse."""
    page.evaluate(f"async () => {{ const T = __T; await T.frame({node_expr}, '{fid}', {end_expr}); }}")
    discs = page.evaluate(f"() => __T.discs({node_expr}, '{fid}')")
    if not discs:
        raise AssertionError(f"no visible disc for {node_expr} {fid}")
    want_end = page.evaluate(f"() => {end_expr}")
    pick = [d for d in discs if d["end"] == want_end] or sorted(discs, key=lambda d: d["z"])
    d = pick[0]
    page.mouse.click(d["x"], d["y"])
    page.wait_for_timeout(250)
    return d


def arm_source(page, node_expr, fid):
    # 圆片只画在选中的零件上:先点零件本体选中它,再点它的孔 / 销
    page.evaluate(f"async () => {{ const T = __T; await T.frame({node_expr}, '{fid}', 0); }}")
    xy = page.evaluate(f"""() => {{ const n = {node_expr}; const c = new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3()).project(KB.camera);
      return [(c.x + 1) / 2 * innerWidth, (1 - c.y) / 2 * innerHeight]; }}""")
    page.mouse.click(xy[0], xy[1])
    page.wait_for_timeout(400)
    click_disc(page, node_expr, fid, "0")
    armed = page.evaluate(f"() => {{ const a = KBMate.armed(); return a && a.node === {node_expr} && a.id === '{fid}'; }}")
    if not armed:
        raise AssertionError(f"clicking the {fid} disc did not arm it")


SETUP_STEP1 = """() => {
  const T = __T;
  T.W = T.slot(0, 'aluminum_arm_wedge_5mm'); T.S = T.slot(0, 'screw_m3x16_socket_cap');
  T.w = T.byId(T.W.id); T.s = T.byId(T.S.id);
  if (!T.w || !T.s) throw new Error('Step 1 wedge / screw missing from the kit');
  if (KBWorkspace.contains(T.top(T.s))) throw new Error('the screw must start in the tray');
  T.intoWorkspace(T.w, 0);
  // 孔口:螺丝在答案里从哪一侧进去就点哪一侧
  T.hostEnd = T.entryEnd(T.s, T.S, T.w, T.W);
  T.before = T.pose(T.s);
  return { screw: T.s.name, wedge: T.w.name, next: KBCheck.next().name };
}"""

CHECK_REFERENCE = """() => {
  const T = __T;
  const want = T.answerPose(T.s, T.S, T.w, T.W), got = T.pose(T.s);
  const q = new THREE.Quaternion().fromArray(got.q);
  // 楔块自己有 180 度对称(绕孔轴):转半圈的那个也是答案
  const axis = T.feature(T.w, 'H1', 0).d.clone().normalize();
  const alt = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI).multiply(want.q.clone());
  const deg = THREE.MathUtils.radToDeg(Math.min(q.angleTo(want.q), q.angleTo(alt)));
  const off = new THREE.Vector3().fromArray(got.p).distanceTo(want.p);
  const step = KBCheck.state().steps.find(s => s.index === 0);
  return { deg, offMm: off * 1000 / KBParts.unitScale(), step: step && step.state,
           snaps: T.events.filter(e => e.k === 'snapAttempt').length,
           matches: T.events.filter(e => e.k === 'handleMatch') };
}"""

ARROWS = """async () => {
  const T = __T, top = T.top(T.s);
  const h = KBMate.hingeFor(top);
  if (!h) return { hinge: false };
  const dir = h.dir.clone().normalize();
  const pose = () => { top.updateMatrixWorld(true); return { p: top.getWorldPosition(new THREE.Vector3()), q: top.getWorldQuaternion(new THREE.Quaternion()) }; };
  return { hinge: true, dir: dir.toArray(), pose0: (() => { const x = pose(); return { p: x.p.toArray(), q: x.q.toArray() }; })() };
}"""


def arrow_delta(page, key):
    page.keyboard.press(key)
    page.wait_for_timeout(200)
    return page.evaluate("""() => { const T = __T, top = T.top(T.s); top.updateMatrixWorld(true);
      return { p: top.getWorldPosition(new THREE.Vector3()).toArray(), q: top.getWorldQuaternion(new THREE.Quaternion()).toArray() }; }""")


def check_arrows(page):
    base = page.evaluate(ARROWS)
    if not base["hinge"]:
        raise AssertionError("no hinge after the seat: KBMate.hingeFor(screw) is null, arrow keys are dead")
    r = page.evaluate("""([a, b, dir]) => {
      const qa = new THREE.Quaternion().fromArray(a.q), qb = new THREE.Quaternion().fromArray(b.q);
      const d = qb.clone().multiply(qa.clone().invert());
      const ang = 2 * Math.acos(Math.min(1, Math.abs(d.w)));
      const ax = new THREE.Vector3(d.x, d.y, d.z); if (ax.lengthSq() > 1e-12) ax.normalize();
      return { deg: THREE.MathUtils.radToDeg(ang), axisDot: Math.abs(ax.dot(new THREE.Vector3().fromArray(dir))) };
    }""", [base["pose0"], arrow_delta(page, "ArrowLeft"), base["dir"]])
    if not (0.9 < r["deg"] < 1.1 and r["axisDot"] > 0.999):
        raise AssertionError(f"ArrowLeft did not turn 1 deg about the hole axis: {r}")
    back = arrow_delta(page, "ArrowRight")
    r2 = page.evaluate("""([a, b]) => THREE.MathUtils.radToDeg(new THREE.Quaternion().fromArray(a.q).angleTo(new THREE.Quaternion().fromArray(b.q)))""",
                       [base["pose0"], back])
    if r2 > 0.05:
        raise AssertionError(f"ArrowRight did not turn back: {r2} deg left")
    up = arrow_delta(page, "ArrowUp")
    r3 = page.evaluate("""([a, b, dir]) => { const d = new THREE.Vector3().fromArray(b.p).sub(new THREE.Vector3().fromArray(a.p));
      const along = d.dot(new THREE.Vector3().fromArray(dir));
      return { alongMm: along * 1000 / KBParts.unitScale(), sideMm: d.sub(new THREE.Vector3().fromArray(dir).multiplyScalar(along)).length() * 1000 / KBParts.unitScale() }; }""",
                       [base["pose0"], up, base["dir"]])
    if not (0.2 < r3["alongMm"] < 0.3 and r3["sideMm"] < 1e-3):
        raise AssertionError(f"ArrowUp did not slide 0.25 mm along the hole axis: {r3}")
    arrow_delta(page, "ArrowDown")
    return {"turn_deg": round(r["deg"], 3), "slide_mm": round(r3["alongMm"], 3)}


def case_correct(page, level):
    info = page.evaluate(SETUP_STEP1)
    arm_source(page, "__T.s", "P1")
    click_disc(page, "__T.w", "H1", "__T.hostEnd")
    page.evaluate("() => __T.settle()")
    r = page.evaluate(CHECK_REFERENCE)
    if r["deg"] >= 2:
        raise AssertionError(f"seated {r['deg']:.1f} deg off the answer pose ({info['screw']} -> {info['wedge']} H1)")
    if r["offMm"] >= 3.2:
        raise AssertionError(f"seated {r['offMm']:.1f} mm off the answer position")
    if r["step"] != "complete":
        raise AssertionError(f"Step 1 is {r['step']}, not complete")
    if r["snaps"]:
        raise AssertionError("seated through mate.js geometry (snapAttempt fired), not the reference path")
    if not any(m["success"] for m in r["matches"]):
        raise AssertionError(f"no successful handleMatch reported: {r['matches']}")
    out = {"deg": round(r["deg"], 3), "offMm": round(r["offMm"], 3), "step1": r["step"]}
    if level == 3:
        out.update(check_arrows(page))
    return out


def case_l3_wrong(page):
    page.evaluate(SETUP_STEP1)
    page.evaluate("""() => { const T = __T; T.X = T.slot(2, 'aluminum_x_lock'); T.x = T.byId(T.X.id);
      if (!T.x) throw new Error('X-Lock missing'); T.intoWorkspace(T.x, 2.5); }""")
    arm_source(page, "__T.s", "P1")
    click_disc(page, "__T.x", "H2", "1")
    page.evaluate("() => __T.settle()")
    r = page.evaluate("""() => { const T = __T, st = KBCheck.state();
      return { inWork: KBWorkspace.contains(T.top(T.s)), moved: new THREE.Vector3().fromArray(T.pose(T.s).p).distanceTo(new THREE.Vector3().fromArray(T.before.p)),
               snaps: T.events.filter(e => e.k === 'snapAttempt'), issues: st.issues.filter(i => i.objectId === T.S.id && i.severity === 'error').map(i => i.kind + ': ' + i.message) }; }""")
    if not any(e["success"] for e in r["snaps"]):
        raise AssertionError(f"wrong hole was not seated by geometry: {r['snaps']}")
    if not r["inWork"] or r["moved"] < 0.5:
        raise AssertionError("the screw did not move into the X-Lock hole")
    if not r["issues"]:
        raise AssertionError("the wrong hole was seated but no error was reported for the screw")
    return {"seated": True, "issue": r["issues"][0][:90]}


SETUP_LATER = """() => {
  const T = __T;
  T.RW = T.slot(1, 'aluminum_arm_wedge_5mm'); T.RS = T.slot(1, 'screw_m3x16_socket_cap');
  T.rw = T.byId(T.RW.id); T.rs = T.byId(T.RS.id);
  if (!T.rw || !T.rs) throw new Error('Step 2 wedge / screw missing');
  T.intoWorkspace(T.rw, -2.5);
  T.laterEnd = T.entryEnd(T.rs, T.RS, T.rw, T.RW);
  T.laterBefore = T.pose(T.rs);
  const nx = KBCheck.next();
  if (nx.i !== 0) throw new Error('Step 1 must be the current step, got ' + nx.name);
  return true;
}"""


def case_later(page, level):
    page.evaluate(SETUP_LATER)
    arm_source(page, "__T.rs", "P1")
    click_disc(page, "__T.rw", "H1", "__T.laterEnd")
    page.evaluate("() => __T.settle()")
    r = page.evaluate("""() => { const T = __T;
      return { moved: new THREE.Vector3().fromArray(T.pose(T.rs).p).distanceTo(new THREE.Vector3().fromArray(T.laterBefore.p)),
               snaps: T.events.filter(e => e.k === 'snapAttempt'), matches: T.events.filter(e => e.k === 'handleMatch'),
               armed: !!KBMate.armed() }; }""")
    if level == 3:
        if not any(e["success"] for e in r["snaps"]):
            raise AssertionError(f"L3 later-step pair was not handed to geometry (wrongMate seat-and-report): {r}")
        return {"geometry_seat": True}
    if r["moved"] > 1e-6 or r["snaps"]:
        raise AssertionError(f"L2 later-step pair was not refused: {r}")
    reasons = [m["reason"] for m in r["matches"] if not m["success"]]
    if not reasons:
        raise AssertionError(f"L2 refusal reported no reason: {r}")
    return {"refused": reasons[0]}


SETUP_XLOCK = """() => {
  const T = __T;
  T.W = T.slot(0, 'aluminum_arm_wedge_5mm'); T.S = T.slot(0, 'screw_m3x16_socket_cap');
  T.RW = T.slot(1, 'aluminum_arm_wedge_5mm'); T.RS = T.slot(1, 'screw_m3x16_socket_cap');
  T.X = T.slot(2, 'aluminum_x_lock');
  [T.w, T.s, T.rw, T.rs, T.x] = [T.W, T.S, T.RW, T.RS, T.X].map(sl => T.byId(sl.id));
  if (![T.w, T.s, T.rw, T.rs, T.x].every(Boolean)) throw new Error('Step 1/2/3 parts missing from the kit');
  T.intoWorkspace(T.w, -3); T.intoWorkspace(T.rw, 3); T.intoWorkspace(T.x, 0);
  T.endW = T.entryEnd(T.s, T.S, T.w, T.W); T.endRW = T.entryEnd(T.rs, T.RS, T.rw, T.RW);
  return true;
}"""

READY_XLOCK = """() => {
  const T = __T;
  KBCheck.evaluate();
  const st = KBCheck.state().steps;
  if (st[0].state !== 'complete' || st[1].state !== 'complete') throw new Error('wedge assemblies not complete: ' + st[0].state + ' / ' + st[1].state);
  if (T.top(T.s) !== T.top(T.w) || T.top(T.rs) !== T.top(T.rw)) throw new Error('a wedge and its screw did not group into one assembly');
  const nx = KBCheck.next();
  if (nx.i !== 2) throw new Error('next step is ' + nx.name + ', not Attach both Wedge Assemblies to X-Lock');
  T.endL = T.entryEnd(T.s, T.S, T.x, T.X, 'H10');
  T.endR = T.entryEnd(T.rs, T.RS, T.x, T.X, 'H10');
  return nx.name;
}"""

# 楔块(不是螺丝)相对 X-Lock 的答案位姿:X-Lock 没有对称,楔块自己绕孔轴 180 度对称
WEDGE_OFF = """(which) => {
  const T = __T, w = which === 'L' ? T.w : T.rw, W = which === 'L' ? T.W : T.RW;
  const want = T.answerPose(w, W, T.x, T.X), got = T.pose(w);
  const spec = KBParts.spec('aluminum_arm_wedge_5mm');
  const qs = [want.q.clone()].concat((spec.sym || []).map(sy => want.q.clone().multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3().fromArray(sy.axis).normalize(), THREE.MathUtils.degToRad(sy.deg)))));
  const q = new THREE.Quaternion().fromArray(got.q);
  return { deg: Math.min.apply(null, qs.map(x => THREE.MathUtils.radToDeg(q.angleTo(x)))),
           offMm: new THREE.Vector3().fromArray(got.p).distanceTo(want.p) * 1000 / KBParts.unitScale() };
}"""


def case_l3_xlock(page, shots):
    page.evaluate(SETUP_XLOCK)
    # Step 1 / Step 2:楔块组件,同样用鼠标点孔搭(螺丝 P1 -> 楔块 H1),这一级怎么落座就怎么落座
    for screw, wedge, end in (("__T.s", "__T.w", "__T.endW"), ("__T.rs", "__T.rw", "__T.endRW")):
        arm_source(page, screw, "P1")
        click_disc(page, wedge, "H1", end)
        page.evaluate("() => __T.settle()")
    nxt = page.evaluate(READY_XLOCK)
    # 整个左楔块组件转 90 度:点它选中,Shift+← 是台子自己的偏航(app.js yawSelection,绕竖直轴)
    page.evaluate("async () => { const T = __T; await T.frame(T.w, 'H1', 1); }")
    xy = page.evaluate("""() => { const c = new THREE.Box3().setFromObject(__T.w).getCenter(new THREE.Vector3()).project(KB.camera);
      return [(c.x + 1) / 2 * innerWidth, (1 - c.y) / 2 * innerHeight]; }""")
    q0 = page.evaluate("() => __T.pose(__T.top(__T.w)).q")
    page.mouse.click(xy[0], xy[1])
    page.wait_for_timeout(400)
    page.keyboard.press("Shift+ArrowLeft")
    page.wait_for_timeout(400)
    turned = page.evaluate("""(q0) => THREE.MathUtils.radToDeg(new THREE.Quaternion().fromArray(q0).angleTo(
      new THREE.Quaternion().fromArray(__T.pose(__T.top(__T.w)).q)))""", q0)
    if abs(turned - 90) > 0.5:
        raise AssertionError(f"Shift+ArrowLeft turned the wedge assembly {turned:.1f} deg, expected 90")
    page.keyboard.press("Escape")
    before = page.evaluate(WEDGE_OFF, "L")
    out = {"next": nxt, "turned": round(turned, 1), "offBeforeDeg": round(before["deg"], 1)}
    for which, screw, end in (("L", "__T.s", "__T.endL"), ("R", "__T.rs", "__T.endR")):
        arm_source(page, screw, "P1")
        click_disc(page, "__T.x", "H10", end)
        page.evaluate("() => __T.settle()")
        r = page.evaluate(WEDGE_OFF, which)
        out[f"{which}deg"] = round(r["deg"], 2)
        out[f"{which}offMm"] = round(r["offMm"], 2)
        if shots:
            # 斜上方看整个 X-Lock 和装上去的楔块组件
            page.evaluate("""async () => { const T = __T, c = new THREE.Box3().setFromObject(T.top(T.x)).getCenter(new THREE.Vector3());
              KB.flyCamera([c.x + 1.2, c.y + 2.6, c.z + 2.4], c.toArray()); await T.sleep(1600); }""")
            path = str((Path(shots) / f"l3-xlock-{which}.png").resolve())
            page.screenshot(path=path)
            out[f"{which}shot"] = path
    step = page.evaluate("() => KBCheck.state().steps[2].state")
    out["step3"] = step
    for which in ("L", "R"):
        if out[f"{which}deg"] >= 2:
            raise AssertionError(f"{which} wedge assembly seated {out[which + 'deg']} deg off the answer pose: {json.dumps(out)}")
    if step != "complete":
        raise AssertionError(f"step 3 is {step}: {json.dumps(out)}")
    return out


def run(browser, base, name, shots):
    level = 3 if name.startswith("l3") else 2
    page = open_bench(browser, base, level)
    try:
        if name == "l3-xlock":
            return case_l3_xlock(page, shots)
        if name in ("l3-correct", "l2-correct"):
            return case_correct(page, level)
        if name == "l3-wrong":
            return case_l3_wrong(page)
        return case_later(page, level)
    finally:
        page.close()


def main():
    ap = argparse.ArgumentParser()
    where = ap.add_mutually_exclusive_group(required=True)
    where.add_argument("--root", help="bench directory to serve on localhost (index.html + src/)")
    where.add_argument("--url", help="a deployed bench page, e.g. .../uav_simulator_v1b/simulator/kitbash-standalone.html")
    ap.add_argument("--case", action="append", choices=CASES)
    ap.add_argument("--shots", help="directory for the l3-xlock screenshots (optional)")
    args = ap.parse_args()
    server = None
    if args.root:
        server, base = serve(Path(args.root).resolve())
        base += "/index.html"
    else:
        base = args.url
    failed = 0
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome", args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader"])
            for name in args.case or CASES:
                try:
                    print(f"PASS {name}: {json.dumps(run(browser, base, name, args.shots))}")
                except Exception as exc:  # noqa: BLE001 -- one line per case, then the exit code
                    failed += 1
                    print(f"FAIL {name}: {str(exc).splitlines()[0][:300]}")
            browser.close()
    finally:
        if server:
            server.shutdown()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
