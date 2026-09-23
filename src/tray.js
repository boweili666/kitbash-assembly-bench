/* ============================================================
 * 物料区分区 — 同一种零件放在一格里,螺丝按杆长分格
 *
 * 一堆零件铺成一片时,找一颗 M3×8 和找一颗 M3×16 一样难:它们长得几乎一样。
 * 这里把托盘切成若干格,每格一种零件(螺丝按公称长度,所以 M3×16 盘头和杯头
 * 同格),格子按「板件 → 结构件 → 五金 → 螺丝(由短到长)」排,每格画边框和标签。
 *
 * 布局算在场景单位上(1 单位 ≈ 40 mm),只改 x / z,零件自己的朝向和高度不动。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var bounds = { minX: -7.6, maxX: 7.6, minZ: -5.6, maxZ: 4.4 };
  var GAP = 0.32;          // 同一格里零件之间的间隙
  var PAD = 0.22;          // 格子内边距
  var ZONE_GAP = 0.3;      // 格子之间的间隙
  var LABEL_H = 0.42;      // 标签占的高度

  var used = null;   // 这次布局实际占用的范围,取景用
  var group = new THREE.Group();
  group.name = 'Parts tray';
  group.userData.kbOverlay = true;   // 抓帧时和其他辅助图形一样处理
  KB.scene.add(group);

  /* ---------- 分区规则 ---------- */
  function screwLengthMm(spec) {
    var mm = 1000 / KBParts.unitScale(), longest = 0;
    spec.pegs.forEach(function (p) { longest = Math.max(longest, p.depth * mm); });
    return Math.round(longest);
  }
  // 大件在前、细碎在后;同类里螺丝按长度升序
  var RANK = { split_rear_plate: 0, split_front_plate: 0, top_plate: 0, esc_4in1: 1,
    aluminum_x_lock: 2, arm_5in: 2, aluminum_arm_wedge_5mm: 3, camera_plate_left: 3, camera_plate_right: 3,
    motor_2207: 4, propeller_cw: 5, propeller_ccw: 5,
    knurled_standoff: 6, motor_nut_m5: 7, damper_m2: 7 };
  function zoneOf(key) {
    var spec = KBParts.spec(key);
    if (!spec) return { id: key, label: key, order: 99 };
    if (key.indexOf('screw_') === 0) {
      var len = screwLengthMm(spec);
      return { id: 'screw_' + len, label: 'M3 × ' + len + ' mm', order: 20 + len / 100 };
    }
    return { id: key, label: spec.label, order: RANK[key] !== undefined ? RANK[key] : 9 };
  }
  // 零件在桌面上的占地(场景单位):把包围盒按零件自己的朝向转过去再取 x / z 跨度 ——
  // 机臂躺着时长边在 z 上,拿"最长边当宽"会让它们在格子里叠在一起
  var _box = new THREE.Box3(), _m = new THREE.Matrix4(), _e = new THREE.Euler(), _sz = new THREE.Vector3();
  function footprint(key, r) {
    var spec = KBParts.spec(key);
    if (!spec) return { w: 0.5, d: 0.5 };
    _box.min.fromArray(spec.bbox.min);
    _box.max.fromArray(spec.bbox.max);
    _e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0, 'XYZ');
    _m.makeRotationFromEuler(_e);
    _box.clone().applyMatrix4(_m).getSize(_sz);
    return { w: Math.max(_sz.x, 0.2), d: Math.max(_sz.z, 0.2) };
  }

  /* ---------- 画格子 ---------- */
  function clear() {
    group.children.slice().forEach(function (o) {
      o.traverse(function (n) {
        if (n.geometry) n.geometry.dispose();
        if (n.material) { if (n.material.map) n.material.map.dispose(); n.material.dispose(); }
      });
      group.remove(o);
    });
  }
  function drawZone(z) {
    var pts = [[z.x0, z.z0], [z.x1, z.z0], [z.x1, z.z1], [z.x0, z.z1], [z.x0, z.z0]]
      .map(function (p) { return new THREE.Vector3(p[0], 0.012, p[1]); });
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x3f4a59, transparent: true, opacity: 0.9 })));
    var canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 64;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#8d97a5';
    ctx.font = '600 34px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(z.label.toUpperCase(), 6, 34);
    var w = Math.min(z.x1 - z.x0, 2.6);
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 8),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true,
        depthWrite: false, side: THREE.DoubleSide }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(z.x0 + w / 2, 0.014, z.z0 + LABEL_H / 2);
    group.add(mesh);
  }

  /* ---------- 布局:objects 是 app.js 造好的场景对象(含 type / p / r) ---------- */
  function arrange(objects) {
    if (!(window.KBParts && KBParts.ready())) return objects;
    var zones = {}, order = [];
    objects.forEach(function (o) {
      var key = (o.type || '').indexOf('part:') === 0 ? o.type.slice(5) : null;
      if (!key) return;
      var z = zoneOf(key);
      if (!zones[z.id]) { zones[z.id] = { id: z.id, label: z.label, order: z.order, items: [], cell: { w: 0, d: 0 } }; order.push(zones[z.id]); }
      var zone = zones[z.id], f = footprint(key, o.r);
      zone.items.push(o);
      zone.cell.w = Math.max(zone.cell.w, f.w);
      zone.cell.d = Math.max(zone.cell.d, f.d);
    });
    if (!order.length) return objects;
    order.sort(function (a, b) { return a.order - b.order || a.label.localeCompare(b.label); });

    // 每格:按格内单元大小排成若干列,列数取让格子接近方形的值
    var trayW = bounds.maxX - bounds.minX;
    order.forEach(function (z) {
      var cw = z.cell.w + GAP, cd = z.cell.d + GAP;
      var cols = Math.max(1, Math.min(z.items.length, Math.round(Math.sqrt(z.items.length * cd / cw))));
      cols = Math.min(cols, Math.max(1, Math.floor((trayW - 2 * PAD) / cw)));
      z.cols = cols;
      z.rows = Math.ceil(z.items.length / cols);
      z.w = cols * cw + 2 * PAD;
      z.d = z.rows * cd + 2 * PAD + LABEL_H;
      z.cw = cw; z.cd = cd;
    });

    // 从托盘靠近装配区的那条边(maxZ)起排,一行排满换行、往后(-z)长 ——
    // 装配区就在托盘前面,托盘只能向后要地方
    var x = bounds.minX, zTop = bounds.maxZ, rowDepth = 0, usedX = bounds.minX;
    order.forEach(function (z) {
      if (x + z.w > bounds.maxX + 1e-6 && x > bounds.minX) { x = bounds.minX; zTop -= rowDepth + ZONE_GAP; rowDepth = 0; }
      z.x0 = x; z.z1 = zTop; z.x1 = x + z.w; z.z0 = zTop - z.d;
      x += z.w + ZONE_GAP;
      usedX = Math.max(usedX, z.x1);
      rowDepth = Math.max(rowDepth, z.d);
    });
    used = { minX: bounds.minX, maxX: usedX, minZ: zTop - rowDepth, maxZ: bounds.maxZ };

    clear();
    order.forEach(function (z) {
      drawZone(z);
      z.items.forEach(function (o, i) {
        var col = i % z.cols, row = Math.floor(i / z.cols);
        o.p = [z.x0 + PAD + z.cw * (col + 0.5),
               o.p ? o.p[1] : 0,
               z.z0 + PAD + LABEL_H + z.cd * (row + 0.5)];
      });
    });
    return objects;
  }

  window.KBTray = { arrange: arrange, bounds: bounds, clear: clear,
    extent: function () { return used || bounds; },
    zones: function () { return group.children.length; } };
})();
