/* ============================================================
 * mini 单步演示 —— 动的是 KB.objectsRoot 里的真零件
 *
 * 合约(doc/0924/plan-mini-simulator-standalone.md §4):
 *   1. 收到 kb:showStep(n) 后, step < n 的零件瞬间摆到 baked 终点位姿;
 *      step >= n 的零件留在料盘(init 时宿主给的位置)。
 *   2. 第 n 步的零件沿 baked 轨迹 path[0] → path[-1] 飞过去。
 *   3. 播完冻结:不续播下一步, 不提示。
 *   4. 只许转镜头(OrbitControls), 不许拖零件(core.js 里根本没有拾取)。
 *   5. 取景:整机全在画面里 + 这一步的零件不被挡住。
 *
 * 数据来源和主台子同一份:KBParts.answer()(= assets/parts/manifest.json 的
 * answer 字段 = answer_poses_full.json, 46 步 / 74 件, mm · GLB 原点)。
 *
 * 和 ca69f1e src/answer.js 的关系:
 *   - loadData() 的"每个路点过 nodeTransform / path 长度 1 就复制一份"照抄
 *     (answer.js:33-49), 但坐标落点不同 —— answer.js 把整套零件 XZ 取均值
 *     居中、抬到 HOVER=1.35 的虚影 root 上; mini 摆的是真零件, 按 check.js
 *     refToWorld()(check.js:1282-1310)的口径:参考原点平移到装配区中心, Y 抬
 *     到最低包围盒离台面 0.01。这样 mini 里的整机和主台子里学员装出来的位置
 *     是同一个地方。
 *   - poseAt()(弧长插值 + 四元数 slerp)照抄 answer.js:157-172。
 *   - frameStep() 取景照抄 kitbash-assembly-bench-patch/retired/06-mini-camera.patch,
 *     只是把 ghost item 的 it.g 换成真零件节点 it.node; 遮挡判定不再照抄 ——
 *     原 patch 的全三角面射线在这套零件上后段步骤要 1.4-2.7 s, 换成每件一个
 *     包围盒的代理(0.1-1.4 ms), 理由和实测见 frameStep 里 unblocked() 上方。
 *   - 没有 ghost 材质、没有 #answerBar 播放条、没有 KBGuide / KBFocus。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;

  var DUR = 1.1;        // 单个零件飞行时长(秒)
  var GAP = 0.18;       // 同一步里前后两个零件之间的间隔
  var LIFT_EPS = 0.01;  // 整机最低点离台面

  var DATA = null;      // {steps:[{i,id,name}], parts:[{id,key,name,step,path}]}
  var items = [];       // 真零件 × 轨迹
  var spares = [];      // 参考装配里没有的零件(料盘常驻)
  var trayPose = {};    // kbId -> {p:Vector3, q:Quaternion} —— init 时宿主给的位置
  var offset = new THREE.Vector3();

  var current = -1;     // 正在演的步骤 index, -1 = 还没演
  var playing = false;
  var done = false;
  var clockT = 0;       // 本步已播秒数
  var maxT = 0;

  /* ---------- 参考装配 → 场景单位 ---------- */
  function loadData() {
    if (DATA) return true;
    var src = window.KBParts && KBParts.ready() && KBParts.answer && KBParts.answer();
    if (!src) return false;
    var parts = [];
    src.parts.forEach(function (d) {
      if (!KBParts.spec(d.key)) return;
      var path = d.path.map(function (pose) {
        var t = KBParts.nodeTransform(d.key, pose);
        return { p: t.p, e: t.r };
      });
      // 路点只有一个 = 原地出现, 复制一份让插值有头有尾
      if (path.length === 1) path.push({ p: path[0].p.slice(), e: path[0].e.slice() });
      parts.push({ id: d.id, key: d.key, name: d.name, step: d.step, path: path });
    });
    // 只按步骤排, 不加第二关键字:Array.sort 是稳定的, 同一步里的先后要保持
    // answer_poses_full.json 的原始顺序(先楔块后螺丝 —— 螺丝得有东西可穿)
    parts.sort(function (a, b) { return a.step - b.step; });

    // 参考坐标 → 世界:原点落到装配区中心, 整机最低包围盒抬到台面之上
    // (check.js refToWorld / refLift 的口径)
    var minY = Infinity, tmp = new THREE.Box3();
    var mat = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    parts.forEach(function (d) {
      var spec = KBParts.spec(d.key);
      if (!spec || !spec.bbox) return;
      var last = d.path[d.path.length - 1];
      q.setFromEuler(new THREE.Euler(last.e[0], last.e[1], last.e[2], 'XYZ'));
      mat.compose(new THREE.Vector3().fromArray(last.p), q, one);
      tmp.min.fromArray(spec.bbox.min); tmp.max.fromArray(spec.bbox.max);
      minY = Math.min(minY, tmp.clone().applyMatrix4(mat).min.y);
    });
    var c = window.KBWorkspace ? KBWorkspace.center : new THREE.Vector3();
    offset.set(c.x, isFinite(minY) ? Math.max(LIFT_EPS, -minY + LIFT_EPS) : 0.5, c.z);
    parts.forEach(function (d) {
      d.path.forEach(function (w) { w.p = [w.p[0] + offset.x, w.p[1] + offset.y, w.p[2] + offset.z]; });
    });

    DATA = {
      steps: src.steps.map(function (st) { return { i: st.i, id: st.id, name: st.name }; }),
      parts: parts
    };
    return true;
  }

  /* ---------- 把真零件和轨迹配起来 ---------- */
  function bind() {
    items = [];
    spares = [];
    trayPose = {};
    var byId = {};
    KB.objectsRoot.children.forEach(function (n) {
      if (!KB.isPart(n)) return;
      var id = n.userData.kbId;
      byId[id] = n;
      trayPose[id] = { p: n.position.clone(), q: n.quaternion.clone() };
    });
    var missing = [];
    DATA.parts.forEach(function (d) {
      var node = byId[d.id];
      if (!node) { missing.push(d.name || d.id); return; }
      var pts = d.path.map(function (w) { return new THREE.Vector3().fromArray(w.p); });
      var quats = d.path.map(function (w) {
        return new THREE.Quaternion().setFromEuler(new THREE.Euler(w.e[0], w.e[1], w.e[2], 'XYZ'));
      });
      var lens = [0];
      for (var i = 1; i < pts.length; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
      items.push({ id: d.id, key: d.key, name: d.name, step: d.step, node: node,
        pts: pts, quats: quats, lens: lens, total: lens[lens.length - 1] || 1, start: 0 });
      delete byId[d.id];
    });
    Object.keys(byId).forEach(function (id) { spares.push(byId[id]); });
    return missing;
  }

  /* ---------- 轨迹插值(answer.js poseAt 原样) ---------- */
  var tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
  function poseAt(it, u) {
    var s = u * it.total;
    var i = 1;
    while (i < it.lens.length - 1 && it.lens[i] < s) i++;
    var seg = it.lens[i] - it.lens[i - 1] || 1;
    var f = (s - it.lens[i - 1]) / seg;
    tmpV.lerpVectors(it.pts[i - 1], it.pts[i], f);
    tmpQ.slerpQuaternions(it.quats[i - 1], it.quats[i], f);
    it.node.position.copy(tmpV);
    it.node.quaternion.copy(tmpQ);
  }
  function setAt(it, which) {
    var i = which < 0 ? it.pts.length - 1 : which;
    it.node.position.copy(it.pts[i]);
    it.node.quaternion.copy(it.quats[i]);
  }
  function setTray(node) {
    var t = trayPose[node.userData.kbId];
    if (!t) return;
    node.position.copy(t.p);
    node.quaternion.copy(t.q);
  }

  /* ---------- 取景(06-mini-camera.patch, 换成真零件) ---------- */
  function withEndPose(list, fn) {
    var save = list.map(function (it) {
      return { it: it, p: it.node.position.clone(), q: it.node.quaternion.clone() };
    });
    list.forEach(function (it) { setAt(it, -1); });
    KB.objectsRoot.updateMatrixWorld(true);
    var out = fn();
    save.forEach(function (s) { s.it.node.position.copy(s.p); s.it.node.quaternion.copy(s.q); });
    KB.objectsRoot.updateMatrixWorld(true);
    return out;
  }

  function boxOf(list) {
    var box = new THREE.Box3();
    list.forEach(function (it) {
      it.node.traverse(function (n) {
        if (!n.isMesh) return;
        if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
        box.union(n.geometry.boundingBox.clone().applyMatrix4(n.matrixWorld));
      });
    });
    return box;
  }

  function frameStep(i) {
    var mine = items.filter(function (it) { return it.step === i; });
    if (!mine.length) return false;
    var placed = items.filter(function (it) { return it.step <= i; });
    var geo = withEndPose(mine, function () {
      var pb = boxOf(mine), ab = boxOf(placed);
      var sp = [], meshes = [];
      mine.forEach(function (it) {
        it.node.traverse(function (n) {
          if (n.isMesh && n.geometry.attributes.position) meshes.push({ n: n, own: it });
        });
      });
      var per = Math.max(1, Math.floor(10 / Math.max(meshes.length, 1)));
      meshes.forEach(function (m) {
        var pos = m.n.geometry.attributes.position;
        var stride = Math.max(1, Math.floor(pos.count / per));
        for (var k = 0; k < pos.count; k += stride) {
          // 记下采样点属于哪一件 —— 盒代理要靠它跳过自己那件(见 pickDir)
          sp.push({ p: new THREE.Vector3().fromBufferAttribute(pos, k).applyMatrix4(m.n.matrixWorld),
                    own: m.own });
        }
      });
      // 遮挡代理:每件一个世界包围盒, 在终点位姿上冻一份。冻下来之后取景不再
      // 读场景, 所以 pickDir 不用再套一层 withEndPose(原来是两层)。
      var bx = placed.map(function (it) { return { own: it, box: boxOf([it]) }; });
      return { partBox: pb, asmBox: ab, samples: sp, boxes: bx };
    });
    var partBox = geo.partBox, asmBox = geo.asmBox;
    if (partBox.isEmpty() || asmBox.isEmpty()) return false;
    var pc = partBox.getCenter(new THREE.Vector3());
    var ac = asmBox.getCenter(new THREE.Vector3());
    var asmSize = asmBox.getSize(new THREE.Vector3());

    var d = pc.clone().sub(ac);
    if (d.length() < Math.max(asmSize.length() * 0.05, 1e-4)) d.set(1.3, 1.0, 1.7);
    d.normalize();
    if (d.y < 0.3) { d.y = 0.3; d.normalize(); }

    var vfov = (KB.camera.fov || 50) * Math.PI / 180;
    var ty = Math.tan(vfov / 2);
    var tx = ty * (KB.camera.aspect || 1);
    var xs = [asmBox.min.x, asmBox.max.x], ys = [asmBox.min.y, asmBox.max.y],
        zs = [asmBox.min.z, asmBox.max.z];
    function fitDist(dir) {
      var right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir);
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      right.normalize();
      var camUp = new THREE.Vector3().crossVectors(dir, right).normalize();
      var dist = 1.2, v = new THREE.Vector3();
      for (var a = 0; a < 2; a++) for (var b = 0; b < 2; b++) for (var c = 0; c < 2; c++) {
        v.set(xs[a], ys[b], zs[c]).sub(ac);
        var cz = v.dot(dir), cx = Math.abs(v.dot(right)), cy = Math.abs(v.dot(camUp));
        dist = Math.max(dist, Math.max(cx / tx, cy / ty) / 0.92 + cz);
      }
      return dist;
    }

    /* 遮挡判定:射线 × 每件的包围盒, 不碰三角面。
     *
     * 原来这里是 ray.intersectObjects(placed 的 74 个节点, true) —— 全三角面。
     * three.js 的 Mesh.raycast 没有 BVH: 只要包围球被射入就把整件的三角面走一
     * 遍, 于是 20 个候选 × ~11 个采样点 = 220 条射线, 每条都要穿 motor_2207
     * (126480 面) / propeller (75444 面) / 螺丝 (10830 面)。实测 (swiftshader,
     * 46 步全量) 单步 45~2745 ms: 第 22-25 步 2.6 s(四个电机), 第 42-45 步
     * 1.4 s(桨叶+电机), 用户报的"第 45/46 步卡得看不见动画"就是这一下同步冻结。
     * 换成每件一个包围盒后同样 46 步是 0.1~1.4 ms(总 20 ms vs 25.6 s)。
     *
     * 取景没有变差, 反而变好了 —— 用一个两者都不优化的独立判据量过:把镜头摆到
     * 各自选出的方位, 先只画这一步的零件得到剪影像素数 A, 再画上全部已装零件得
     * 到还看得见的像素数 B, B/A 就是"这件零件实际露出多少"。46 步平均
     * 78.8% → 85.5%, 最差一步 31.8% → 44.1%, 21 步变好 / 5 步变差(最差的
     * 第 22/23 步 87% → 75%, 仍然看得清)。
     *
     * 为什么盒代理反而更准: 全三角面那版把"采样点被自己这件零件的正面挡住"也算
     * 成看不见(背面的采样点从任何方位都是这样), 分数里大半是这种噪声 —— 实测第
     * 30-41 步 20 个候选里最好的也只有 2/11 个采样点"可见"。盒代理跳过采样点自
     * 己那一件, 判的就是"有没有别的零件挡在前面", 和 tests/smoke_mini.py:273-274
     * 的口径一致。同一步里别的零件照挡(四颗螺丝互相挡得算), 所以只跳自己那件,
     * 不是跳整步 —— 自己那件的盒面必然落在自己表面点之前, 不跳则恒判被挡。 */
    var probe = new THREE.Ray(), hitP = new THREE.Vector3(), segV = new THREE.Vector3();
    function unblocked(eye, q) {
      segV.copy(q.p).sub(eye);
      var len = segV.length();
      probe.set(eye, segV.normalize());
      for (var b = 0; b < geo.boxes.length; b++) {
        if (geo.boxes[b].own === q.own) continue;
        if (!probe.intersectBox(geo.boxes[b].box, hitP)) continue;
        if (hitP.distanceTo(eye) < len - 0.004) return false;
      }
      return true;
    }

    var bestDir = null, bestScore = 0;
    (function () {
      // 仰角候选比 06-mini-camera.patch 多了两档负的(-0.35 / -0.75)。
      // 原 patch 是给悬在 HOVER=1.35 的虚影用的, 从侧面压低就能看到板子底下;
      // mini 动的是真零件, 整机贴着台面(lift≈0.76), 而参考装配本身是倒着采的
      // (顶板在最下面, 螺丝从下往上拧 —— answer_poses_full.json 第 29..34 步),
      // 全部限制在水平线以上就必然有一批零件永远被顶板挡死(实测第 33 步
      // Standoff Screw #9 七个采样点全被 Top Plate 挡住)。台面只有一块
      // ShadowMaterial, 不挡视线, 镜头可以转到下面往上看。
      [0, -0.6, 0.6, 2.6].forEach(function (yaw) {
        [d.y, 0.12, 0.75, -0.35, -0.75].forEach(function (ey) {
          var co = Math.cos(yaw), si = Math.sin(yaw);
          var dir = new THREE.Vector3(d.x * co - d.z * si, 0, d.x * si + d.z * co);
          if (dir.lengthSq() < 1e-9) dir.set(1, 0, 1);
          dir.normalize().multiplyScalar(Math.sqrt(Math.max(1 - ey * ey, 0.04))).setY(ey);
          dir.normalize();
          var dist = fitDist(dir);
          var eye = ac.clone().addScaledVector(dir, dist), n = 0;
          geo.samples.forEach(function (q) { if (unblocked(eye, q)) n++; });
          var score = (n + 0.5) / geo.samples.length / dist;
          if (score > bestScore * 1.15) { bestScore = score; bestDir = dir.clone(); }
        });
      });
    })();
    if (bestDir) d.copy(bestDir);
    var p = ac.clone().addScaledVector(d, fitDist(d));
    KB.flyCamera([p.x, p.y, p.z], [ac.x, ac.y, ac.z]);
    return true;
  }

  /* ---------- 演一步 ---------- */
  function stepIndex(ref, stepNames) {
    if (!DATA) return -1;
    if (typeof ref === 'number') return ref >= 0 && ref < DATA.steps.length ? ref : -1;
    var s = String(ref);
    var hit = DATA.steps.filter(function (st) { return st.id === s; })[0];
    if (hit) return hit.i;
    // 宿主的任务图 uuid 和零件库里的对不上时, 用宿主给的步骤名兜一手
    var want = stepNames && stepNames[s];
    if (want) {
      var norm = function (x) { return String(x || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
      hit = DATA.steps.filter(function (st) { return norm(st.name) === norm(want); })[0];
      if (hit) return hit.i;
    }
    if (/^\d+$/.test(s)) return stepIndex(parseInt(s, 10));
    return -1;
  }

  function showStep(n) {
    if (!items.length) return false;
    if (!(n >= 0 && n < DATA.steps.length)) return false;
    current = n;
    playing = false;
    done = false;
    clockT = 0;

    spares.forEach(setTray);
    var mine = [];
    items.forEach(function (it) {
      if (it.step < n) setAt(it, -1);
      else if (it.step > n) setTray(it.node);
      else mine.push(it);
    });
    // 同一步里的零件一件一件来(四颗螺丝同时飞看不清谁进了哪个孔)
    var cur = 0;
    mine.forEach(function (it) {
      it.start = cur;
      cur += DUR + GAP;
      setAt(it, 0);
    });
    maxT = mine.length ? cur - GAP : 0;
    KB.objectsRoot.updateMatrixWorld(true);

    frameStep(n);
    // frameStep 是同步的。盒代理之后它只要 1-4 ms(以前后段步骤 1.4-2.7 s), 但
    // 这段时间照样会被算进下一帧的 dt, 所以照样清一次(见 core.js resetDelta)。
    KB.resetDelta();
    playing = maxT > 0;
    done = !playing;
    return true;
  }

  function tick(dt) {
    if (!playing) return;
    clockT += dt;
    var t = clockT;
    items.forEach(function (it) {
      if (it.step !== current) return;
      var u = (t - it.start) / DUR;
      if (u <= 0) { setAt(it, 0); return; }
      if (u >= 1) { setAt(it, -1); return; }
      poseAt(it, 1 - Math.pow(1 - u, 3));
    });
    if (t >= maxT) {
      items.forEach(function (it) { if (it.step === current) setAt(it, -1); });
      playing = false;
      done = true;        // 冻结:不续播下一步
    }
  }

  KB.onFrame(tick);

  /* ---------- 对外(bridge.js 和自测用) ---------- */
  window.KBMini = {
    ready: function () { return !!(DATA && items.length); },
    init: function () {
      if (!loadData()) return { ok: false, missing: [] };
      var missing = bind();
      return { ok: !!items.length, missing: missing };
    },
    showStep: showStep,
    stepIndex: stepIndex,
    steps: function () { return DATA ? DATA.steps.slice() : []; },
    status: function () {
      return { step: current, playing: playing, done: done, flying: KB.flying(),
               t: clockT, maxT: maxT, parts: items.length, spares: spares.length };
    },
    // 自检用:每件的轨迹端点(世界坐标)和它此刻的位置
    plan: function () {
      return items.map(function (it) {
        return { id: it.id, key: it.key, name: it.name, step: it.step,
                 waypoints: it.pts.length,
                 from: it.pts[0].toArray(), to: it.pts[it.pts.length - 1].toArray(),
                 tray: trayPose[it.id] ? trayPose[it.id].p.toArray() : null,
                 at: it.node.position.toArray() };
      });
    },
    spareIds: function () { return spares.map(function (n) { return n.userData.kbId; }); },
    offset: function () { return offset.toArray(); }
  };
})();
