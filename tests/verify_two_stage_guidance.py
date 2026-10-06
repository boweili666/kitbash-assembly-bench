#!/usr/bin/env python3
"""Exercise the real step-3 screw/wedge geometry in the browser.

Uses the shipped answer poses and manifest through the normal bench page.  It
does not manufacture an issue label: check.js must derive both states.
"""
import functools
import http.server
import socketserver
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *args: None
    server = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def main():
    server, base = serve()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome", args=["--use-gl=swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto(base + "/index.html?tools=1&level=3")
            page.wait_for_function("() => window.KB && KBParts && KBParts.ready() && KBCheck && KBCheck.ref()", timeout=120000)
            result = page.evaluate("""async () => {
              if (!KBLevel || KBLevel.get() !== 3) throw new Error('focused two-stage test requires Level 3');
              const nodes = id => { let found = null; KB.objectsRoot.traverse(n => {
                if (KB.isPart(n) && n.userData.kbId === id) found = n;
              }); return found; };
              const ref = KBCheck.ref();
              const wedge = ref.slots.find(s => s.step === 0 && s.key === 'aluminum_arm_wedge_5mm');
              const screw = ref.slots.find(s => s.step === 0 && s.key === 'screw_m3x16_socket_cap');
              const rightWedge = ref.slots.find(s => s.step === 1 && s.key === 'aluminum_arm_wedge_5mm');
              const rightScrew = ref.slots.find(s => s.step === 1 && s.key === 'screw_m3x16_socket_cap');
              const xlock = ref.slots.find(s => s.step === 2 && s.key === 'aluminum_x_lock');
              if (!wedge || !screw || !rightWedge || !rightScrew || !xlock)
                throw new Error('manifest lacks the Step 1/2 wedge+screw groups or Step 3 X-Lock');
              // index.html starts as an empty practice bench. Load the same
              // manifest kit that a bridge host mounts, then move only the
              // two receiving assemblies into the workspace -- never to an
              // answer pose. KBMate performs every actual attachment below.
              const needed = new Set([wedge.id, screw.id, rightWedge.id, rightScrew.id, xlock.id]);
              const objects = KBParts.kit().filter(p => needed.has(p.id)).map(KBParts.sceneObject).filter(Boolean);
              KB.loadSceneData({ v: 1, objects }, true);
              if (KBCheck.invalidate) KBCheck.invalidate();
              const a = nodes(screw.id), w = nodes(wedge.id), ra = nodes(rightScrew.id), rw = nodes(rightWedge.id), b = nodes(xlock.id);
              if (!a || !w || !ra || !rw || !b) throw new Error('Step 1/2/3 parts are missing from the real kit');
              w.position.set(-2, 0, 9); w.updateMatrixWorld(true);
              rw.position.set(2, 0, 9); rw.updateMatrixWorld(true);
              b.position.set(0, 0, 12); b.updateMatrixWorld(true);
              const top = node => { while (node.parent && node.parent !== KB.objectsRoot) node = node.parent; return node; };
              KBCheck.evaluate();
              const step3Id = ref.steps.find(s => s.i === 2).id;
              const beforeFirstScrew = KBCheck.state();
              if (beforeFirstScrew.issues.some(i => i.kind === 'hint' && i.step === step3Id))
                throw new Error('blocked Step 3 emitted an attachment hint before its wedge+screw prerequisites');
              if (!KBMate.mate(a, 'P1', w, 'H1')) throw new Error('Step 1 screw-to-wedge pair refused');
              await new Promise(resolve => setTimeout(resolve, 1800));
              KBCheck.evaluate();
              const step1 = KBCheck.state().steps.find(s => s.index === 0);
              if (!step1 || step1.state !== 'complete')
                throw new Error('Step 1 screw-to-wedge target pose was not accepted');
              if (top(a) !== top(w) && !KB.groupNodes([top(a), top(w)], 'Step 1 wedge and screw'))
                throw new Error('Step 1 wedge and screw could not group');
              if (top(a) !== top(w)) throw new Error('Step 1 screw and wedge are not a grouped assembly');
              if (!KBMate.mate(ra, 'P1', rw, 'H1')) throw new Error('Step 2 screw-to-wedge pair refused');
              await new Promise(resolve => setTimeout(resolve, 1800));
              KBCheck.evaluate();
              const step2 = KBCheck.state().steps.find(s => s.index === 1);
              if (!step2 || step2.state !== 'complete')
                throw new Error('Step 2 screw-to-wedge target pose was not accepted');
              if (top(ra) !== top(rw) && !KB.groupNodes([top(ra), top(rw)], 'Step 2 wedge and screw'))
                throw new Error('Step 2 wedge and screw could not group');
              if (top(ra) !== top(rw)) throw new Error('Step 2 screw and wedge are not a grouped assembly');
              KBCheck.evaluate();
              const readyForStep3 = KBCheck.state();
              if (readyForStep3.steps.find(s => s.id === step3Id).state !== 'available' ||
                  !readyForStep3.issues.some(i => i.step === step3Id))
                throw new Error('Step 3 did not emit guidance after both wedge+screw prerequisites completed');
              if (!KBMate.mate(a, 'P1', b, 'H10', 0, -1)) throw new Error('Step 3 grouped screw-to-X-Lock pair refused');
              await new Promise(resolve => setTimeout(resolve, 1800));
              let observed = KBMate.mateState(a);
              if (!observed || observed.objectId !== a.userData.kbId || observed.hostId !== b.userData.kbId)
                throw new Error('mate state does not identify the real screw/host pair');
              if (!observed.active || !observed.canAdjust)
                throw new Error('Step 3 pair did not lock arrow depth control to the screw group');
              KB.setSelection([b]);
              if (KBMate.mateState(a).canAdjust)
                throw new Error('different X-Lock selection was incorrectly authorized for screw arrows');
              window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
              if (!KBMate.mateState(a).canAdjust)
                throw new Error('Escape did not restore the active screw arrow lock');
              const axis = new THREE.Vector3().fromArray(observed.axis);
              const target = b.matrixWorld.clone().multiply(xlock.Minv).multiply(screw.M);
              const targetPosition = new THREE.Vector3().setFromMatrixPosition(target);
              const currentPosition = new THREE.Vector3(); a.getWorldPosition(currentPosition);
              const toTarget = targetPosition.sub(currentPosition).dot(axis);
              const arrow = toTarget >= 0 ? 'ArrowDown' : 'ArrowUp';
              const direction = arrow === 'ArrowUp' ? 1 : -1;
              const step = KBParts.unitScale() / 1000 * 0.25;
              const presses = Math.ceil((0.12 + Math.abs(toTarget)) / step);
              const beforeArrow = new THREE.Vector3(); top(a).getWorldPosition(beforeArrow);
              for (let i = 0; i < presses; i++) {
                window.dispatchEvent(new KeyboardEvent('keydown', { code: arrow, bubbles: true }));
                window.dispatchEvent(new KeyboardEvent('keyup', { code: arrow, bubbles: true }));
              }
              const afterArrow = new THREE.Vector3(); top(a).getWorldPosition(afterArrow);
              const arrowDelta = afterArrow.sub(beforeArrow);
              if (arrowDelta.dot(axis) * direction <= 0 || arrowDelta.clone().sub(axis.clone().multiplyScalar(arrowDelta.dot(axis))).length() > 1e-6)
                throw new Error('arrow axis mismatch: ' + JSON.stringify({ arrow, axis: axis.toArray(), delta: arrowDelta.toArray(), observed: KBMate.mateState(a) }));
              KBCheck.evaluate();
              const afterSlide = KBCheck.state();
              let issue = afterSlide.issues.find(i => i.objectId === a.userData.kbId);
              const depth = issue && issue.guidance;
              if (!depth || depth.stage !== 'axis-depth' || !depth.mate || !depth.targetPose)
                throw new Error('axial move was not diagnosed: ' + JSON.stringify({
                  issue, depth, observed,
                  steps: afterSlide.steps.slice(0, 3),
                  issues: afterSlide.issues.slice(0, 4),
                  score: afterSlide.score
                }));
              KB.emit('grab', top(a));
              top(a).position.add(new THREE.Vector3(0.2, 0, 0)); top(a).updateMatrixWorld(true);
              KBCheck.evaluate();
              issue = KBCheck.state().issues.find(i => i.objectId === a.userData.kbId);
              const hole = issue && issue.guidance;
              if (!hole || hole.stage !== 'hole-match' || hole.mate)
                throw new Error('unmated wrong-hole state was not distinguished from axis depth');
              return { step: 3, screw: a.name, host: b.name, depth: depth.stage, hole: hole.stage };
            }""")
            print(f"PASS step {result['step']}: {result['screw']} / {result['host']} -> {result['depth']}, {result['hole']}")
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAIL {exc}")
        sys.exit(1)
