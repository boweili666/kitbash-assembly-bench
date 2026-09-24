/* ============================================================
 * 点选装配 — 点一个孔/销,再点另一个零件的孔/销,零件自动装上
 *
 * 比按住 Ctrl 边拖边找省事:两下点击就把轴对齐、端面贴平。
 *   1. 选中零件后,它的孔(琥珀)/销(蓝)变成可点的圆片;点一个 → 作为「源」
 *   2. 此时其他所有零件的孔/销都亮出来;点一个 → 源零件飞过去装上
 *      销→孔:销插进孔,销根(螺丝头下沿)停在孔口;从相机看着的那个孔口进入
 *      孔→销:源零件上点的孔口贴到销根上
 *      孔→孔:每个孔有上下两个孔口圆片,点的两个孔口面对面贴在一起(同轴)。
 *             要让板子正着落在下面的东西上,就点板子的下孔口(斜着看、或转到底下点)
 *      销→销 / 销比孔粗:拒绝,红色提示,并像拖动吸附一样上报 snapAttempt
 *   3. 装上后零件锁在孔上(拖拽 / 点网格都不动它),方向键相对孔轴:← / → 绕轴转 1°(Shift 90°),
 *      ↑ / ↓ 沿轴拔出 / 推入 0.25 mm(Shift 0.05 mm);再点一下零件解锁;
 *      专家模式下变换枢轴也移到孔上,Rotate 模式直接绕孔转
 *   Esc / 点空白 取消。原来的 Ctrl 拖动吸附照旧可用。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var canvas = document.getElementById('viewport');

  // 圆片要和零件本身拉开色差:零件是白 / 灰 / 银,所以孔用亮品红、销用紫罗兰,
  // 也避开了选中绿、报错红、当前零件的青色高亮和 Next 的琥珀
  var COLOR_HOLE = 0xff2d95, COLOR_PEG = 0x8a4bff, COLOR_ARMED = 0x5ad35a, COLOR_BAD = 0xd9534f;
  var OPACITY_IDLE = 0.55, OPACITY_HOVER = 1, OPACITY_ARMED = 1;
  var OPACITY_DIMMED = 0.22;   // 有孔被点亮(教程 / 二级引导)时,其余圆片压暗,让该点的那个跳出来
  var RIM_COLOR = 0x07080b;     // 每个圆片外面一圈深色描边:贴在白螺丝上也有清楚的边
  var STEP_DEG = 1, STEP_BIG_DEG = 90;                // ←→ 绕孔轴(Shift = 90°,一次到位)
  var STEP_SLIDE_MM = 0.25, STEP_SLIDE_FINE_MM = 0.05; // ↑↓ 沿孔轴
  // 编辑器单位 ↔ 毫米:1 单位 ≈ 40 mm(unitScale 是「1 mm 折多少单位」的倒数的一千倍)
  function unitsPerMm() { return (window.KBParts ? KBParts.unitScale() : 24.77) / 1000; }

  var root = new THREE.Group();
  root.userData.kbOverlay = true; // 抓帧时隐藏
  root.renderOrder = 998;
  KB.scene.add(root);

  var selection = [];
  var markers = [];   // {meshes, material, node(零件), f(manifest 特征), kind:'hole'|'peg'}
  var groups = [];    // {group, node} 每个零件一个,矩阵每帧跟随零件
  var armed = null;   // 已选中的源特征(marker)
  var hover = null;
  var lastMate = null; // {node(顶层节点), point, dir} 最近一次装配的轴,供 ←/→ 与枢轴使用
  var mating = false;
  var bursts = [];    // 落座光环动画

  function radiusTol() { return 0.3 * (window.KBParts ? KBParts.unitScale() : 24.77) / 1000; }

  // 节点还在场景里(可能暂时挂在变换枢轴下,不在 objectsRoot 内)
  function inScene(n) {
    for (var q = n; q; q = q.parent) if (q === KB.scene) return true;
    return false;
  }

  /* 顶层节点;零件暂时挂在变换枢轴下时(userData._prevParent)也能找对 */
  function topOf(n) {
    while (n.parent && n.parent !== KB.objectsRoot && !n.userData._prevParent) n = n.parent;
    return n;
  }

  /* ---------- 可点的孔位圆片 ---------- */
  var discGeo = new THREE.CircleGeometry(1, 32);
  var rimGeo = new THREE.RingGeometry(0.9, 1.2, 40);
  var rimMat = new THREE.MeshBasicMaterial({ color: 0x07080b, transparent: true, opacity: 0.45,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  var ringGeo = new THREE.RingGeometry(0.88, 1, 48);

  function clearMarkers() {
    groups.forEach(function (g) { root.remove(g.group); });
    markers.forEach(function (m) {
      m.material.dispose();
      (m.rings || []).forEach(function (r) { r.material.dispose(); });
    });
    groups = [];
    markers = [];
    hover = null;
    canvas.style.cursor = '';
  }

  function partsUnder(node, out) {
    node.traverse(function (o) { if (KB.isPart(o)) out.push(o); });
    return out;
  }

  function addMarkersFor(node) {
    var spec = window.KBParts && KBParts.spec(node.userData.kbType.slice(5));
    if (!spec) return;
    var group = new THREE.Group();
    group.matrixAutoUpdate = false;
    function add(list, kind, color) {
      list.forEach(function (f) {
        if (filterCtx && !filter.keep(filterCtx, node, f, kind)) return;
        var c = new THREE.Vector3().fromArray(f.c);
        var d = new THREE.Vector3().fromArray(f.d).normalize();
        var material = new THREE.MeshBasicMaterial({
          color: color, transparent: true, opacity: OPACITY_IDLE,
          depthTest: false, depthWrite: false, side: THREE.DoubleSide
        });
        // 孔有两个孔口,各放一个圆片(end = ±1,沿 d 的哪一头):点的是哪个孔口就以哪个孔口贴合;
        // 稍微探出孔口一点,俯视时上面那个离相机近、先被拾取。销只在中段放一个(end = 0)
        var ends = kind === 'hole' ? [-1, 1] : [0];
        ends.forEach(function (end) {
          if (filterCtx && filter.keepEnd && !filter.keepEnd(filterCtx, node, f, kind, end)) return;
          var mat = end === 1 ? material.clone() : material;
          var m = { meshes: [], material: mat, node: node, f: f, kind: kind, color: color, end: end,
            op: OPACITY_IDLE, r: Math.max(f.r * 1.25, 0.07), scale: 1, born: performance.now() };
          var mesh = new THREE.Mesh(discGeo, mat);
          mesh.scale.set(m.r, m.r, 1);
          mesh.position.copy(c).addScaledVector(d, end * (f.depth / 2 + 0.012));
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
          mesh.renderOrder = 998;
          mesh.userData.marker = m;
          var rim = new THREE.Mesh(rimGeo, rimMat);
          rim.position.copy(mesh.position);
          rim.quaternion.copy(mesh.quaternion);
          rim.scale.copy(mesh.scale);
          rim.renderOrder = 997;
          rim.userData.marker = m;             // 边框是圆片看得见的一部分:点在边框上也算点中它
          group.add(rim);
          group.add(mesh);
          m.meshes.push(mesh, rim);
          if (spot.length && !spotted(m) && m !== armed) style(m, color, OPACITY_DIMMED);
          if (spotted(m)) {
            style(m, COLOR_SPOT, OPACITY_HOVER);      // 一建出来就是亮色,不用等鼠标悬停
            // 聚光:圆片外再套两圈亮环,一圈向外扩散,让人一眼看到该点哪里
            m.rings = [0, 1].map(function (k) {
              var ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
              ring.position.copy(mesh.position);
              ring.quaternion.copy(mesh.quaternion);
              ring.renderOrder = 999;
              ring.userData.phase = k * 0.5;
              group.add(ring);
              return ring;
            });
          }
          markers.push(m);
        });
      });
    }
    add(spec.holes, 'hole', COLOR_HOLE);
    add(spec.pegs, 'peg', COLOR_PEG);
    root.add(group);
    groups.push({ group: group, node: node });
  }

  /* 未选源:选中零件的孔/销可点;已选源:其他所有零件的孔/销可点(源零件本身保持高亮) */
  var filter = null;         // 只显示用得上的孔:{begin(armedInfo) -> ctx, keep(ctx, node, f, kind) -> bool}
  var filterCtx = null;
  var enabled = true;        // 难度一级时关掉:点零件直接到位,不需要点孔
  var resolver = null;       // 难度二级:点对了孔,位姿交给答案去算 —— fn(src, dst) -> 'handled' | '原因' | null
  function mateOn() {
    if (window.KBTutorial && KBTutorial.active()) return !KBTutorial.discs || KBTutorial.discs();
    return enabled;
  }
  function rebuildMarkers() {
    clearMarkers();
    if (!mateOn()) return;
    var list = [];
    if (armed) {
      var top = topOf(armed.node);
      KB.objectsRoot.children.forEach(function (o) { if (o !== top) partsUnder(o, list); });
      list.push(armed.node);
    } else {
      selection.forEach(function (n) { partsUnder(n, list); });
    }
    // 教程要的圆片一个都不能少,过滤只在教程外生效
    filterCtx = filter && !(window.KBTutorial && KBTutorial.active()) ? filter.begin(armed ? info(armed) : null) : null;
    list.forEach(addMarkersFor);
    filterCtx = null;
    if (armed) {
      // 源特征重新绑定到新建的 marker 上
      var m = findMarker(armed.node, armed.f.id, armed.end);
      armed = m || null;
      if (armed) style(armed, COLOR_ARMED, OPACITY_ARMED);
    }
    syncGroups();
  }

  function findMarker(node, id, end) {
    for (var i = 0; i < markers.length; i++) {
      if (markers[i].node === node && markers[i].f.id === id && markers[i].end === end) return markers[i];
    }
    return null;
  }

  function style(m, color, opacity) {
    m.material.color.set(color);
    m.op = opacity; // 实际透明度在 animateMarkers 里按淡入 / 脉动算
  }

  /* 教程用:聚光某几个孔口(亮青色、大幅脉动),以及点击守卫(点错了拒绝并给出原因) */
  var spot = [];      // [{node, id, end?}]
  var guard = null;   // {arm: fn(info) -> true | 'reason', mate: fn(srcInfo, dstInfo) -> true | 'reason'}
  var COLOR_SPOT = 0x9af2ff;
  function spotted(m) {
    for (var i = 0; i < spot.length; i++) {
      var sp = spot[i];
      if (sp.node === m.node && sp.id === m.f.id && (sp.end === undefined || sp.end === m.end)) return true;
    }
    return false;
  }
  function info(m) { return { node: m.node, id: m.f.id, end: m.end, kind: m.kind }; }
  function restyle(m) {
    if (m === armed) style(m, COLOR_ARMED, OPACITY_ARMED);
    else if (spotted(m)) style(m, COLOR_SPOT, OPACITY_HOVER);
    else style(m, m.color, m === hover ? OPACITY_HOVER : (spot.length ? OPACITY_DIMMED : OPACITY_IDLE));
  }

  function syncGroups() {
    groups.forEach(function (g) {
      g.node.updateMatrixWorld(true);
      g.group.matrix.copy(g.node.matrixWorld);
      g.group.matrixWorldNeedsUpdate = true;
    });
  }

  /* 圆片动画:新出现的淡入,悬停放大,源圆片呼吸脉动;源 → 悬停目标之间画一条虚线 */
  var link = null;
  function animateMarkers(now, dt) {
    var pulse = 0.5 + 0.5 * Math.sin(now / 160);
    markers.forEach(function (m) {
      var fade = KB.reducedMotion ? 1 : Math.min(1, (now - m.born) / 220);
      var isSpot = m !== armed && spotted(m);
      var target = m === armed ? 1.1 + 0.15 * pulse : (m === hover ? 1.25 : (isSpot ? 1.3 + 0.3 * pulse : 1));
      m.scale += (target - m.scale) * Math.min(1, dt * 14);
      var sc = m.r * m.scale;
      m.meshes.forEach(function (mesh) { mesh.scale.set(sc, sc, 1); });
      m.material.opacity = m.op * fade * (m === armed || isSpot ? 0.7 + 0.3 * pulse : 1);
      (m.rings || []).forEach(function (ring) {
        // 每 1.2 s 从圆片边缘向外扩到 3.6 倍并淡出;两圈错开半个周期
        var k = ((now / 1200) + ring.userData.phase) % 1;
        var rr = m.r * (1.2 + 2.4 * k);
        ring.scale.set(rr, rr, 1);
        ring.material.opacity = (m === armed ? 0 : 0.95 * (1 - k)) * fade;
      });
    });
    var want = armed && hover && hover !== armed && topOf(hover.node) !== topOf(armed.node);
    if (!want) { if (link) { KB.scene.remove(link); link.geometry.dispose(); link.material.dispose(); link = null; } return; }
    var a = armed.meshes[0].getWorldPosition(new THREE.Vector3());
    var b = hover.meshes[0].getWorldPosition(new THREE.Vector3());
    if (!link) {
      link = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineDashedMaterial({
        color: COLOR_ARMED, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.85, depthTest: false
      }));
      link.userData.kbOverlay = true;
      link.renderOrder = 999;
      KB.scene.add(link);
    } else {
      link.geometry.setFromPoints([a, b]);
    }
    link.computeLineDistances();
    var ld = link.geometry.getAttribute('lineDistance'); // r147 没有 dashOffset:平移距离值让虚线向目标流动
    var off = (now / 400) % 0.2;
    for (var i = 0; i < ld.count; i++) ld.setX(i, ld.getX(i) + off);
    ld.needsUpdate = true;
  }

  var lastTick = performance.now();
  (function tick() {
    requestAnimationFrame(tick);
    var now = performance.now();
    var dt = Math.min(0.05, (now - lastTick) / 1000);
    lastTick = now;
    syncGroups();
    animateMarkers(now, dt);
    stepBursts(dt);
    updateLockViz(now);
  })();

  var ray = new THREE.Raycaster();
  var ndc = new THREE.Vector2();
  function pick(px, py) {
    if (!markers.length || !mateOn()) return null;
    syncGroups();
    root.updateMatrixWorld(true);
    ndc.x = (px / window.innerWidth) * 2 - 1;
    ndc.y = -(py / window.innerHeight) * 2 + 1;
    ray.setFromCamera(ndc, KB.camera);
    var meshes = [];
    markers.forEach(function (m) { meshes.push.apply(meshes, m.meshes); });
    var hits = ray.intersectObjects(meshes, false);
    if (!hits.length) {
      // 斜着看时点在孔的视觉中心可能落在两个孔口圆片之间:退而按屏幕距离取 16px 内最近的圆片
      // 16px 内有几个(叠在一起的孔口)时取离相机最近的那个
      var best2 = null, bz = Infinity, sp = new THREE.Vector3();
      meshes.forEach(function (mesh) {
        mesh.getWorldPosition(sp).project(KB.camera);
        if (sp.z > 1) return;
        var dpx = Math.hypot((sp.x + 1) / 2 * window.innerWidth - px, (1 - sp.y) / 2 * window.innerHeight - py);
        if (dpx < 16 && sp.z < bz) { bz = sp.z; best2 = mesh.userData.marker; }
      });
      return best2;
    }
    // 点在被点亮(引导 / 教程)的圆片上就是它:点亮的圆片画得大,点在它靠边的地方时,
    // 下面同轴那个零件的小圆片圆心反而离鼠标更近,以前就会被误选成"下面那个"
    var lit = hits.filter(function (h) { return spotted(h.object.userData.marker); });
    if (lit.length) return lit[0].object.userData.marker;
    // 只在离镜头最近的那一层里挑(薄板上下两个孔口还在这个范围内),更深处被挡住的圆片不算
    var near = hits[0].distance;
    hits = hits.filter(function (h) { return h.distance - near < 0.15; });
    // 射线穿过好几个圆片(薄板上下两个孔口、螺柱里孔与柱重叠)时:取圆心在屏幕上离鼠标最近的;
    // 同样近(同轴同心)则优先孔、再取小的
    var best = null, bestPx = Infinity, sp2 = new THREE.Vector3();
    hits.forEach(function (h) {
      var m = h.object.userData.marker;
      h.object.getWorldPosition(sp2).project(KB.camera);
      var dpx = Math.hypot((sp2.x + 1) / 2 * window.innerWidth - px, (1 - sp2.y) / 2 * window.innerHeight - py);
      if (dpx < bestPx - 2) { best = m; bestPx = dpx; }
      else if (Math.abs(dpx - bestPx) <= 2 && ((m.kind === 'hole' && best.kind !== 'hole') || (m.kind === best.kind && m.f.r < best.f.r))) best = m;
    });
    return best;
  }

  /* ---------- 特征的世界坐标 ---------- */
  function worldFeature(m) {
    var node = m.node;
    var spec = KBParts.spec(node.userData.kbType.slice(5));
    node.updateMatrixWorld(true);
    var M = node.matrixWorld;
    var ws = new THREE.Vector3();
    node.getWorldScale(ws);
    var s = (Math.abs(ws.x) + Math.abs(ws.y) + Math.abs(ws.z)) / 3;
    var f = m.f;
    var c = new THREE.Vector3().fromArray(f.c).applyMatrix4(M);
    var d = new THREE.Vector3().fromArray(f.d).transformDirection(M);
    var out = { c: c, d: d, r: f.r * s, depth: f.depth * s, kind: m.kind, id: f.id, owner: node, end: m.end || 0 };
    if (out.end) {
      // 被点的孔口:外法线 n(指向孔外)与孔口中心 mouth
      out.n = d.clone().multiplyScalar(out.end);
      out.mouth = c.clone().addScaledVector(out.n, out.depth / 2);
    }
    // 零件本体中心:销的「尖端」指向离本体远的一端(螺丝头在本体这一侧)
    var mn = spec.bbox.min, mx = spec.bbox.max;
    out.body = new THREE.Vector3((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2).applyMatrix4(M);
    if (m.kind === 'peg') {
      var sgn = c.clone().sub(out.body).dot(d);
      out.tip = Math.abs(sgn) < 1e-6 ? d.clone() : d.clone().multiplyScalar(sgn < 0 ? -1 : 1);
    }
    return out;
  }

  /* 把 node 的世界变换左乘 delta(先绕 pivot 转 q,再平移 t) */
  function applyWorld(node, q, t) {
    node.updateMatrixWorld(true);
    var delta = new THREE.Matrix4().makeRotationFromQuaternion(q);
    delta.setPosition(t);
    var world = delta.multiply(node.matrixWorld);
    var parentInv = new THREE.Matrix4();
    if (node.parent) { node.parent.updateMatrixWorld(true); parentInv.copy(node.parent.matrixWorld).invert(); }
    world.premultiply(parentInv);
    world.decompose(node.position, node.quaternion, node.scale);
    node.updateMatrixWorld(true);
  }

  function report(a, b, ok, reason) {
    KB.emit('snapAttempt', { object1: a.owner, object2: b.owner, snapPoint1: a.id, snapPoint2: b.id,
      success: ok, reason: reason || null });
  }

  /* ---------- 装配求解:源 a(在移动零件上)装到目标 b ---------- */
  function mate(src, dst) {
    KB.bakePivot();
    var a = worldFeature(src), b = worldFeature(dst);
    var top = topOf(src.node);
    if (topOf(dst.node) === top) return false;
    if (window.KBWorkspace && !KBWorkspace.contains(topOf(dst.node))) {
      report(a, b, false, 'receiving part outside workspace');
      KB.toast(KBWorkspace.message(dst.node));
      return false;
    }

    var reason = null;
    if (a.kind === 'peg' && b.kind === 'peg') reason = 'peg-on-peg';
    else {
      var peg = a.kind === 'peg' ? a : (b.kind === 'peg' ? b : null);
      var hole = peg === a ? b : a;
      if (peg && peg.r > hole.r + radiusTol()) reason = 'peg wider than hole';
    }
    if (reason) {
      report(a, b, false, reason);
      flash(dst, COLOR_BAD);
      KB.toast(reason === 'peg-on-peg' ? 'Cannot mate a peg to a peg' : 'The peg is wider than that hole');
      return false;
    }

    // 目标孔用哪个孔口:点了哪个就是哪个;程序化调用没指定时取朝向相机的一侧
    var side = b.n ? b.n.clone() : b.d.clone();
    if (!b.n && KB.camera.getWorldPosition(new THREE.Vector3()).sub(b.c).dot(b.d) < 0) side.negate();
    // 源零件上点的孔口就是要贴上去的那一面:两个被点的孔口面对面贴在一起。
    // 没指定则取与目标最小旋转的那一头(程序化调用)
    function srcNormal(towards) {
      if (a.n) return a.n.clone();
      return a.d.dot(towards) < 0 ? a.d.clone().negate() : a.d.clone();
    }

    var q, center, axisDir;
    if (a.kind === 'peg' && b.kind === 'hole') {
      // 销从 side 孔口插入,销根停在孔口
      q = new THREE.Quaternion().setFromUnitVectors(a.tip, side.clone().negate());
      center = b.c.clone().addScaledVector(side, (b.depth - a.depth) / 2);
      axisDir = side;
    } else if (a.kind === 'hole' && b.kind === 'peg') {
      // 孔套到销根:被点的孔口贴在销根平面上(它的外法线朝销根,即背向销尖)
      var na = srcNormal(b.tip.clone().negate());
      q = new THREE.Quaternion().setFromUnitVectors(na, b.tip.clone().negate());
      center = b.c.clone().addScaledVector(b.tip, -b.depth / 2 + a.depth / 2);
      axisDir = b.tip;
    } else {
      // 孔对孔:被点的两个孔口贴在一起(外法线相对),同轴
      var nb = side;
      var na2 = srcNormal(nb.clone().negate());
      q = new THREE.Quaternion().setFromUnitVectors(na2, nb.clone().negate());
      center = b.c.clone().addScaledVector(nb, (b.depth + a.depth) / 2);
      axisDir = nb;
    }

    // 绕 a.c 旋转,再把 a.c 平移到 center
    function deltaTo(target) {
      var t = a.c.clone().sub(a.c.clone().applyQuaternion(q)); // 旋转后 a.c 保持不动
      return t.add(target).sub(a.c);
    }
    // 先算出终点位姿,再飞过去(弧线抬升、最后落座);事件与快照在落座时发
    KB.finishTween(top);
    var p0 = top.position.clone(), q0 = top.quaternion.clone();
    applyWorld(top, q, deltaTo(center));
    if (a.kind === 'hole' && b.kind === 'peg' && window.KBCollide) {
      // 销根已经被别的零件占了(螺丝穿过板子):沿销往尖端方向退,退到不再穿模为止 —— 螺柱拧在露出的螺丝尖上
      var others = [];
      KB.objectsRoot.children.forEach(function (o) { if (o !== top && o !== topOf(dst.node)) partsUnder(o, others); });
      var mine = partsUnder(top, []);
      var tol = 0.5 * (KBParts.unitScale() / 1000);
      function clear() {
        for (var i = 0; i < mine.length; i++) {
          var boxA = new THREE.Box3().expandByObject(mine[i]);
          for (var j = 0; j < others.length; j++) {
            if (!boxA.intersectsBox(new THREE.Box3().expandByObject(others[j]))) continue;
            if (KBCollide.penetration(mine[i], others[j]) > tol) return false;
          }
        }
        return true;
      }
      var stepLen = 0.5 * (KBParts.unitScale() / 1000), maxOff = Math.max(0, b.depth - Math.min(a.depth, b.depth) * 0.3);
      var off = 0;
      while (!clear() && off < maxOff) {
        off = Math.min(maxOff, off + stepLen);
        top.position.copy(p0); top.quaternion.copy(q0); top.updateMatrixWorld(true);
        applyWorld(top, q, deltaTo(center.clone().addScaledVector(b.tip, off)));
      }
      if (off > 0) center.addScaledVector(b.tip, off);
    }
    if (window.KBWorkspace && !KBWorkspace.contains(top)) {
      top.position.copy(p0); top.quaternion.copy(q0); top.updateMatrixWorld(true);
      report(a, b, false, 'assembly would cross workspace boundary');
      KB.toast('Move the receiving part further inside the workspace before connecting.');
      return false;
    }
    var p1 = top.position.clone(), q1 = top.quaternion.clone();
    top.position.copy(p0); top.quaternion.copy(q0); top.updateMatrixWorld(true);
    mating = true;
    KB.emit('grab', top);
    mating = false;
    // 两段:先飞到孔轴延长线上、孔口外一段距离(已转正),再沿轴插入
    var gap = Math.max(0.5, a.depth) + 0.25;
    var offW = axisDir.clone().normalize().multiplyScalar(gap);
    var pq = top.parent ? top.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion();
    var pA = p1.clone().add(offW.applyQuaternion(pq));
    var dist = p0.distanceTo(pA);
    KB.tween(top, pA, q1, {
      duration: 0.4 + Math.min(0.4, dist * 0.08), arc: Math.min(0.6, 0.15 + dist * 0.1),
      onDone: function (interrupted) { if (!interrupted) KB.tween(top, p1, q1, { duration: 0.32, onDone: seat }); }
    });
    function seat(interrupted) {
      if (!interrupted) {
        mating = true;
        lastMate = { node: top, point: center.clone(), dir: axisDir.clone().normalize() };
        KB.emit('place', top);
        mating = false;
        report(a, b, true);
        burst(center, axisDir, Math.max(b.r || 0.05, a.r || 0.05));
        KB.setSelection([]); // Successful seating ends the selection; retain the hole hinge for arrow-key adjustments.
        KB.pushSnapshot();
        KB.syncInspector();
        KB.toast((a.owner.name || 'Part') + ' \u2192 ' + (b.owner.name || 'part') + ' mated \u2014 locked on the hole. \u2191\u2193 slide, \u2190\u2192 turn; click it to release');
      }
    }
    return true;
  }

  /* ---------- 落座时的光环:从孔口扩散出去的圆环 ---------- */
  function burst(c, d, r) {
    if (KB.reducedMotion) return;
    var g = new THREE.Group();
    g.userData.kbOverlay = true;
    g.position.copy(c);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.clone().normalize());
    for (var i = 0; i < 2; i++) {
      var ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 48), new THREE.MeshBasicMaterial({
        color: i ? COLOR_ARMED : 0xffffff, transparent: true, opacity: 0.9,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide
      }));
      ring.renderOrder = 999;
      ring.userData.delay = i * 0.12;
      g.add(ring);
    }
    g.renderOrder = 999;
    KB.scene.add(g);
    bursts.push({ g: g, t: 0, r0: Math.max(r * 1.6, 0.1), r1: Math.max(r * 6, 0.5) });
  }
  function stepBursts(dt) {
    for (var i = bursts.length - 1; i >= 0; i--) {
      var b = bursts[i];
      b.t += dt;
      var alive = false;
      b.g.children.forEach(function (ring) {
        var k = Math.min(1, Math.max(0, (b.t - ring.userData.delay) / 0.55));
        var e = 1 - Math.pow(1 - k, 3);
        var r = b.r0 + (b.r1 - b.r0) * e;
        ring.scale.set(r, r, 1);
        ring.material.opacity = 0.9 * (1 - k);
        if (k < 1) alive = true;
      });
      if (!alive) {
        b.g.children.forEach(function (ring) { ring.geometry.dispose(); ring.material.dispose(); });
        KB.scene.remove(b.g);
        bursts.splice(i, 1);
      }
    }
  }

  var flashTimer = 0;
  function flash(m, color) {
    if (!m.material) return; // 程序化调用没有圆片
    style(m, color, OPACITY_ARMED);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { if (markers.indexOf(m) >= 0) restyle(m); }, 600);
  }
  // 守卫拒绝:目标闪红,提示原因,并通知(教程卡片显示)
  function reject(m, reason) {
    flash(m, COLOR_BAD);
    var msg = typeof reason === 'string' ? reason : 'Not that one \u2014 try again';
    KB.toast(msg);
    KB.emit('mateRejected', { node: m.node, id: m.f.id, end: m.end, reason: msg });
  }

  function arm(m) {
    armed = m;
    rebuildMarkers();
    KB.toast('Now click a hole or peg on another part');
    KB.emit('mateArmed', info(m));        // 难度二级:选中了源孔,接着把目标孔点亮、镜头给特写
  }

  function disarm() {
    if (!armed) return;
    armed = null;
    rebuildMarkers();
    KB.emit('mateArmed', null);
  }

  /* ---------- 输入 ---------- */
  var downPos = null, pressed = null; // pressed:按下时命中的圆片
  // 捕获阶段,先于 gizmo / 拖拽 / 点选:按在孔位圆片上就吞掉事件,圆片优先于盖在它上面的 gizmo 箭头
  function labelling() { return !!(window.KBLabel && KBLabel.active()); } // 标注工具接管指针时不参与
  canvas.addEventListener('pointerdown', function (e) {
    if (labelling()) return;
    downPos = [e.clientX, e.clientY];
    pressed = null;
    if (e.button !== 0 || KB.gizmo.dragging) return;
    pressed = pick(e.clientX, e.clientY);
    if (pressed) e.stopImmediatePropagation();
  }, true);

  canvas.addEventListener('pointerup', function (e) {
    if (labelling()) return;
    var m = pressed, down = downPos;
    pressed = null;
    downPos = null;
    if (e.button === 2 && down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) <= 5) { disarm(); return; } // 右键:放弃已选的源
    if (e.button !== 0 || !down) return;
    var moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5;
    if (!m) { if (!moved && !KB.gizmo.dragging && !KB.gizmo.axis) disarm(); return; }
    e.stopImmediatePropagation();
    if (moved) return;
    var verdict;
    if (!armed || topOf(m.node) === topOf(armed.node)) {
      if (armed === m) { disarm(); return; }
      if (guard && guard.arm && (verdict = guard.arm(info(m))) !== true) { reject(m, verdict); return; }
      if (!armed) { release(m.node); KB.setSelection([topOf(m.node)]); } // 点到锁着的零件(哪怕点在圆片上)也算解锁
      arm(m);
    } else {
      if (guard && guard.mate && (verdict = guard.mate(info(armed), info(m))) !== true) { reject(m, verdict); return; }
      var src = armed;
      armed = null;
      if (resolver && !(window.KBTutorial && KBTutorial.active())) {
        var r = resolver(info(src), info(m));
        if (r === 'handled') { rebuildMarkers(); return; }
        if (typeof r === 'string') { armed = src; reject(m, r); return; }
      }
      if (!mate(src, m)) armed = src; // 失败:保留源,红色提示留在目标上
      else rebuildMarkers();
    }
  }, true);

  canvas.addEventListener('pointermove', function (e) {
    if (!markers.length || labelling()) return;
    if (downPos) return; // 按住期间(拖拽 / 转视角)不换高亮
    var m = pick(e.clientX, e.clientY);
    if (m === hover) return;
    var prev = hover;
    hover = m;
    if (prev) restyle(prev);
    if (hover) restyle(hover);
    canvas.style.cursor = hover ? 'pointer' : '';
  });

  window.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.code === 'Escape' && armed) { e.stopImmediatePropagation(); disarm(); return; }
    // 装好的零件还锁在孔上,但选择被清掉了(比如挪动一次后自动取消选择):
    // 这时按方向键不该石沉大海 —— 没有别的零件被选中就把它重新拿回来
    if (lastMate && !selection.length && /^Arrow(Up|Down|Left|Right)$/.test(e.code)) KB.setSelection([lastMate.node]);
    if (!lastMate || selection.indexOf(lastMate.node) < 0) return;
    var arrow = e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'ArrowUp' || e.code === 'ArrowDown';
    if (arrow) {
      // 装在孔上时方向键都相对孔轴:←→ 绕轴转,↑↓ 沿轴拔出 / 推入(app.js 的世界 Y 升降不再介入)
      e.preventDefault();
      e.stopImmediatePropagation();
      var q, t;
      if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        var dist = (e.shiftKey ? STEP_SLIDE_FINE_MM : STEP_SLIDE_MM) * unitsPerMm() * (e.code === 'ArrowUp' ? 1 : -1);
        q = new THREE.Quaternion();
        t = lastMate.dir.clone().multiplyScalar(dist);
        lastMate.point.add(t);
      } else {
        var deg = (e.shiftKey ? STEP_BIG_DEG : STEP_DEG) * (e.code === 'ArrowLeft' ? 1 : -1);
        q = new THREE.Quaternion().setFromAxisAngle(lastMate.dir, THREE.MathUtils.degToRad(deg));
        t = lastMate.point.clone().sub(lastMate.point.clone().applyQuaternion(q));
      }
      KB.beginInteraction('key', e.code);
      KB.bakePivot();
      mating = true;
      KB.emit('grab', lastMate.node);
      applyWorld(lastMate.node, q, t);
      KB.emit('place', lastMate.node);
      mating = false;
      KB.pushSnapshot();
      KB.rebuildAttachment();
      KB.syncInspector();
    }
  }, true);

  // 零件被拖动 / gizmo / 点网格移动后,之前的孔轴不再可信
  KB.on('grab', function (node) {
    if (mating || !lastMate) return;
    if (node === lastMate.node || topOf(node) === lastMate.node) lastMate = null;
  });

  KB.onSelection(function (sel) {
    selection = sel.slice();
    if (armed && selection.indexOf(topOf(armed.node)) < 0) armed = null;
    rebuildMarkers();
  });
  KB.onChange(function () {
    // 撤销 / 删除等场景变化:清掉指向已不在场景里的节点
    if (lastMate && !inScene(lastMate.node)) lastMate = null;
    if (armed && !inScene(armed.node)) armed = null;
    rebuildMarkers();
  });

  /* ---------- 装上之后锁在孔上:拖拽 / 点网格不再移动它,只有方向键沿轴、绕轴;再点一下零件才解锁 ---------- */
  function locked(node) { return !!lastMate && (node === lastMate.node || topOf(node) === lastMate.node); }
  function release(node) {
    if (!locked(node)) return false;
    lastMate = null;
    KB.toast('Released from the hole \u2014 free to move');
    return true;
  }
  var lockViz = null;
  function updateLockViz(now) {
    if (!lastMate) {
      if (lockViz) { KB.scene.remove(lockViz); lockViz.geometry.dispose(); lockViz.material.dispose(); lockViz = null; }
      return;
    }
    if (!lockViz) {
      lockViz = new THREE.Mesh(new THREE.RingGeometry(0.78, 1, 48), new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, side: THREE.DoubleSide
      }));
      lockViz.userData.kbOverlay = true;
      lockViz.renderOrder = 999;
      KB.scene.add(lockViz);
    }
    var r = 0.16 + 0.02 * Math.sin(now / 500);
    lockViz.position.copy(lastMate.point);
    lockViz.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), lastMate.dir);
    lockViz.scale.set(r, r, 1);
    lockViz.material.opacity = 0.35 + 0.15 * Math.sin(now / 500);
  }

  window.KBMate = {
    locked: locked,
    release: release,
    /* 教程:聚光要点的孔口 [{node, id, end?}];点击守卫 {arm, mate},返回 true 放行、字符串为拒绝原因 */
    spotlight: function (list) { spot = list || []; rebuildMarkers(); },
    setGuard: function (g) { guard = g || null; },
    /* 难度分级用:关掉点孔配合(一级),以及把点孔结果交给答案位姿去决定(二级) */
    setEnabled: function (on) { enabled = !!on; if (!on) armed = null; rebuildMarkers(); },
    setResolver: function (fn) { resolver = typeof fn === 'function' ? fn : null; },
    setFilter: function (f) { filter = f && f.begin && f.keep ? f : null; rebuildMarkers(); },
    refreshMarkers: function () { rebuildMarkers(); },
    /* 最近装配的轴(仍选中该零件时):app.js 用它把变换枢轴放到孔上 */
    hingeFor: function (node) {
      if (!lastMate || lastMate.node !== node) return null;
      return { point: lastMate.point.clone(), dir: lastMate.dir.clone() };
    },
    armed: function () { return armed ? { node: armed.node, id: armed.f.id, end: armed.end } : null; },
    cancel: disarm,
    /* 程序化装配:把 nodeA 的特征 idA 装到 nodeB 的特征 idB 上 */
    mate: function (nodeA, idA, nodeB, idB, endA, endB) {
      if (!nodeA || !nodeB || !KB.isPart(nodeA) || !KB.isPart(nodeB)) return false;
      var sa = KBParts.spec(nodeA.userData.kbType.slice(5)), sb = KBParts.spec(nodeB.userData.kbType.slice(5));
      if (!sa || !sb) return false;
      function feat(spec, id) {
        var list = id.charAt(0) === 'H' ? spec.holes : spec.pegs;
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
      }
      var fa = feat(sa, idA), fb = feat(sb, idB);
      if (!fa || !fb) return false;
      // endA / endB(可选,±1):用哪个孔口;不给则自动(目标取朝向相机一侧,源取最小旋转)
      return mate({ node: nodeA, f: fa, kind: idA.charAt(0) === 'H' ? 'hole' : 'peg', end: fa.id.charAt(0) === 'H' ? (endA || 0) : 0 },
                  { node: nodeB, f: fb, kind: idB.charAt(0) === 'H' ? 'hole' : 'peg', end: fb.id.charAt(0) === 'H' ? (endB || 0) : 0 });
    }
  };
})();
