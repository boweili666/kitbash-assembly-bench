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
    var out = [], used = {};
    var all = [];
    KB.objectsRoot.traverse(function (o) { if (KB.isPart(o)) all.push(o); });
    // 按级别自动摆好的零件位置就是答案,只是单独一个判不了"到位" —— 不算还要动
    // 暂放在一边的组件:只在"把它装到基座上"那一步算待放,别的步骤里它已经放好了
    var placed = {};
    all.forEach(function (n) {
      var r = step.assembly ? KBCheck.levelPlacedSlot(n) : KBCheck.placedSlotAny(n);
      if (r) placed[r.id] = n;
    });
    // "把预装好的组件装到基座上"这种步骤(比如 X-Lock),要动的是基座本身,
    // 可它不在这一步的零件列表里 —— 漏了它,这一步就既不亮也没有推荐视角
    var slots = step.slots.slice();
    if (step.base && !step.base.ok && slots.indexOf(step.base) < 0) slots.unshift(step.base);
    // 同一步里先放的排前面(比如 ESC 那一步先放垫圈)
    slots.sort(function (a, b) { return Number(KBCheck.comesFirst(b.ref)) - Number(KBCheck.comesFirst(a.ref)); });
    var kinds = [];                                    // 和 out 一一对应:这件是哪种零件
    slots.forEach(function (t) {
      if (t.ok || placed[t.ref.id]) return;
      if (t.part) { out.push(t.part.node); kinds.push(t.ref.ckey); used[t.part.node.uuid] = true; return; }
      var want = t.ref.ckey, best = null;
      all.forEach(function (n) {
        if (used[n.uuid] || KBCheck.canon(keyOf(n)) !== want || KBCheck.placedSlotAny(n)) return;
        var s = KBCheck.slotOf(n);
        if (s && s.ok) return;                        // 已经装在别处了
        var score = (n.name === t.ref.name ? 0 : 1) + (s ? 2 : 0);
        if (!best || score < best.score) best = { node: n, score: score };
      });
      if (best) { out.push(best.node); kinds.push(t.ref.ckey); used[best.node.uuid] = true; }
    });
    // 按顺序亮:只亮排在最前面、同一种的那一串(比如 4 颗电机螺丝),都到位了再亮后面的(电机、螺母)
    var run = 0;
    while (run < out.length && kinds[run] === kinds[0]) run++;
    return out.slice(0, run);
  }

  /* ---------- 高亮:整件染成黄色呼吸 + 头顶一个跳动的箭头 ----------
     只加自发光的话,白色的螺丝亮了还是白的,一排一样的螺丝里根本找不出来 */
  var arrows = new Map();       // node -> 箭头
  var arrowGeo = null, arrowMat = null;
  function makeArrow() {
    if (!arrowGeo) {
      var cone = new THREE.ConeGeometry(0.5, 1, 20); cone.rotateX(Math.PI); cone.translate(0, 0.5, 0);   // 尖朝下,尖在原点
      var stem = new THREE.CylinderGeometry(0.18, 0.18, 0.9, 12); stem.translate(0, 1.45, 0);
      arrowGeo = [cone, stem];
      arrowMat = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
    }
    var g = new THREE.Group();
    arrowGeo.forEach(function (geo) { var m = new THREE.Mesh(geo, arrowMat); m.renderOrder = 999; g.add(m); });
    g.userData.kbOverlay = true;   // 抓帧时隐藏
    KB.scene.add(g);
    return g;
  }
  function restore(n) {
    KB.highlight(n, null);
    n.traverse(function (o) {
      if (o.isMesh && o.material && o.material.userData.kbBase) { o.material.color.copy(o.material.userData.kbBase); delete o.material.userData.kbBase; }
    });
    var a = arrows.get(n);
    if (a) { KB.scene.remove(a); arrows.delete(n); }
  }
  function setLit(nodes) {
    lit.forEach(function (n) { if (nodes.indexOf(n) < 0) restore(n); });
    lit = nodes.slice();
    lit.forEach(function (n) { if (!arrows.has(n)) arrows.set(n, makeArrow()); });
  }
  var _hb = new THREE.Box3(), _hc = new THREE.Vector3();
  (function pulse() {
    requestAnimationFrame(pulse);
    if (!lit.length) return;
    var now = performance.now(), w = 0.5 + 0.5 * Math.sin(now / 260);
    var k = 0.25 + 0.45 * w;
    lit.forEach(function (n) {
      n.traverse(function (o) {
        if (!o.isMesh || !o.material || !o.material.emissive || o.userData.kbOverlay) return;
        var m = o.material;
        if (!m.userData.kbBase) m.userData.kbBase = m.color.clone();
        m.color.copy(m.userData.kbBase).lerp(TINT, 0.8 + 0.2 * w);
        m.emissive.copy(COLOR);
        m.emissiveIntensity = k;
      });
      // 箭头:悬在零件正上方,上下跳;大小跟镜头距离走,远看也找得到
      var a = arrows.get(n);
      if (!a) return;
      _hb.setFromObject(n); _hb.getCenter(_hc);
      var size = Math.max(0.06, KB.camera.position.distanceTo(_hc) * 0.028);
      a.scale.setScalar(size);
      a.position.set(_hc.x, _hb.max.y + size * (0.35 + 0.45 * (0.5 + 0.5 * Math.sin(now / 180))), _hc.z);
      a.visible = !!n.parent;
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
    if (!f || !f.node || tutorialOn() || !(follow || f.force || autoView())) return;
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
    if (use) follow = true;
    if (use) KB.flyCamera(shown.view.p, shown.view.t);
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
    setLit(nodes);
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
        KB.emit('viewTip', { key: key, auto: true, view: s.view });
      }, 700);
      return;
    }
    if (shown && shown.key === key) return;          // 已经挂着同一个建议
    shown = { key: key, view: s.view };
    card.querySelector('.vt-img').src = snapshot(s.view);
    card.querySelector('.vt-cap').textContent = 'Step ' + (st.i + 1) + ' · ' + s.caption;
    card.hidden = false;
    KB.emit('viewTip', { key: key, shown: true, view: s.view });
  }
  function soon() { clearTimeout(timer); timer = setTimeout(refresh, 450); }
  var autoTimer = 0, pendingKey = null;
  function autoView() { return window.KBLevel && KBLevel.get() <= 2; }
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

  window.KBFocus = { refresh: refresh, following: function () { return follow; }, viewForSlot: viewForSlot,
                     snapshot: snapshot, lit: function () { return lit.slice(); },
                     suggestion: function () { return shown ? { key: shown.key, view: shown.view } : null; },
                     use: function () { answer(true); }, dismiss: function () { answer(false); },
                     // 某几个零件的特写视角(和推荐视角同一套取景),教程里镜头跟着零件走用
                     viewOf: function (nodes) { var b = boxOfNodes(nodes.filter(Boolean)).expandByScalar(0.25); return framing(b, new THREE.Vector3(0.35, 1.0, 0.75)); },
                     demo: function (d) { demo = d || null; if (!demo && shown && /^tutorial\|/.test(shown.key)) hideCard(); refresh(); } };
})();
