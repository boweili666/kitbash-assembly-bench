/* ============================================================
 * 当前这一步:把要动的零件点亮,并在右上角推荐一个特写视角
 *
 *   高亮  当前步骤里还没到位的零件。空着的位置就在场上找一个同型号、
 *         还没被用上的零件(名字对得上的优先)。黄色呼吸 + 头顶箭头,
 *         和报错的红、虚影的蓝、Next 候选的琥珀都分得开。
 *   视角  零件还在料盘里 -> 给零件本身特写,帮人找到它;
 *         零件都进了装配区 -> 给安装位置特写,并且从侧面看插入方向。
 *         右上角先给一张缩略图,用户点 "Use this view" 镜头才过去 —— 不抢镜头。
 *         同一步、同一种情况只问一次。
 *
 * 教程进行中不工作(教程有自己的高亮和镜头)。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var COLOR = new THREE.Color(0xffc81e);   // 亮黄:跟粉色的孔、青色的引导点、白色的螺丝都拉得开
  var TINT = new THREE.Color(0xe09a00);    // 零件本体染深一点,打了光还是黄的,不会被照成白色
  var lit = [];                 // 正在发光的零件
  var asked = {};               // 已经问过的 (步骤|情况) —— 采用或忽略后就不再弹
  var shown = null;             // 卡片上正挂着的那个建议 {key, view}
  var timer = 0;

  function tutorialOn() { return !!(window.KBTutorial && KBTutorial.active()); }
  function keyOf(node) { return node.userData.kbType ? node.userData.kbType.slice(5) : ''; }
  function inWorkspace(node) { return !window.KBWorkspace || KBWorkspace.contains(node); }

  /* ---------- 这一步要动哪些零件 ---------- */
  function partsToMove(step) {
    // 黄箭头指的和虚影演示的是同一件事 —— "这一步该挪哪几件" —— 所以只有一份
    // 答案, 在 answer.js。原先这里另算一遍, 而且算完还按零件种类截断: 一步里
    // 有楔块和螺丝时只指楔块, 要等楔块判定到位才轮到螺丝。手动拖进来的件判不了
    // 到位, 于是箭头停住, 而虚影(没有那道截断)一直是对的。两套判据合成一套。
    if (window.KBAnswer && KBAnswer.movesFor) {
      var m = KBAnswer.movesFor(step);
      if (m && m.length) return m;
    }
    // answer.js 还没就绪时的老路: 它自己挑, 不做种类截断。
    var out = [], used = {};
    var all = [];
    KB.objectsRoot.traverse(function (o) { if (KB.isPart(o)) all.push(o); });
    var placed = {};
    all.forEach(function (n) {
      var r = step.assembly ? KBCheck.levelPlacedSlot(n) : KBCheck.placedSlotAny(n);
      if (r) placed[r.id] = n;
    });
    var slots = step.slots.slice();
    if (step.base && !step.base.ok && slots.indexOf(step.base) < 0) slots.unshift(step.base);
    slots.sort(function (a, b) { return Number(KBCheck.comesFirst(b.ref)) - Number(KBCheck.comesFirst(a.ref)); });
    slots.forEach(function (t) {
      if (t.ok || placed[t.ref.id]) return;
      if (t.part) { out.push(t.part.node); used[t.part.node.uuid] = true; return; }
      var want = t.ref.ckey, best = null;
      all.forEach(function (n) {
        if (used[n.uuid] || KBCheck.canon(keyOf(n)) !== want || KBCheck.placedSlotAny(n)) return;
        var sl = KBCheck.slotOf(n);
        if (sl && sl.ok) return;
        var score = (n.name === t.ref.name ? 0 : 1) + (sl ? 2 : 0);
        if (!best || score < best.score) best = { node: n, score: score };
      });
      if (best) { out.push(best.node); used[best.node.uuid] = true; }
    });
    return out;
  }

  /* ---------- 高亮:整件染成黄色呼吸 + 头顶一个跳动的箭头 ----------
     只加自发光的话,白色的螺丝亮了还是白的,一排一样的螺丝里根本找不出来 */
  var arrows = new Map();       // node -> 箭头(g.userData.kbTone 记它当前是什么色)
  var arrowGeo = null, arrowMats = {};
  function arrowMaterial(hex) {
    if (!arrowMats[hex]) arrowMats[hex] = new THREE.MeshBasicMaterial({
      color: hex, transparent: true, opacity: 0.95,
      depthTest: false, depthWrite: false, toneMapped: false, fog: false });
    return arrowMats[hex];
  }
  // 箭头本身不挑颜色: 黄的说"在这儿", 红的说"你弄错的是这件", 绿的说"该装这件"。
  // 三种标记长得一样、只有颜色不同, 学员就只需要记一套含义。材质按色缓存,
  // 一个颜色一份, 不会每件零件造一个。
  function makeArrow(hex) {
    if (!arrowGeo) {
      var cone = new THREE.ConeGeometry(0.5, 1, 20); cone.rotateX(Math.PI); cone.translate(0, 0.5, 0);   // 尖朝下,尖在原点
      var stem = new THREE.CylinderGeometry(0.18, 0.18, 0.9, 12); stem.translate(0, 1.45, 0);
      arrowGeo = [cone, stem];
    }
    var mat = arrowMaterial(hex);
    var g = new THREE.Group();
    arrowGeo.forEach(function (geo) { var m = new THREE.Mesh(geo, mat); m.renderOrder = 999; g.add(m); });
    g.userData.kbOverlay = true;   // 抓帧时隐藏
    g.userData.kbTone = hex;
    KB.scene.add(g);
    return g;
  }
  // 这一件现在该用什么颜色的箭头: AI 标了就跟 AI 的色, 否则是台子自己的亮黄。
  function arrowTone(n) {
    var t = window.KBMarks && KBMarks.toneOf && KBMarks.toneOf(n);
    return (typeof t === 'number') ? t : COLOR.getHex();
  }
  function wantArrow(n) {
    var a = arrows.get(n), hex = arrowTone(n);
    if (a && a.userData.kbTone === hex) return a;
    if (a) KB.scene.remove(a);
    a = makeArrow(hex);
    arrows.set(n, a);
    return a;
  }
  function restore(n) {
    KB.highlight(n, null);
    n.traverse(function (o) {
      if (o.isMesh && o.material && o.material.userData.kbBase) { o.material.color.copy(o.material.userData.kbBase); delete o.material.userData.kbBase; }
    });
    var a = arrows.get(n);
    if (a) { KB.scene.remove(a); arrows.delete(n); }
  }
  // 一件东西上只能有一种说法。AI 标了红(你弄错了)或绿(该这么做)的那一件,
  // 本模块不再往上加自己的箭头 —— 红本体配黄箭头读起来是第四种标记,
  // 而设计里只有三种: 黄箭头说"在这儿", 红说"错了", 绿说"该这样"。
  function aiOwns(n) {
    return !!(window.KBMarks && KBMarks.aiOwns && KBMarks.aiOwns(n));
  }
  // 台子自己那套"下一件拿这个"的黄箭头要不要画。AI 标记的箭头不走这里,
  // 它由 marks.js 逐条决定(每种颜色都能带或不带), 见 KBFocus.markArrow。
  var OWN_ARROW = true;
  // marks.js 点名要箭头的件: node -> 颜色。和 lit 分开, 因为一件被 AI 标红的
  // 零件通常根本不在台子的 lit 里, 而它照样要有箭头。
  var markArrows = new Map();
  // 这一批标注里明说了"不要箭头"的件。和 markArrows 是一对: 三种颜色各有
  // 带箭头和不带箭头两种形态, 所以"没点名"和"点名说不要"必须分得开 ——
  // 黄色那一路本来就会自带箭头, 只有显式说不要才能把它按下去。
  var noArrow = new Set();
  function setLit(nodes) {
    // 台子自己在指的档位(一级 / 二级)走原逻辑, 一行不改。AI 的标注、箭头取舍、
    // 逐件顺延这些统统是三级才有的事 —— 三级把自动指点关了, 才需要有人补位。
    // 一级二级的自动高亮和孔引导跟这些毫无关系, 不该被它们碰。
    if (pointsNow()) {
      lit.forEach(function (n) { if (nodes.indexOf(n) < 0) restore(n); });
      lit = nodes.slice();
      lit.forEach(function (n) { if (!arrows.has(n)) arrows.set(n, makeArrow(COLOR.getHex())); });
      return;
    }
    lit.forEach(function (n) { if (nodes.indexOf(n) < 0 && !markArrows.has(n)) restore(n); });
    lit = nodes.slice();
    lit.forEach(function (n) {
      if (noArrow.has(n) || !OWN_ARROW || aiOwns(n)) {
        var a = arrows.get(n);
        if (a && !markArrows.has(n)) { KB.scene.remove(a); arrows.delete(n); }
        return;
      }
      wantArrow(n);
    });
  }
  // 箭头太显眼,人会直接点它:点到箭头(或它附近)就算点了它指着的零件
  if (KB.addPickProxy) KB.addPickProxy(function (ray) {
    var best = null, bestD = Infinity, sph = new THREE.Sphere();
    arrows.forEach(function (a, node) {
      if (!a.visible || !node.parent) return;
      a.updateMatrixWorld(true);
      var hits = ray.intersectObjects(a.children, false);
      if (hits.length && hits[0].distance < bestD) { bestD = hits[0].distance; best = node; return; }
      // 箭头细:外面包一圈球,点在旁边也算
      new THREE.Box3().setFromObject(a).getBoundingSphere(sph);
      sph.radius *= 1.3;
      if (ray.ray.intersectsSphere(sph)) {
        var d = ray.ray.origin.distanceTo(sph.center);
        if (d < bestD) { bestD = d; best = node; }
      }
    });
    return best;
  });
  var _hb = new THREE.Box3(), _hc = new THREE.Vector3();
  (function pulse() {
    requestAnimationFrame(pulse);
    if (!lit.length && !arrows.size) return;
    var now = performance.now(), w = 0.5 + 0.5 * Math.sin(now / 260);
    var k = 0.25 + 0.45 * w;
    lit.forEach(function (n) {
      // patch 15:AI 标的红 / 绿盖在所有东西之上。这里每帧重写 emissive,
      // 不躲开的话 AI 标的那一件会被琥珀色刷掉 —— 箭头本身照旧画
      var aiMarked = window.KBMarks && KBMarks.aiOwns && KBMarks.aiOwns(n);
      if (!aiMarked) n.traverse(function (o) {
        if (!o.isMesh || !o.material || !o.material.emissive || o.userData.kbOverlay) return;
        var m = o.material;
        if (!m.userData.kbBase) m.userData.kbBase = m.color.clone();
        m.color.copy(m.userData.kbBase).lerp(TINT, 0.8 + 0.2 * w);
        m.emissive.copy(COLOR);
        m.emissiveIntensity = k;
      });

      // 本体染色归 lit 管; 箭头在下面统一按 arrows 走, 因为 AI 标的件
      // 常常不在 lit 里, 却照样要有一个自己颜色的箭头。
      if (aiMarked && !pointsNow()) { var a0 = arrows.get(n); if (a0 && !markArrows.has(n)) { KB.scene.remove(a0); arrows.delete(n); } }
    });

    // 所有箭头一起动: 台子自己的黄箭头, 和 AI 逐条点名的红 / 绿 / 黄箭头,
    // 只有颜色不同, 动作完全一样 —— 学员只需要记一套含义。
    arrows.forEach(function (a, n) {
      if (!n.parent) { a.visible = false; return; }
      var hex = arrowTone(n);
      if (a.userData.kbTone !== hex) { KB.scene.remove(a); a = makeArrow(hex); arrows.set(n, a); }
      _hb.setFromObject(n); _hb.getCenter(_hc);
      var size = Math.max(0.06, KB.camera.position.distanceTo(_hc) * 0.028);
      a.scale.setScalar(size);
      a.position.set(_hc.x, _hb.max.y + size * (0.35 + 0.45 * (0.5 + 0.5 * Math.sin(now / 180))), _hc.z);
      a.visible = true;
    });
  })();

  /* ---------- 推荐视角 ---------- */
  var _b = new THREE.Box3(), _v = new THREE.Vector3();
  function boxOfNodes(nodes) {
    var box = new THREE.Box3();
    nodes.forEach(function (n) { box.union(_b.setFromObject(n)); });
    return box;
  }
  function boxAt(key, want) {
    var spec = KBParts.spec(key);
    if (!spec || !spec.bbox) return new THREE.Box3().setFromCenterAndSize(_v.setFromMatrixPosition(want), new THREE.Vector3(0.3, 0.3, 0.3));
    return new THREE.Box3(new THREE.Vector3().fromArray(spec.bbox.min), new THREE.Vector3().fromArray(spec.bbox.max)).applyMatrix4(want);
  }
  function framing(box, dir) {
    var c = box.getCenter(new THREE.Vector3());
    var sz = box.getSize(new THREE.Vector3());
    var r = Math.max(Math.max(sz.x, sz.y, sz.z) * 0.62, sz.length() * 0.4, 0.7);
    var fov = THREE.MathUtils.degToRad(KB.camera.fov || 45);
    var dist = r / Math.tan(fov / 2) * 2.0;        // 留出周围零件,别贴太近
    var p = c.clone().addScaledVector(dir.normalize(), dist);
    if (p.y < 0.08) p.y = 0.08;                   // 可以从下往上看,但别钻到地面以下
    return { p: p.toArray(), t: c.toArray() };
  }
  function suggest(step, nodes) {
    var outside = nodes.filter(function (n) { return !inWorkspace(n); });
    if (outside.length) {
      // 情况 A:要拿的零件还在料盘里 —— 只给下一个要拿的那个特写。
      // 一起框的话,两个零件在料盘里往往隔着好几格,拍出来就成了整盘零件
      var first = outside[0];
      return { phase: 'find', caption: 'Close-up: ' + first.name, node: first,
               view: framing(boxOfNodes([first]), new THREE.Vector3(0.35, 1.0, 0.75)) };
    }
    // 情况 B:零件都在装配区了 —— 给它们要去的位置一个特写,侧着看插入方向
    var box = new THREE.Box3(), axis = null, lead = null;
    nodes.forEach(function (n) {
      var r = KBCheck.levelTarget(n);
      if (r && r.want) {
        box.union(boxAt(keyOf(n), r.want));
        if (!lead) { lead = boxAt(keyOf(n), r.want).getCenter(new THREE.Vector3()); axis = axisOf(r.want, r.approach); }
      } else {
        box.union(_b.setFromObject(n));
      }
    });
    if (box.isEmpty()) return null;
    var at = lead || box.getCenter(new THREE.Vector3());
    var dir = bestDir(box, at, axis, nodes[0]);
    if (lastBest && lastBest.wide) box.expandByScalar(0.9);
    return { phase: 'fit', caption: 'Close-up: where ' + nodes.map(function (n) { return n.name; }).join(', ') + ' goes',
             view: framing(box, dir) };
  }
  /* 按零件在整机里的位置选看它的方向:
     - 它在整机哪一侧(左前、右后……),镜头就站在那一侧从外往里看,不被机架挡住;
     - 偏下的零件从下往上看(这台是倒着装的,电机、桨、立柱、顶板都在下面),其余从上往下;
     - 整机正中间的零件(X-Lock、中间的螺丝)站在它进来的那一侧看;
     - 最后把沿插入方向的分量削掉一大半,插进去多深看得出来。 */
  var assembly = null;
  function assemblyShape() {
    if (assembly) return assembly;
    var box = new THREE.Box3(), p = new THREE.Vector3();
    (KBCheck.ref().slots || []).forEach(function (sl) { box.expandByPoint(p.setFromMatrixPosition(sl.M)); });
    var size = box.getSize(new THREE.Vector3());
    assembly = { center: box.getCenter(new THREE.Vector3()),
                 halfW: Math.max(size.x, size.z) / 2 || 1, halfH: size.y / 2 || 0.3 };
    return assembly;
  }
  function locationDir(partWorld, axis) {
    var shape = assemblyShape();
    var W = KBCheck.refToWorld();
    var C = shape.center.clone().applyMatrix4(W);                 // 整机中心在世界里的位置
    var o = partWorld.clone().sub(C);
    var h = new THREE.Vector3(o.x, 0, o.z);
    var dir;
    if (h.length() > shape.halfW * 0.22) {
      dir = h.normalize();                                         // 站到它那一侧
    } else if (axis && Math.abs(axis.y) < 0.9) {
      dir = axis.clone().negate().setY(0).normalize();             // 正中间:站在它进来的那一侧
    } else {
      // 正中间、又是竖着插的:从机头左前方看
      var front = new THREE.Vector3(0, 0, -1).transformDirection(W).setY(0).normalize();
      var right = new THREE.Vector3().crossVectors(front, new THREE.Vector3(0, 1, 0)).normalize();
      dir = front.multiplyScalar(0.8).addScaledVector(right, -0.6).normalize();
    }
    var below = o.y < -shape.halfH * 0.25;
    dir.y = below ? -0.55 : 0.85;
    dir.normalize();
    if (axis) {
      dir.addScaledVector(axis, -0.6 * dir.dot(axis));
      if (dir.lengthSq() < 1e-4) dir.set(0.5, below ? -0.5 : 0.8, 0.6);
      dir.normalize();
    }
    return dir;
  }
  /* 看得见才算好视角:围着零件取 26 个方向,每个方向从镜头往零件上的几个点打射线,
     数有几条被别的零件挡住。遮挡按每个零件自己朝向的包围盒算(不去碰电机那种十几万面的网格)。
     挡得少的优先;然后才是站在它所在那一侧、不顺着插入方向看、尽量从上往下。 */
  var CANDIDATES = (function () {
    var out = [];
    [-0.45, 0.2, 0.75].forEach(function (y) {
      for (var k = 0; k < 8; k++) {
        var a = k / 8 * Math.PI * 2, c = Math.sqrt(1 - y * y);
        out.push(new THREE.Vector3(Math.cos(a) * c, y, Math.sin(a) * c));
      }
    });
    out.push(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.3, 0.95, 0).normalize());
    return out;
  })();
  function occluders(except) {
    var list = [];
    KB.objectsRoot.traverse(function (o) {
      if (!KB.isPart(o) || o === except || !inWorkspace(o)) return;
      var spec = KBParts.spec(keyOf(o));
      if (!spec || !spec.bbox) return;
      o.updateMatrixWorld(true);
      list.push({ inv: new THREE.Matrix4().copy(o.matrixWorld).invert(),
                  box: new THREE.Box3(new THREE.Vector3().fromArray(spec.bbox.min), new THREE.Vector3().fromArray(spec.bbox.max)) });
    });
    return list;
  }
  var _ray = new THREE.Ray(), _hit = new THREE.Vector3();
  function blocked(from, to, occ) {
    var len = from.distanceTo(to);
    for (var i = 0; i < occ.length; i++) {
      _ray.origin.copy(from).applyMatrix4(occ[i].inv);
      var end = to.clone().applyMatrix4(occ[i].inv);
      _ray.direction.copy(end).sub(_ray.origin);
      var l = _ray.direction.length();
      if (l < 1e-9) continue;
      _ray.direction.divideScalar(l);
      if (_ray.intersectBox(occ[i].box, _hit) && _ray.origin.distanceTo(_hit) < l - 0.02) return true;
    }
    return false;
  }
  function bestDir(box, partWorld, axis, except) {
    var occ = occluders(except);
    var c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    var pts = [c];
    [[1, 1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, 1]].forEach(function (k) {
      pts.push(c.clone().add(new THREE.Vector3(k[0] * size.x, k[1] * size.y, k[2] * size.z).multiplyScalar(0.3)));
    });
    var prefer = locationDir(partWorld, null);          // 按位置:它在整机哪一侧
    var best = null;
    CANDIDATES.forEach(function (d0) {
      var v = framing(box, d0.clone());
      var cam = new THREE.Vector3().fromArray(v.p);
      if (cam.y < 0.1) return;                            // 钻到地面下了
      var seen = 0;
      pts.forEach(function (pt) { if (!blocked(cam, pt, occ)) seen++; });
      var d = cam.clone().sub(c).normalize();
      var score = seen / pts.length * 3
        + d.dot(prefer)
        - (axis ? Math.abs(d.dot(axis)) * 0.7 : 0)
        + (d.y > 0.3 ? 0.25 : 0);
      if (!best || score > best.score) best = { score: score, dir: d, seen: seen };
    });
    if (best && best.seen === 0) { best.dir.addScaledVector(prefer, 1.2).normalize(); best.wide = true; }
    lastBest = best;
    return best ? best.dir : prefer;
  }
  var lastBest = null;
  function axisOf(want, approach) {
    if (!approach) return null;
    var a = new THREE.Vector3().setFromMatrixPosition(want).sub(new THREE.Vector3().setFromMatrixPosition(approach));
    return a.lengthSq() > 1e-8 ? a.normalize() : null;
  }

  /* ---------- 镜头跟随:采用过推荐视角后,点的零件飞到哪,镜头跟到哪 ---------- */
  var follow = false;
  function followTo(key, want, approach, except) {
    var box = boxAt(key, want);
    var at = box.getCenter(new THREE.Vector3());
    box.expandByScalar(0.12);                         // 带上一点周围,看得出装在谁身上
    var dir = bestDir(box, at, axisOf(want, approach), except);
    if (lastBest && lastBest.wide) box.expandByScalar(0.9);
    var v = framing(box, dir);
    KB.flyCamera(v.p, v.t);
  }
  // 零件一起飞就把卡片收起来:它说的是"去哪找这个零件",零件已经在路上了
  KB.on('levelFlight', function () { if (shown && !tutorialOn()) hideCard(); soon(); });
  KB.on('levelFlight', function (f) {
    // 一二级零件飞到哪镜头就跟到哪(没有卡片可以"采用",就不等人点了)
    // patch 09:f.force 是二级"没有孔可点、直接到位"的那一下(levels.js placeByClick(node, true))。
    // 二级默认不飞镜头,所以它也归 autoView() 管 —— KBFocus.autoUpTo(2) 一句就恢复原行为
    if (!f || !f.node || tutorialOn() || !(follow || (f.force && autoView()) || autoView())) return;
    followTo(keyOf(f.node), f.want, f.approach, f.node);
  });
  // 三级(自己点孔配合):零件落位时镜头跟过去
  KB.on('snapAttempt', function (a) {
    if (!follow || tutorialOn() || !a || !a.success || !a.object1 || a.reason === 'level') return;
    var n = a.object1;
    n.updateMatrixWorld(true);
    followTo(keyOf(n), n.matrixWorld.clone(), null, n);
  });

  /* 用这个视角实际渲一帧当缩略图:同一个任务里渲完就截、再按原镜头渲回去,画面不会闪 */
  var thumb = null;
  function snapshot(view) {
    var R = KB.renderer;
    if (!R) return '';
    var src = R.domElement, pr = R.getPixelRatio();
    // 只在画布左下角一小块(360 物理像素宽)渲这一帧,只读回这一小块:
    // 整张画布读回来再编码,高分屏上要上百毫秒,正好卡在点零件的那一下。随后按原镜头重画,画面不闪
    var W = Math.min(360, src.width), H = Math.round(W * src.height / src.width);
    var cam = KB.camera.clone();
    cam.aspect = W / H; cam.updateProjectionMatrix();
    cam.position.fromArray(view.p);
    cam.lookAt(new THREE.Vector3().fromArray(view.t));
    cam.updateMatrixWorld(true);
    var full = R.getViewport(new THREE.Vector4());
    var url = '';
    try {
      R.setScissorTest(true);
      R.setViewport(0, 0, W / pr, H / pr);
      R.setScissor(0, 0, W / pr, H / pr);
      R.render(KB.scene, cam);
      var gl = R.getContext(), px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      if (!thumb) thumb = document.createElement('canvas');
      thumb.width = W; thumb.height = H;
      var ctx = thumb.getContext('2d'), img = ctx.createImageData(W, H), row = W * 4;
      for (var y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);   // WebGL 是自下而上
      ctx.putImageData(img, 0, 0);
      url = thumb.toDataURL('image/jpeg', 0.82);
    } catch (e) { url = ''; }
    R.setScissorTest(false);
    R.setViewport(full);
    R.render(KB.scene, KB.camera);
    return url;
  }

  /* ---------- 右上角卡片 ---------- */
  var card = document.createElement('aside');
  card.id = 'viewTip';
  card.className = 'float';
  card.hidden = true;
  card.setAttribute('aria-label', 'Suggested view');
  card.innerHTML =
    '<div class="vt-head"><span class="vt-kicker">SUGGESTED VIEW</span>' +
    '<button class="vt-x" aria-label="Dismiss suggested view">×</button></div>' +
    '<img class="vt-img" alt="Preview of the suggested camera view">' +
    '<div class="vt-cap"></div>' +
    '<div class="vt-btns"><button class="vt-use">Use this view</button><button class="vt-no">Not now</button></div>';
  document.body.appendChild(card);
  function hideCard() { card.hidden = true; shown = null; }
  function answer(use) {
    if (!shown) return;
    asked[shown.key] = use ? 'used' : 'dismissed';
    // 采用过一次 -> 之后点零件镜头都跟着飞。"Not now" 只是这张卡片不要,不关跟随:
    // 每装一个零件都会弹新卡片,顺手关掉一张就再也不跟,人会以为镜头坏了
    if (use && STICKY_FOLLOW) follow = true;
    if (use) { KB.flyCamera(shown.view.p, shown.view.t); KB.emit('suggestView', shown.view); }
    KB.emit('viewTip', { key: shown.key, used: !!use });
    hideCard();
  }
  card.querySelector('.vt-use').addEventListener('click', function () { answer(true); });
  card.querySelector('.vt-no').addEventListener('click', function () { answer(false); });
  card.querySelector('.vt-x').addEventListener('click', function () { answer(false); });

  /* ---------- 刷新 ---------- */
  // 教程演示:教程里要让人亲眼看到"黄色高亮 + 箭头"和"推荐视角卡片"长什么样
  var demo = null;              // { nodes:[node], card:{ node, caption } }
  function showDemoCard(c) {
    var key = 'tutorial|' + c.node.uuid;
    if (shown && shown.key === key) return;
    var box = boxOfNodes([c.node]).expandByScalar(0.25);
    var view = framing(box, new THREE.Vector3(0.35, 1.0, 0.75));
    shown = { key: key, view: view };
    card.querySelector('.vt-img').src = snapshot(view);
    card.querySelector('.vt-cap').textContent = c.caption;
    card.hidden = false;
  }
  function refresh() {
    timer = 0;
    if (tutorialOn()) {
      setLit(demo && demo.nodes ? demo.nodes.filter(Boolean) : []);
      if (demo && demo.fly && !demo.flown && demo.fly.parent) {
        demo.flown = true;
        var fb = boxOfNodes([demo.fly]).expandByScalar(0.25), fv = framing(fb, new THREE.Vector3(0.35, 1.0, 0.75));
        KB.flyCamera(fv.p, fv.t);
      }
      if (demo && demo.card && demo.card.node) showDemoCard(demo.card); else hideCard();
      return;
    }
    if (!window.KBCheck || !(window.KBParts && KBParts.ready())) {
      setLit([]); hideCard(); return;
    }
    // 零件还在飞(自动到位 / 装配吸附):这时弹"推荐视角"只会让人摸不着头脑,落定了再说
    if ((KB.tweening && KB.tweening()) || (window.KBLevel && KBLevel.busy && KBLevel.busy())) {
      if (shown) hideCard();
      soon();
      return;
    }
    KBCheck.evaluate();
    var st = KBCheck.next();
    if (!st) { setLit([]); hideCard(); return; }
    var nodes = partsToMove(st);
    // patch 11 §4:一级 / 二级照旧自动指出下一件(黄箭头 + 黄色零件)。三级可以关掉,
    // 改由 AI 用绿色标记指出。KBFocus.pointAtL3(true) 一句恢复。箭头本身的逻辑一行没改
    // 三级关着的时候还留一条路:宿主临时点名的那一件照样指(KBFocus.pointAt)。
    // 换步了 / 那件被拿走了就作废 —— 它只是"这一下指给你看",不是一个新的常开状态
    // 被指的那件装上以后, 顺延到这一步还缺的下一件, 而不是一指完就没了。
    // 三级默认不自动指, 所以一旦 pointed 清空就再也没有箭头, 学员在同一步里
    // 装完第一件后完全失去指示 —— 换步才恢复。一步常常有好几件(楔块, 然后
    // 它的螺丝), 所以"指完就收"实际上等于只指每一步的第一件。
    if (pointed && !pointed.parent) pointed = null;
    if (pointed && nodes.indexOf(pointed) < 0) {
      pointed = pointsNow() ? null : (nodes.length ? nodes[0] : null);
    }
    setLit(pointsNow() ? nodes : (pointed ? [pointed] : []));
    if (!nodes.length) { hideCard(); return; }
    var s = suggest(st, nodes);
    // 一级零件自己飞过去、镜头也跟着,不给装配位置的特写 —— 但要点的零件已经在装配区里时
    // (比如暂放在 X-Lock 两边的楔块组件),还是给它本身一个特写(连同它所在的整组),不然镜头不动
    if (s && s.phase !== 'find' && window.KBLevel && KBLevel.get() === 1) {
      var top = nodes[0]; while (top.parent && top.parent !== KB.objectsRoot) top = top.parent;
      s = { phase: 'find', caption: 'Close-up: ' + nodes[0].name, node: nodes[0],
            view: framing(boxOfNodes([top]).expandByScalar(0.2), new THREE.Vector3(0.35, 1.0, 0.75)) };
    }
    if (!s) { hideCard(); return; }
    // 同一步里放好了一个、还剩别的,换成剩下那个的特写 —— 所以把零件也算进键里
    var key = st.i + '|' + s.phase + '|' + (s.node ? s.node.uuid : nodes.map(function (n) { return n.uuid; }).sort().join(','));
    if (asked[key]) { if (shown && shown.key !== key) hideCard(); return; }
    // 一二级不问:直接把镜头转过去。先停一下,让人看清刚装上去的结果;这期间场面变了就作罢
    if (autoView()) {
      if (shown) hideCard();
      if (pendingKey === key) return;
      pendingKey = key;
      clearTimeout(autoTimer);
      autoTimer = setTimeout(function () {
        if (pendingKey !== key || tutorialOn() || KB.interacting() || (KB.tweening && KB.tweening()) || (window.KBLevel && KBLevel.busy())) { pendingKey = null; soon(); return; }
        asked[key] = 'auto';
        pendingKey = null;
        KB.flyCamera(s.view.p, s.view.t);
        KB.emit('suggestView', s.view);
        KB.emit('viewTip', { key: key, auto: true, view: s.view });
      }, 700);
      return;
    }
    if (!CARDS) { if (shown) hideCard(); return; }    // patch 09:卡片默认关,View / V 照样能飞
    if (shown && shown.key === key) return;          // 已经挂着同一个建议
    shown = { key: key, view: s.view };
    card.querySelector('.vt-img').src = snapshot(s.view);
    card.querySelector('.vt-cap').textContent = 'Step ' + (st.i + 1) + ' · ' + s.caption;
    card.hidden = false;
    KB.emit('viewTip', { key: key, shown: true, view: s.view });
  }
  function soon() { clearTimeout(timer); timer = setTimeout(refresh, 450); }
  var autoTimer = 0, pendingKey = null;
  /* ---------- 视角改成"拉"而不是"推"(patch 09)----------
   * 一行代码都没删,只把三个默认值翻过来,三句话能恢复 bowei 的原行为:
   *   KBFocus.autoUpTo(2)        Level 2 也自动飞镜头
   *   KBFocus.cards(true)        恢复右上角推荐视角卡片
   *   KBFocus.stickyFollow(true) 采用过一次之后永久跟随
   */
  var AUTO_MAX = 1;            // 自动飞镜头的最高难度档(原本是 2)
  var CARDS = false;           // 右上角推荐卡片(原本恒开)
  var STICKY_FOLLOW = false;   // 点一次 "Use this view" 之后整局跟随(原本 true)
  function autoView() { return window.KBLevel && KBLevel.get() <= AUTO_MAX; }
  // patch 15:三级默认**不**自动指 —— 一二级照旧自动指,三级交给 AI 用绿色标注,
  // 学员问了才指。KBFocus.pointAtL3(true) 恢复自动指
  // 三级也自动指下一件, 和一级二级一样。原先默认关着, 改由 AI 在被问到时
  // 临时点一下 —— 那条路每一段都可能断(前端丢字段、路由不存在、台子拒绝),
  // 断了就什么都没有。台子自己一直知道下一件是哪个, 让它一直指着最省事,
  // 也最不会错。KBFocus.pointAtL3(false) 一句关掉。
  var POINT_AT_L3 = true;
  function pointsNow() { return POINT_AT_L3 || !(window.KBLevel && KBLevel.get() >= 3); }
  /* ---------- "这一下指给你看" ----------
   * 三级默认不指, 但学员问了("下一个拿哪件" / "它在哪儿")时 AI 要指得出来。用的是
   * bowei 这套现成的黄箭头 + 黄色本体(setLit), 不另画一套 —— setLit 的逻辑一行没改,
   * 只是在三级把 lit 从"空"换成"就这一件"。到下一步或者学员把它放下就自己没了。
   */
  var pointed = null;
  function pointAt(node) {
    if (!node) { pointed = null; refresh(); return false; }
    pointed = node;
    refresh();
    return pointed === node;          // refresh() 把不属于这一步的那些清掉了
  }
  KB.on('place', function (node) {
    if (!pointed) return;
    var hit = node === pointed;
    node.traverse(function (o) { if (o === pointed) hit = true; });
    // 三级: 不清空, 交给 refresh 去挑这一步还缺的下一件 —— 清空等于"每步只指
    // 第一件", 而三级没有别的东西会补上。一级二级本来就每帧自动指, pointed
    // 只是个临时点名, 照旧清掉。
    if (hit) { if (pointsNow()) pointed = null; soon(); }
  });
  KB.onChange(soon);
  KB.onSelection(soon);
  KB.on('levelChange', soon);
  KB.on('tutorialEnd', soon);
  (function first() { if (window.KBCheck && window.KBParts && KBParts.ready()) soon(); else setTimeout(first, 200); })();

  /* 调试 / 验收用:某个参考槽位装好后,推荐从哪看 */
  function viewForSlot(sl) {
    var W = KBCheck.refToWorld();
    var want = new THREE.Matrix4().multiplyMatrices(W, sl.M);
    var a = KBParts.answer(), d = a && a.parts.filter(function (x) { return x.id === sl.id; })[0], approach = null;
    if (d && d.path && d.path.length > 1) {
      var tr = KBParts.nodeTransform(d.key, d.path[0]);
      approach = new THREE.Matrix4().multiplyMatrices(W, new THREE.Matrix4().compose(new THREE.Vector3().fromArray(tr.p),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(tr.r[0], tr.r[1], tr.r[2], 'XYZ')), new THREE.Vector3(1, 1, 1)));
    }
    var box = boxAt(sl.key, want), at = box.getCenter(new THREE.Vector3());
    box.expandByScalar(0.12);
    var self = null;
    KB.objectsRoot.traverse(function (o) { if (!self && KB.isPart(o) && o.name === sl.name) self = o; });
    var dir = bestDir(box, at, axisOf(want, approach), self);
    var wide = !!(lastBest && lastBest.wide);
    if (wide) box.expandByScalar(0.9);
    return { dir: dir.toArray(), view: framing(box, dir.clone()), seen: lastBest ? lastBest.seen : null, wide: wide };
  }

  /* ---------- 回到推荐视角:工具栏 View 按钮 / V 键 ----------
     最近一次推荐的视角(自动转过去的、二级目标孔特写、三级点了 Use this view 的)都记着 */
  // 记的只是"正在装的这一件"的特写(二级点了源孔后的目标孔特写);一装好就作废,
  // 不然按 View 会回到刚装完的那一件
  var lastView = null;
  KB.on('suggestView', function (v) { if (v && v.p && v.t) lastView = { p: v.p.slice(), t: v.t.slice() }; });
  KB.on('levelFlight', function () { lastView = null; });
  KB.on('snapAttempt', function (a) { if (a && a.success) lastView = null; });
  // 现在该看哪儿:按当前状态重新算(还没装的、正在发黄的那一件)
  function viewNow() {
    if (!window.KBCheck) return null;
    KBCheck.evaluate();
    var st = KBCheck.next();
    if (!st) return null;
    var nodes = partsToMove(st);
    if (!nodes.length) return null;
    var s = suggest(st, nodes);
    if (s && s.phase !== 'find' && window.KBLevel && KBLevel.get() === 1) {
      var top = nodes[0]; while (top.parent && top.parent !== KB.objectsRoot) top = top.parent;
      return framing(boxOfNodes([top]).expandByScalar(0.2), new THREE.Vector3(0.35, 1.0, 0.75));
    }
    return s ? s.view : null;
  }
  function backToView() {
    if (tutorialOn()) return;
    var armed = window.KBMate && KBMate.armed();
    var v = armed && lastView ? lastView : viewNow() || lastView;   // 二级源孔选着:回目标孔特写;否则看下一件
    if (v) KB.flyCamera(v.p, v.t);
    else KB.toast('Nothing left to place');
  }
  var viewBtn = document.getElementById('btnView');
  if (viewBtn) viewBtn.addEventListener('click', backToView);
  window.addEventListener('keydown', function (e) {
    if (e.code !== 'KeyV' || (KB.expert && KB.expert()) || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    backToView();
  });

  window.KBFocus = { refresh: refresh, following: function () { return follow; }, viewForSlot: viewForSlot,
                     /* patch 09:把 bowei 的原行为一句话开回来 */
                     autoUpTo: function (n) { if (n !== undefined) { AUTO_MAX = n; soon(); } return AUTO_MAX; },
                     cards: function (on) { if (on !== undefined) { CARDS = !!on; if (!CARDS && shown) hideCard(); soon(); } return CARDS; },
                     stickyFollow: function (on) { if (on !== undefined) { STICKY_FOLLOW = !!on; if (!STICKY_FOLLOW) follow = false; } return STICKY_FOLLOW; },
                     /* patch 11 §4:三级的黄箭头开关(一二级不受影响) */
                     /* AI 逐条点名: 给这一件挂一个它自己颜色的箭头, 传 false 摘掉 */
                     markArrow: function (node, on) {
                       if (!node) return false;
                       // 一级 / 二级台子自己在指, 那个箭头是它的教学功能, 不是
                       // AI 的标注 —— AI 这边说要不要箭头只管三级。不加这道闸,
                       // 一条 arrow:false 的标记会把一级二级的自动引导按掉。
                       if (pointsNow()) return true;
                       if (on) {
                         noArrow.delete(node);
                         markArrows.set(node, true);
                         wantArrow(node);
                         return true;
                       }
                       markArrows.delete(node);
                       noArrow.add(node);
                       var a = arrows.get(node);
                       if (a) { KB.scene.remove(a); arrows.delete(node); }
                       return true;
                     },
                     /* 一批标注收工: 把上一批的"不要箭头"忘掉, 否则它会压住下一批 */
                     forgetArrows: function () { noArrow.clear(); markArrows.clear(); refresh(); },
                     /* 台子自己那套"下一件"的黄箭头开关(不影响 AI 点名的箭头) */
                     ownArrow: function (on) { if (on !== undefined) { OWN_ARROW = !!on; refresh(); } return OWN_ARROW; },
                     pointAtL3: function (on) { if (on !== undefined) { POINT_AT_L3 = !!on; refresh(); } return POINT_AT_L3; },
                     /* 宿主让台子临时指一件(学员问了才发);null 收掉 */
                     pointAt: pointAt, pointedAt: function () { return pointed; },
                     /* 这一步台子自己还在等的件, 按它自己的顺序。
                        问"下一个是啥"的唯一正确答案在这里 —— 台子的阴影
                        早就把它显示出来了, 外面该来查, 不该自己猜一个名字
                        再回头让台子去找。 */
                     waitingFor: function () {
                       if (!(window.KBCheck && window.KBParts && KBParts.ready())) return [];
                       // 不催判定: 这个函数会在状态上报里被读到, 而状态上报
                       // 本身刚算过一次。步内多余的 evaluate 正是审计 F4。
                       if (!KBCheck.results || !KBCheck.results()) return [];
                       var st = KBCheck.next();
                       return st ? partsToMove(st).slice() : [];
                     },
                     snapshot: snapshot, lit: function () { return lit.slice(); },
                     suggestion: function () { return shown ? { key: shown.key, view: shown.view } : null; },
                     use: function () { answer(true); }, dismiss: function () { answer(false); },
                     // 某几个零件的特写视角(和推荐视角同一套取景),教程里镜头跟着零件走用
                     viewOf: function (nodes) { var b = boxOfNodes(nodes.filter(Boolean)).expandByScalar(0.25); return framing(b, new THREE.Vector3(0.35, 1.0, 0.75)); },
                     demo: function (d) { demo = d || null; if (!demo && shown && /^tutorial\|/.test(shown.key)) hideCard(); refresh(); } };
})();
