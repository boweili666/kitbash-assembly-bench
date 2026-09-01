/* ============================================================
 * 装配吸附 — 面贴面 / 轴对轴(销入孔、孔对孔),吸附后沿约束滑动
 *
 * 特征(世界坐标,按基础件类型自动提取):
 *   立方体/平板   6 个面(中心 + 外法线 + 轮廓)
 *   圆柱          轴线(销)+ 上下 2 个圆面
 *   圆锥          轴线 + 底面圆
 *   圆环          孔轴(洞)
 *   胶囊          轴线
 *   组合          汇总所有子零件的特征
 *
 * 交互:
 *   鼠标按住物体直接拖动(空白处拖动仍是转视角;Shift+拖 = 垂直升降)
 *   面-面:法线相对且够近 → 贴平,继续拖 = 在对方面上滑动
 *   轴-轴:接近平行且靠近 → 对中,继续拖 = 只沿轴滑动;拖远即脱开
 *   吸附目标画琥珀色高亮;手势抓取复用同一套 KBSnap.solve
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var canvas = document.getElementById('viewport');

  /* ---------- 阈值(世界单位 / 角度余弦,进入与脱离带迟滞) ---------- */
  var AXIS_COS_ON = Math.cos(THREE.MathUtils.degToRad(20));
  var AXIS_COS_OFF = Math.cos(THREE.MathUtils.degToRad(35));
  var AXIS_PERP_ON = 0.32, AXIS_PERP_OFF = 0.55; // 收紧脱离半径,方便在相邻孔位间切换
  var FACE_DOT_ON = -0.90, FACE_DOT_OFF = -0.75;
  var FACE_GAP_ON = 0.30, FACE_GAP_OFF = 0.65;

  /* ---------- 特征提取 ---------- */
  function circlePts(r, y, plane) {
    // plane 'xz':圆柱/圆锥端面;'xy':圆环孔
    var pts = [];
    for (var i = 0; i <= 24; i++) {
      var a = i / 24 * Math.PI * 2;
      if (plane === 'xz') pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
      else pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
    }
    return pts;
  }

  function meshFeatures(mesh, out) {
    var M = mesh.matrixWorld;
    var p = mesh.geometry.parameters || {};
    function W(v) { return v.clone().applyMatrix4(M); }
    function D(v) { return v.clone().transformDirection(M); }
    function addFace(cLocal, nLocal, outlineLocal) {
      var c = W(cLocal);
      var pts = outlineLocal.map(W);
      var r = 0;
      pts.forEach(function (q) { r = Math.max(r, q.distanceTo(c)); });
      out.faces.push({ c: c, n: D(nLocal), r: r, outline: pts });
    }
    function addAxis(cLocal, dLocal, halfLenViz) {
      var d = D(dLocal);
      var c = W(cLocal);
      out.axes.push({
        c: c, d: d,
        outline: [c.clone().addScaledVector(d, -halfLenViz), c.clone().addScaledVector(d, halfLenViz)]
      });
    }
    var t = mesh.userData.kbType;
    if (t === 'box' || t === 'slab') {
      var hx = (p.width || 1) / 2, hy = (p.height || 1) / 2, hz = (p.depth || 1) / 2;
      [ // [法线, 面内 u 方向, 面内 v 方向]
        [[1, 0, 0], [0, hy, 0], [0, 0, hz]], [[-1, 0, 0], [0, hy, 0], [0, 0, hz]],
        [[0, 1, 0], [hx, 0, 0], [0, 0, hz]], [[0, -1, 0], [hx, 0, 0], [0, 0, hz]],
        [[0, 0, 1], [hx, 0, 0], [0, hy, 0]], [[0, 0, -1], [hx, 0, 0], [0, hy, 0]]
      ].forEach(function (f) {
        var n = new THREE.Vector3().fromArray(f[0]);
        var c = new THREE.Vector3(n.x * hx, n.y * hy, n.z * hz);
        var u = new THREE.Vector3().fromArray(f[1]);
        var v = new THREE.Vector3().fromArray(f[2]);
        addFace(c, n, [
          c.clone().add(u).add(v), c.clone().add(u).sub(v),
          c.clone().sub(u).sub(v), c.clone().sub(u).add(v),
          c.clone().add(u).add(v)
        ]);
      });
    } else if (t === 'cylinder') {
      var h = (p.height || 1) / 2, r0 = p.radiusTop || 0.5;
      addAxis(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), h * 2.0);
      addFace(new THREE.Vector3(0, h, 0), new THREE.Vector3(0, 1, 0), circlePts(r0, h, 'xz'));
      addFace(new THREE.Vector3(0, -h, 0), new THREE.Vector3(0, -1, 0), circlePts(r0, -h, 'xz'));
    } else if (t === 'cone') {
      var hc = (p.height || 1) / 2, rc = p.radius || 0.5;
      addAxis(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), hc * 2.0);
      addFace(new THREE.Vector3(0, -hc, 0), new THREE.Vector3(0, -1, 0), circlePts(rc, -hc, 'xz'));
    } else if (t === 'torus') {
      addAxis(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1),
        Math.max(0.9, (p.radius || 0.4) * 2));
      // 孔圈轮廓用于高亮
      out.axes[out.axes.length - 1].ring = circlePts(p.radius || 0.4, 0, 'xy').map(W);
    } else if (t === 'capsule') {
      addAxis(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0),
        ((p.length || 0.55) / 2 + (p.radius || 0.32)) * 1.6);
    }
    // sphere:无平面无轴,不参与
  }

  /* 零件(part:*):孔/销 → 轴特征(带半径),包围盒 → 面特征 */
  function ringPts(c, d, r) {
    var u = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    u = u.clone().cross(d).normalize();
    var v = d.clone().cross(u);
    var pts = [];
    for (var i = 0; i <= 24; i++) {
      var a = i / 24 * Math.PI * 2;
      pts.push(c.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r));
    }
    return pts;
  }

  function partFeatures(wrapper, out) {
    var spec = window.KBParts && KBParts.spec(wrapper.userData.kbType.slice(5));
    if (!spec) return;
    var M = wrapper.matrixWorld;
    var ws = new THREE.Vector3();
    wrapper.getWorldScale(ws);
    var s = (Math.abs(ws.x) + Math.abs(ws.y) + Math.abs(ws.z)) / 3;
    spec.holes.concat(spec.pegs).forEach(function (f) {
      var c = new THREE.Vector3().fromArray(f.c).applyMatrix4(M);
      var d = new THREE.Vector3().fromArray(f.d).transformDirection(M);
      var rw = f.r * s;
      var half = Math.max(f.depth * s * 1.4, 0.45);
      out.axes.push({
        c: c, d: d, r: rw,
        outline: [c.clone().addScaledVector(d, -half), c.clone().addScaledVector(d, half)],
        ring: ringPts(c, d, Math.max(rw * 1.6, 0.1))
      });
    });
    // 包围盒 6 面(薄板的大面参与面-面贴合)
    var mn = spec.bbox.min, mx = spec.bbox.max;
    var mid = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    var hx = (mx[0] - mn[0]) / 2, hy = (mx[1] - mn[1]) / 2, hz = (mx[2] - mn[2]) / 2;
    [
      [[1, 0, 0], [0, hy, 0], [0, 0, hz]], [[-1, 0, 0], [0, hy, 0], [0, 0, hz]],
      [[0, 1, 0], [hx, 0, 0], [0, 0, hz]], [[0, -1, 0], [hx, 0, 0], [0, 0, hz]],
      [[0, 0, 1], [hx, 0, 0], [0, hy, 0]], [[0, 0, -1], [hx, 0, 0], [0, hy, 0]]
    ].forEach(function (fd) {
      var n = new THREE.Vector3().fromArray(fd[0]);
      var cL = new THREE.Vector3(mid[0] + n.x * hx, mid[1] + n.y * hy, mid[2] + n.z * hz);
      var u = new THREE.Vector3().fromArray(fd[1]);
      var v = new THREE.Vector3().fromArray(fd[2]);
      var corners = [
        cL.clone().add(u).add(v), cL.clone().add(u).sub(v),
        cL.clone().sub(u).sub(v), cL.clone().sub(u).add(v),
        cL.clone().add(u).add(v)
      ].map(function (p) { return p.applyMatrix4(M); });
      var cW = cL.clone().applyMatrix4(M);
      var r = 0;
      corners.forEach(function (q) { r = Math.max(r, q.distanceTo(cW)); });
      out.faces.push({ c: cW, n: n.transformDirection(M), r: r, outline: corners });
    });
  }

  function nodeFeatures(o, out) {
    if (KB.isPart(o)) partFeatures(o, out);
    else if (o.isMesh && o.userData.kbType) meshFeatures(o, out);
  }

  function extract(node) {
    node.updateMatrixWorld(true);
    var out = { faces: [], axes: [] };
    node.traverse(function (o) { nodeFeatures(o, out); });
    return out;
  }

  /* ---------- 吸附求解 ---------- */
  var cache = null;    // 拖动开始时缓存的其他物体特征
  var active = null;   // 当前吸附 {kind:'axis'|'face', b:目标特征}
  var viz = null;      // 高亮线

  function isUnder(o, node) {
    for (var q = o; q; q = q.parent) if (q === node) return true;
    return false;
  }

  function begin(node) {
    cache = { faces: [], axes: [] };
    KB.objectsRoot.children.forEach(function (other) {
      if (other === node) return;
      other.updateMatrixWorld(true);
      other.traverse(function (o) {
        // 从组合里单独拖零件时,排除自身,兄弟零件仍是吸附目标
        if (!isUnder(o, node)) nodeFeatures(o, cache);
      });
    });
    active = null;
  }

  function end() {
    var was = active;
    active = null;
    cache = null;
    hideViz();
    return was;
  }

  function axisFit(a, b) {
    var c = Math.abs(a.d.dot(b.d));
    var v = a.c.clone().sub(b.c);
    var pv = v.clone().addScaledVector(b.d, -v.dot(b.d));
    return { cos: c, perp: pv.length(), pv: pv };
  }

  function faceFit(fa, fb) {
    var dot = fa.n.dot(fb.n);
    var v = fa.c.clone().sub(fb.c);
    var gap = v.dot(fb.n);
    var lat = v.clone().addScaledVector(fb.n, -gap);
    return { dot: dot, gap: gap, lat: lat.length(), latV: lat };
  }

  function applyAxis(node, a, b) {
    // 转正:把 a 轴方向对齐到 b 轴(选转角小的一侧),绕 a.c 旋转
    var dir = a.d.dot(b.d) < 0 ? b.d.clone().negate() : b.d.clone();
    var q = new THREE.Quaternion().setFromUnitVectors(a.d, dir);
    node.quaternion.premultiply(q);
    node.position.sub(a.c).applyQuaternion(q).add(a.c);
    // 对中:消除垂直于 b 轴的偏移;沿轴分量保留 → 拖动只沿轴滑
    var v = a.c.clone().sub(b.c);
    var pv = v.addScaledVector(b.d, -v.dot(b.d));
    node.position.sub(pv);
  }

  function applyFace(node, fa, fb) {
    var q = new THREE.Quaternion().setFromUnitVectors(fa.n, fb.n.clone().negate());
    node.quaternion.premultiply(q);
    node.position.sub(fa.c).applyQuaternion(q).add(fa.c);
    var gap = fa.c.clone().sub(fb.c).dot(fb.n);
    node.position.addScaledVector(fb.n, -gap); // 贴平;面内分量自由 → 在面上滑动
  }

  /* 把 node 摆到 desired(世界坐标),再按特征求解吸附;返回当前吸附(可能为 null)
   * node 可能挂在铰链枢轴下,位置按父空间换算 */
  function solve(node, desired, opts) {
    if (node.parent) {
      node.parent.updateMatrixWorld(true);
      node.position.copy(node.parent.worldToLocal(desired.clone()));
    } else {
      node.position.copy(desired);
    }
    if (!cache) return null;
    var mine = extract(node);
    var i, j, fit;

    // 迟滞:只复验「当初吸上的那一对」特征(宽松阈值防抖)。
    // 不能扫全部特征 —— 多孔零件(18 孔的碳板)总有别的孔在范围内,会导致永远脱不开
    if (active && active.kind === 'axis') {
      var ka = mine.axes[active.ai];
      if (ka) {
        fit = axisFit(ka, active.b);
        if (fit.cos > AXIS_COS_OFF && fit.perp < AXIS_PERP_OFF) {
          applyAxis(node, ka, active.b);
          showViz(active);
          node.updateMatrixWorld(true);
          return active;
        }
      }
      active = null;
    }
    if (active && active.kind === 'face') {
      var kf = mine.faces[active.fi];
      if (kf) {
        fit = faceFit(kf, active.b);
        if (fit.dot < FACE_DOT_OFF && Math.abs(fit.gap) < FACE_GAP_OFF &&
            fit.lat < (kf.r + active.b.r) * 0.95) {
          applyFace(node, kf, active.b);
          showViz(active);
          node.updateMatrixWorld(true);
          return active;
        }
      }
      active = null;
    }

    // 旋转中只维持已有约束,绝不获取新吸附 —— 否则扫过邻近孔位时会跳孔
    if (opts && opts.noAcquire) {
      hideViz();
      node.updateMatrixWorld(true);
      return null;
    }

    // 搜索新吸附:轴优先于面
    var best = null;
    for (i = 0; i < mine.axes.length; i++) {
      for (j = 0; j < cache.axes.length; j++) {
        fit = axisFit(mine.axes[i], cache.axes[j]);
        if (fit.cos < AXIS_COS_ON || fit.perp > AXIS_PERP_ON) continue;
        var s = fit.perp + (1 - fit.cos) * 2;
        // 半径匹配偏好:⌀3 螺丝优先吸 ⌀3 孔而不是旁边的大孔
        if (mine.axes[i].r && cache.axes[j].r) {
          s += Math.abs(mine.axes[i].r - cache.axes[j].r) * 3;
        }
        if (!best || s < best.s) best = { s: s, kind: 'axis', ai: i, a: mine.axes[i], b: cache.axes[j] };
      }
    }
    if (!best) {
      for (i = 0; i < mine.faces.length; i++) {
        for (j = 0; j < cache.faces.length; j++) {
          fit = faceFit(mine.faces[i], cache.faces[j]);
          if (fit.dot > FACE_DOT_ON || Math.abs(fit.gap) > FACE_GAP_ON) continue;
          if (fit.lat > (mine.faces[i].r + cache.faces[j].r) * 0.85) continue;
          var sf = Math.abs(fit.gap) + fit.lat * 0.3 + (1 + fit.dot);
          if (!best || sf < best.s) best = { s: sf, kind: 'face', fi: i, a: mine.faces[i], b: cache.faces[j] };
        }
      }
    }
    if (best) {
      active = { kind: best.kind, ai: best.ai, fi: best.fi, b: best.b };
      if (best.kind === 'axis') applyAxis(node, best.a, best.b);
      else applyFace(node, best.a, best.b);
      showViz(active);
    } else {
      hideViz();
    }
    node.updateMatrixWorld(true); // 修正后立即刷新,调用方可直接读世界矩阵
    return active;
  }

  /* ---------- 吸附高亮 ---------- */
  function showViz(act) {
    if (viz && viz.userData.b === act.b) return; // 目标未变,沿用现有高亮
    hideViz();
    var group = new THREE.Group();
    group.userData.b = act.b;
    group.userData.kbOverlay = true; // 抓帧时隐藏
    function makeLine(list) {
      var g = new THREE.BufferGeometry().setFromPoints(list);
      return new THREE.Line(g, new THREE.LineBasicMaterial({
        color: 0xe8a33d, transparent: true, opacity: 0.95, depthTest: false
      }));
    }
    group.add(makeLine(act.b.outline));
    if (act.kind === 'axis' && act.b.ring) group.add(makeLine(act.b.ring));
    group.renderOrder = 999;
    KB.scene.add(group);
    viz = group;
  }

  function hideViz() {
    if (!viz) return;
    viz.children.forEach(function (l) { l.geometry.dispose(); l.material.dispose(); });
    KB.scene.remove(viz);
    viz = null;
  }

  function releaseActive() {
    active = null;
    hideViz();
  }

  /* ---------- 磁性吸附按住 Ctrl 生效(Blender 习惯),默认自由移动 ---------- */
  var snapKeyDown = false;
  function setSnapKey(on) {
    if (snapKeyDown === on) return;
    snapKeyDown = on;
    if (!on) {
      releaseActive();
    } else if (KB.gizmo.dragging && KB.gizmo.mode === 'rotate' && cache && KB.gizmo.object) {
      // 旋转拖拽中途按下 Ctrl:此刻获取一次约束
      solve(KB.gizmo.object, KB.gizmo.object.position.clone());
    }
    // Ctrl 切换时(非拖拽中)刷新变换枢轴:按下 → 跳到孔位,松开 → 回到零件原点
    if (!(drag && drag.started) && !KB.gizmo.dragging && KB.rebuildAttachment) {
      KB.rebuildAttachment();
    }
  }
  window.addEventListener('keydown', function (e) { if (e.key === 'Control') setSnapKey(true); });
  window.addEventListener('keyup', function (e) { if (e.key === 'Control') setSnapKey(false); });
  window.addEventListener('blur', function () { setSnapKey(false); });

  function placeWorld(node, desired) {
    if (node.parent) {
      node.parent.updateMatrixWorld(true);
      node.position.copy(node.parent.worldToLocal(desired.clone()));
    } else {
      node.position.copy(desired);
    }
    node.updateMatrixWorld(true);
  }

  function upish(d) {
    // 轴向无正负,统一取"朝上"的一侧,箭头方向稳定
    var v = d.clone().normalize();
    if (v.y < -1e-6 || (Math.abs(v.y) < 1e-6 && v.x + v.z < 0)) v.negate();
    return v;
  }

  /* node 的某轴当前与其他物体的轴同轴 → 返回铰链锚点 {point, dir}(世界坐标),
   * app.js 用它把变换枢轴(gizmo)放到孔位上并沿孔轴取向 */
  function hingeFor(node) {
    node.updateMatrixWorld(true);
    var mine = extract(node);
    if (!mine.axes.length) return null;
    var others = { faces: [], axes: [] };
    KB.objectsRoot.children.forEach(function (other) {
      if (other === node) return;
      other.updateMatrixWorld(true);
      other.traverse(function (o) { if (!isUnder(o, node)) nodeFeatures(o, others); });
    });
    var best = null;
    mine.axes.forEach(function (a) {
      others.axes.forEach(function (b) {
        var f = axisFit(a, b);
        if (f.cos < 0.985 || f.perp > 0.08) return;
        if (!best || f.perp < best.perp) {
          best = { perp: f.perp, point: a.c.clone(), dir: upish(b.d) };
        }
      });
    });
    return best;
  }

  /* 单轴零件(螺丝/螺柱/机臂/楔块等)的主轴:即使未吸附,
   * gizmo 也直接落到它自己的轴线上并沿轴取向 */
  function primaryAxis(node) {
    node.updateMatrixWorld(true);
    var feats = extract(node);
    if (!feats.axes.length) return null;
    var a0 = feats.axes[0];
    for (var i = 1; i < feats.axes.length; i++) {
      var f = axisFit(feats.axes[i], a0);
      if (f.cos < 0.996 || f.perp > 0.05) return null; // 多根不同轴 → 不明确
    }
    return { point: a0.c.clone(), dir: upish(a0.d) };
  }

  window.KBSnap = { begin: begin, solve: solve, end: end,
    release: releaseActive,
    hingeFor: hingeFor,
    primaryAxis: primaryAxis,
    snapKeyActive: function () { return snapKeyDown; },
    isMouseDragging: function () { return !!(drag && drag.started); },
    isActive: function () { return !!active; } };

  /* ---------- gizmo 拖拽同样走吸附 ----------
   * 平移:靠近时贴面 / 对中。
   * 旋转:吸附激活时每步都把孔轴拉回目标轴 —— 旋转中心就变成了
   * 那个孔(绕洞转的铰链效果);扭过约 35° 才会脱开约束。 */
  KB.gizmo.addEventListener('dragging-changed', function (e) {
    var mode = KB.gizmo.mode;
    if (e.value) {
      if ((mode === 'translate' || mode === 'rotate') && KB.gizmo.object) {
        begin(KB.gizmo.object);
        if (mode === 'rotate' && snapKeyDown) {
          // 旋转开局获取一次当前约束(已同轴则锁定该孔),之后只维持不换孔
          solve(KB.gizmo.object, KB.gizmo.object.position.clone());
        }
      }
    } else if (!drag) {
      end();
    }
  });
  KB.gizmo.addEventListener('objectChange', function () {
    var obj = KB.gizmo.object;
    var mode = KB.gizmo.mode;
    if (!cache || !KB.gizmo.dragging || !obj) return;
    if (mode !== 'translate' && mode !== 'rotate') return;
    if (!snapKeyDown) { releaseActive(); return; } // 未按 Ctrl:gizmo 拖拽同样不吸附
    solve(obj, obj.position.clone(), { noAcquire: mode === 'rotate' });
  });

  /* ---------- 鼠标直接拖拽物体 ---------- */
  var drag = null; // {node, startPos, startQuat, grabPoint, downX, downY, started, vertical}
  var ray = new THREE.Raycaster();
  var ndc = new THREE.Vector2();
  var plane = new THREE.Plane();
  var hitOut = new THREE.Vector3();

  function planeHit(px, py) {
    ndc.x = (px / window.innerWidth) * 2 - 1;
    ndc.y = -(py / window.innerHeight) * 2 + 1;
    ray.setFromCamera(ndc, KB.camera);
    return ray.ray.intersectPlane(plane, hitOut) ? hitOut : null;
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || drag) return;
    if (KB.gizmo.dragging || KB.gizmo.axis) return;
    var hit = KB.raycastTopAt(e.clientX, e.clientY);
    if (!hit) return;
    drag = {
      node: hit.node,
      startPos: hit.node.position.clone(),
      startQuat: hit.node.quaternion.clone(),
      grabPoint: hit.point.clone(),
      downX: e.clientX, downY: e.clientY,
      started: false
    };
    KB.orbit.enabled = false; // 按在物体上就不转视角(点选不受影响)
  });

  canvas.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < 6) return;
      drag.started = true;
      drag.vertical = e.shiftKey;
      KB.setSelection([drag.node]);
      begin(drag.node);
      canvas.style.cursor = 'grabbing';
      if (drag.vertical) {
        // 垂直模式:过抓取点、面向相机的立面
        var n = new THREE.Vector3();
        KB.camera.getWorldDirection(n);
        n.y = 0;
        if (n.lengthSq() < 1e-6) n.set(0, 0, 1); else n.normalize();
        plane.setFromNormalAndCoplanarPoint(n, drag.grabPoint);
      } else {
        // 水平模式:过抓取点的水平面
        plane.set(new THREE.Vector3(0, 1, 0), -drag.grabPoint.y);
      }
    }
    var p = planeHit(e.clientX, e.clientY);
    if (!p) return;
    var desired;
    if (drag.vertical) {
      desired = drag.startPos.clone();
      desired.y += p.y - drag.grabPoint.y;
    } else {
      desired = drag.startPos.clone().add(p.clone().sub(drag.grabPoint));
    }
    if (desired.y < 0.03) desired.y = 0.03;
    setSnapKey(e.ctrlKey);
    if (e.ctrlKey) {
      solve(drag.node, desired);        // 按住 Ctrl:磁性吸附
    } else {
      releaseActive();                  // 默认:自由移动
      placeWorld(drag.node, desired);
    }
    KB.syncInspector();
  });

  function endDrag(commit) {
    if (!drag) return;
    var d = drag;
    drag = null;
    KB.orbit.enabled = true;
    canvas.style.cursor = '';
    if (!d.started) return;
    var snapped = end();
    if (commit) {
      if (!snapped && KB.isSnap()) {
        // 无磁性吸附时按网格落定;有吸附则保持精确对齐
        d.node.position.x = Math.round(d.node.position.x / 0.25) * 0.25;
        d.node.position.y = Math.round(d.node.position.y / 0.25) * 0.25;
        d.node.position.z = Math.round(d.node.position.z / 0.25) * 0.25;
      }
      KB.pushSnapshot();
    } else {
      d.node.position.copy(d.startPos);
      d.node.quaternion.copy(d.startQuat);
      KB.syncInspector();
    }
  }

  canvas.addEventListener('pointerup', function () { endDrag(true); });
  canvas.addEventListener('pointercancel', function () { endDrag(false); });
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Escape' && drag && drag.started) endDrag(false);
  });
})();
