/* ============================================================
 * 孔位标注工具(Expert 模式)— 自动检测漏掉的孔(长槽、多边形孔)由人来点
 *
 *   Properties 面板里的 Features 区:列出选中零件的 H/P 特征(直径 / 深度可改、可删),
 *   「Label」开关打开后,把鼠标移到零件上的孔里 → 实时画出拟合的圆和轴,点一下就加上。
 *
 *   拟合方法(零件局部坐标):
 *     鼠标所在的表面平面(点 P、法线 n)= 最近一次射线打到的面;点在孔里打不到面时用上一次的平面
 *     孔口边缘顶点 = 落在该平面上、离 P 最近的一圈顶点 → 最小二乘圆 → 圆心 / 半径,迭代一次
 *     孔壁顶点 = 距轴 < 1.3 r 的顶点 → 沿轴的范围 = 深度、中心
 *   长槽会拟合成一个平均半径的圆(中心在槽中央);直径可以在列表里改成螺丝公称尺寸。
 *
 *   标注存 localStorage(刷新仍在),「Export」导出 contributor 格式 part_features.json:
 *     python3 tools/features_db.py import task_graphs.db part_features.json
 *     python3 tools/features_db.py manifest task_graphs.db <models_dir> --out assets/parts/manifest.json
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var canvas = document.getElementById('viewport');
  var STORE = 'kitbash-features-v1';

  var sec = document.getElementById('inspFeatures');
  var listEl = document.getElementById('featList');
  var btnLabel = document.getElementById('btnLabelMode');
  var kindSel = document.getElementById('featKind');
  var btnExport = document.getElementById('btnExportFeatures');
  var btnReset = document.getElementById('btnResetFeatures');
  var hintEl = document.getElementById('featHint');

  var on = false;
  var node = null;          // 当前标注的零件
  var verts = null;         // 该零件所有顶点(局部坐标,Float32Array xyz)
  var plane = null;         // {p, n} 局部坐标
  var preview = null;       // 当前拟合 {c, d, r, depth, kind}
  var viz = null;
  var overrides = load();

  /* ---------- 持久化 / 应用 ---------- */
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(overrides)); } catch (e) { /* 忽略 */ }
  }
  function applyOverrides() {
    Object.keys(overrides).forEach(function (key) {
      var spec = KBParts.spec(key);
      if (!spec) return;
      spec.holes = overrides[key].holes.map(clone);
      spec.pegs = overrides[key].pegs.map(clone);
    });
  }
  function clone(f) { return JSON.parse(JSON.stringify(f)); }
  function commit(key, spec) {
    overrides[key] = { holes: spec.holes.map(clone), pegs: spec.pegs.map(clone) };
    save();
  }
  (function waitParts() {
    if (window.KBParts && KBParts.ready()) { applyOverrides(); return; }
    setTimeout(waitParts, 100);
  })();

  /* ---------- 面板 ---------- */
  function keyOf(n) { return n && KB.isPart(n) ? n.userData.kbType.slice(5) : null; }
  function mm() {
    // 直径 / 深度按 mm 显示:manifest 单位 = 1/unitScale 原始单位,原始单位若是米再 ×1000
    return 1 / KBParts.unitScale() * 1000;
  }
  function refreshList() {
    var key = keyOf(node);
    listEl.innerHTML = '';
    if (!key) return;
    var spec = KBParts.spec(key);
    var k = mm();
    spec.holes.concat(spec.pegs).forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'feat-row';
      row.innerHTML = '<b>' + f.id + '</b>' +
        '<label>⌀<input type="number" step="0.1" value="' + (f.r * 2 * k).toFixed(1) + '"></label>' +
        '<label>↕<input type="number" step="0.1" value="' + (f.depth * k).toFixed(1) + '"></label>' +
        '<button title="Remove ' + f.id + '">×</button>';
      var inputs = row.querySelectorAll('input');
      inputs[0].addEventListener('change', function () { f.r = +inputs[0].value / 2 / k; commit(key, spec); relabel(); });
      inputs[1].addEventListener('change', function () { f.depth = +inputs[1].value / k; commit(key, spec); relabel(); });
      row.querySelector('button').addEventListener('click', function () {
        var list = f.id.charAt(0) === 'H' ? spec.holes : spec.pegs;
        list.splice(list.indexOf(f), 1);
        commit(key, spec); relabel();
      });
      listEl.appendChild(row);
    });
    btnReset.disabled = !overrides[key];
  }
  function relabel() {
    refreshList();
    KB.setSelection(node ? [KB.topOf(node)] : []); // 重画孔位圆片 / 标签
  }

  /* ---------- 拟合 ---------- */
  function gatherVerts(n) {
    var chunks = [], total = 0;
    n.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(n.matrixWorld).invert();
    n.traverse(function (o) {
      if (!o.isMesh || !o.geometry.attributes.position) return;
      var pos = o.geometry.attributes.position;
      var M = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      var arr = new Float32Array(pos.count * 3);
      var v = new THREE.Vector3();
      for (var i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(M);
        arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
      }
      chunks.push(arr); total += arr.length;
    });
    var out = new Float32Array(total), o = 0;
    chunks.forEach(function (c) { out.set(c, o); o += c.length; });
    return out;
  }

  function fitCircle(pts) { // Kasa 最小二乘(原点平移到均值以稳定):pts [[u,v],...] → {c:[u,v], r}
    var n = pts.length, mu = 0, mv = 0;
    pts.forEach(function (p) { mu += p[0] / n; mv += p[1] / n; });
    var A = 0, B = 0, C = 0, D = 0, E = 0;
    pts.forEach(function (p) {
      var u = p[0] - mu, v = p[1] - mv;
      A += u * u; B += u * v; C += v * v; D += u * (u * u + v * v); E += v * (u * u + v * v);
    });
    var det = A * C - B * B;
    if (Math.abs(det) < 1e-12) return null;
    var cu = (C * D - B * E) / (2 * det), cv = (A * E - B * D) / (2 * det);
    var r = 0;
    pts.forEach(function (p) { r += Math.hypot(p[0] - mu - cu, p[1] - mv - cv); });
    return { c: [cu + mu, cv + mv], r: r / n };
  }

  function fitAt(P, n) {
    if (!verts) return null;
    var u = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    u.cross(n).normalize();
    var v = n.clone().cross(u);
    var PLANE_TOL = 0.02, R_MAX = 0.6;
    var rim = [], i, x, y, z, dx, dy, dz, t, pu, pv, rho;
    // 落在平面上、离 P 不远的顶点
    for (i = 0; i < verts.length; i += 3) {
      x = verts[i]; y = verts[i + 1]; z = verts[i + 2];
      dx = x - P.x; dy = y - P.y; dz = z - P.z;
      t = dx * n.x + dy * n.y + dz * n.z;
      if (Math.abs(t) > PLANE_TOL) continue;
      pu = dx * u.x + dy * u.y + dz * u.z; pv = dx * v.x + dy * v.y + dz * v.z;
      rho = Math.hypot(pu, pv);
      if (rho < R_MAX) rim.push([pu, pv, rho]);
    }
    if (rim.length < 6) return null;
    var d0 = Infinity;
    rim.forEach(function (p) { if (p[2] < d0) d0 = p[2]; });
    var ring = rim.filter(function (p) { return p[2] >= d0 * 0.6 && p[2] <= d0 * 1.8; });
    var fit = fitCircle(ring);
    if (!fit) return null;
    // 用拟合圆心再选一次孔口顶点,复拟合(长槽 / 初次偏心时更准)
    ring = rim.filter(function (p) { var rr = Math.hypot(p[0] - fit.c[0], p[1] - fit.c[1]); return rr > fit.r * 0.65 && rr < fit.r * 1.35; });
    if (ring.length >= 6) fit = fitCircle(ring) || fit;
    if (!fit || fit.r < 0.015 || fit.r > 0.5) return null;
    // 鼠标点必须在圆里,且孔口顶点要绕圆心一圈(≥ 270°)——否则是在实体表面上凑到了外边缘
    if (Math.hypot(fit.c[0], fit.c[1]) > fit.r * 0.9) return null;
    var bins = {};
    ring.forEach(function (p) { bins[Math.floor((Math.atan2(p[1] - fit.c[1], p[0] - fit.c[0]) + Math.PI) / (2 * Math.PI) * 12) % 12] = 1; });
    if (Object.keys(bins).length < 9) return null;
    var c = P.clone().addScaledVector(u, fit.c[0]).addScaledVector(v, fit.c[1]);
    // 孔壁顶点:距轴 < 1.3 r → 深度与轴向中心
    var tmin = Infinity, tmax = -Infinity, cnt = 0;
    for (i = 0; i < verts.length; i += 3) {
      dx = verts[i] - c.x; dy = verts[i + 1] - c.y; dz = verts[i + 2] - c.z;
      t = dx * n.x + dy * n.y + dz * n.z;
      pu = dx * u.x + dy * u.y + dz * u.z; pv = dx * v.x + dy * v.y + dz * v.z;
      if (Math.hypot(pu, pv) > fit.r * 1.3) continue;
      if (Math.abs(t) > 2) continue;
      if (t < tmin) tmin = t; if (t > tmax) tmax = t; cnt++;
    }
    var depth = cnt >= 4 && tmax - tmin > 0.005 ? tmax - tmin : 0.1;
    var mid = cnt >= 4 && tmax - tmin > 0.005 ? (tmin + tmax) / 2 : -depth / 2;
    return { c: c.addScaledVector(n, mid), d: n.clone(), r: fit.r, depth: depth };
  }

  /* ---------- 预览 ---------- */
  function showPreview(f) {
    hidePreview();
    if (!f) return;
    var g = new THREE.Group();
    g.userData.kbOverlay = true;
    var color = kindSel.value === 'peg' ? 0x6fa8dc : 0xe8a33d;
    function ring(off) {
      var m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40), new THREE.MeshBasicMaterial({
        color: color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      m.scale.set(f.r, f.r, 1);
      m.position.copy(f.c).addScaledVector(f.d, off);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f.d);
      m.renderOrder = 999;
      return m;
    }
    g.add(ring(f.depth / 2), ring(-f.depth / 2));
    var axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      f.c.clone().addScaledVector(f.d, -f.depth / 2 - 0.15), f.c.clone().addScaledVector(f.d, f.depth / 2 + 0.15)]),
      new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.9, depthTest: false }));
    axis.renderOrder = 999;
    g.add(axis);
    g.matrixAutoUpdate = false;
    g.matrix.copy(node.matrixWorld);
    g.matrixWorldNeedsUpdate = true;
    KB.scene.add(g);
    viz = g;
    var k = mm();
    hintEl.textContent = '⌀' + (f.r * 2 * k).toFixed(1) + ' mm · depth ' + (f.depth * k).toFixed(1) + ' mm — click to add';
  }
  function hidePreview() {
    if (!viz) return;
    viz.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    KB.scene.remove(viz);
    viz = null;
  }

  /* ---------- 输入 ---------- */
  var ray = new THREE.Raycaster();
  var ndc = new THREE.Vector2();
  function castOnNode(px, py) {
    ndc.x = (px / window.innerWidth) * 2 - 1;
    ndc.y = -(py / window.innerHeight) * 2 + 1;
    ray.setFromCamera(ndc, KB.camera);
    var meshes = [];
    node.traverse(function (o) { if (o.isMesh) meshes.push(o); });
    var hits = ray.intersectObjects(meshes, false);
    return hits.length ? hits[0] : null;
  }

  function onMove(e) {
    if (!on || !node) return;
    var hit = castOnNode(e.clientX, e.clientY);
    node.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
    var P, n;
    if (hit && hit.face) {
      n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).transformDirection(inv).normalize();
      P = hit.point.clone().applyMatrix4(inv);
      plane = { p: P, n: n };
    } else if (plane) {
      // 点在孔里:射线穿过去打不到面,取与上一次表面平面的交点
      var wp = plane.p.clone().applyMatrix4(node.matrixWorld);
      var wn = plane.n.clone().transformDirection(node.matrixWorld);
      var pl = new THREE.Plane().setFromNormalAndCoplanarPoint(wn, wp);
      var hitW = ray.ray.intersectPlane(pl, new THREE.Vector3());
      if (!hitW) { preview = null; hidePreview(); return; }
      P = hitW.applyMatrix4(inv); n = plane.n;
    } else { preview = null; hidePreview(); return; }
    preview = fitAt(P, n);
    showPreview(preview);
    if (!preview) hintEl.textContent = 'Hover a hole (or a peg top) on the part';
  }

  function onDown(e) {
    if (!on || !node) return;
    e.stopImmediatePropagation();
  }
  function onUp(e) {
    if (!on || !node) return;
    e.stopImmediatePropagation();
    if (e.button !== 0 || !preview) return;
    var key = keyOf(node), spec = KBParts.spec(key);
    var kind = kindSel.value;
    var list = kind === 'peg' ? spec.pegs : spec.holes;
    var prefix = kind === 'peg' ? 'P' : 'H';
    var maxN = 0;
    list.forEach(function (f) { var m = /\d+$/.exec(f.id); if (m) maxN = Math.max(maxN, +m[0]); });
    // 与已有特征重合(同轴、同心)→ 视为重复,不加
    var dup = list.some(function (f) {
      var c = new THREE.Vector3().fromArray(f.c), d = new THREE.Vector3().fromArray(f.d);
      var v = preview.c.clone().sub(c);
      var perp = v.clone().addScaledVector(d, -v.dot(d)).length();
      return Math.abs(d.dot(preview.d)) > 0.95 && perp < Math.max(f.r, preview.r) * 0.6 && Math.abs(v.dot(d)) < f.depth;
    });
    if (dup) { KB.toast('That feature is already labelled'); return; }
    list.push({ id: prefix + (maxN + 1), c: preview.c.toArray().map(r4), d: preview.d.toArray().map(r4),
      r: r4(preview.r), depth: r4(preview.depth) });
    commit(key, spec);
    KB.toast(prefix + (maxN + 1) + ' added');
    relabel();
  }
  function r4(x) { return Math.round(x * 1e4) / 1e4; }

  canvas.addEventListener('pointermove', onMove, true);
  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('pointerup', onUp, true);

  /* ---------- 开关 / 选择 ---------- */
  function setOn(v) {
    on = !!v && !!node;
    btnLabel.classList.toggle('on', on);
    canvas.style.cursor = on ? 'crosshair' : '';
    if (on) { verts = gatherVerts(node); hintEl.textContent = 'Hover a hole (or a peg top) on the part'; }
    else { verts = null; plane = null; preview = null; hidePreview(); hintEl.textContent = ''; }
  }
  btnLabel.addEventListener('click', function () { setOn(!on); });
  kindSel.addEventListener('change', function () { if (preview) showPreview(preview); });
  btnReset.addEventListener('click', function () {
    var key = keyOf(node);
    if (!key || !overrides[key]) return;
    if (!confirm('Drop your labels for this part type and go back to the manifest features?')) return;
    delete overrides[key]; save();
    var spec = KBParts.spec(key), orig = KBParts.original(key);
    spec.holes = orig.holes.map(clone); spec.pegs = orig.pegs.map(clone);
    relabel();
  });

  KB.onSelection(function (sel) {
    var n = sel.length === 1 && KB.isPart(sel[0]) ? sel[0] : null;
    if (n !== node) { node = n; if (on) setOn(false); }
    sec.style.display = node ? '' : 'none';
    refreshList();
  });
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Escape' && on) { e.stopImmediatePropagation(); setOn(false); } // 只退出标注,不取消选择
  }, true);

  /* ---------- 导出 contributor 文件 ---------- */
  btnExport.addEventListener('click', function () {
    var keys = Object.keys(overrides);
    if (!keys.length) { KB.toast('No labels yet'); return; }
    var S = KBParts.unitScale();
    var out = keys.map(function (key) {
      var spec = KBParts.spec(key);
      var ext = Math.max(spec.bbox.max[0] - spec.bbox.min[0], spec.bbox.max[1] - spec.bbox.min[1], spec.bbox.max[2] - spec.bbox.min[2]) / S;
      var k = ext > 1 ? 1 : 1000; // 原始 GLB 单位:mm 或 m
      function toMM(c) { return c.map(function (x, i) { return Math.round((x / S + spec.offset[i]) * k * 1000) / 1000; }); }
      return {
        partType: spec.partTypeUuid || null, model: spec.models ? spec.models[0] : null, name: spec.name || spec.label,
        features: spec.holes.concat(spec.pegs).map(function (f) {
          return { name: f.id, kind: f.id.charAt(0) === 'H' ? 'hole' : 'peg', center: toMM(f.c), axis: f.d,
            diameter: Math.round(f.r * 2 / S * k * 1000) / 1000, depth: Math.round(f.depth / S * k * 1000) / 1000 };
        }),
        symmetries: (spec.sym || []).map(function (sy) { return { axis: sy.axis, center: toMM(spec.sym_center), degrees: sy.deg }; })
      };
    });
    KB.saveFile(JSON.stringify(out, null, 1), 'part_features.json',
      'part_features.json saved \u2014 import with tools/features_db.py, then regenerate the manifest');
  });

  window.KBLabel = { active: function () { return on; }, fitAt: fitAt, overrides: function () { return overrides; } };
})();
