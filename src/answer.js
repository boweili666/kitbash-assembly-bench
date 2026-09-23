/* ============================================================
 * 「答案」虚影动画 — Frame Bottom Assembly 装配演示(带播放控制)
 *
 * 数据:零件库 manifest.answer(features_db.py answer 从 task_graphs.db 的
 * Step3DPaths / StepRequirements 生成)—— 步骤按装配时序排列,每个零件
 * 取其安装步骤内 接近→落位 的真实轨迹点,打开时换算到场景单位。
 * 控制条:播放/暂停 · 速度 · 进度条(可点/拖)· 步骤节点(点击跳转)。
 * 虚影不可选中、不参与吸附、不进撤销/导出。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;

  /* 虚影材质 + 深度预通道:先只写深度(不着色),再按"深度相等"画半透明层,
   * 这样只显示最外层表面 —— 电机这种内部塞满绕组的模型不会变成 X 光片 */
  function ghostMaterial() {
    return new THREE.MeshBasicMaterial({
      color: 0x9fd3ef, transparent: true, opacity: 0, depthWrite: false, depthFunc: THREE.EqualDepth
    });
  }
  var depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, depthWrite: true });
  function addGhost(group, geometry, mat) {
    var pre = new THREE.Mesh(geometry, depthOnly);
    pre.renderOrder = 1;
    var vis = new THREE.Mesh(geometry, mat);
    vis.renderOrder = 2;
    group.add(pre, vis);
  }
  // 参考装配来自零件库数据(manifest.answer,mm / GLB 原点,features_db.py answer 生成)。
  // 打开时换算到场景单位:整体 XZ 居中、最低零件原点落到 0(root 再抬 HOVER)。
  var DATA = { steps: [], parts: [], source: null };
  function loadData() {
    var src = window.KBParts && KBParts.ready() && KBParts.answer && KBParts.answer();
    if (!src || DATA.source === src) return;
    var parts = [], minY = Infinity, sx = 0, sz = 0, n = 0;
    src.parts.forEach(function (d) {
      if (!KBParts.spec(d.key)) return;
      var path = d.path.map(function (pose) { var t = KBParts.nodeTransform(d.key, pose); return { p: t.p, e: t.r }; });
      if (path.length === 1) path.push({ p: path[0].p.slice(), e: path[0].e.slice() }); // 静止零件:原地出现
      var last = path[path.length - 1];
      minY = Math.min(minY, last.p[1]); sx += last.p[0]; sz += last.p[2]; n += 1;
      parts.push({ id: d.id, key: d.key, name: d.name, step: d.step, path: path });
    });
    parts.sort(function (a, b) { return a.step - b.step; });   // schedule() 按步骤顺序走
    var cx = n ? sx / n : 0, cz = n ? sz / n : 0;
    // 「把两个已经预装好的组件装到一起」这种步骤(assembly 由 parts.js 标出来):
    // 同一组的零件必须整体平移进场,各自按自己采到的轨迹飞会把组件拆散
    var byStep = {};
    src.steps.forEach(function (st) { byStep[st.i] = st; });
    var SIDE = 40 * (KBParts.unitScale() / 1000);        // 从两侧各让开 40 mm
    parts.forEach(function (d) {
      var st = byStep[d.step];
      var path = d.path;
      if (st && st.assembly) {
        var side = st.assembly.groups.findIndex(function (g) { return g.indexOf(d.id) >= 0; });
        var last = path[path.length - 1];
        var approach = { p: [last.p[0] + (side === 0 ? -SIDE : SIDE), last.p[1], last.p[2]],
                         e: last.e.slice() };
        path = [approach, last];
        d.path = path;
      }
      path.forEach(function (w) { w.p = [w.p[0] - cx, w.p[1] - minY, w.p[2] - cz]; });
    });
    DATA = {
      source: src,
      steps: src.steps.map(function (st) { return { i: st.i, label: st.name, requires: st.requires || [] }; }),
      parts: parts
    };
  }

  var btn = document.getElementById('btnAnswer');   // 已从工具栏移除时为 null
  var nextBtn = document.getElementById('btnNext');
  var bar = document.getElementById('answerBar');
  if (!bar) return;   // Answer 按钮已从工具栏拿掉,但 Next 仍然靠这个模块,不能因为按钮不在就整个退出

  var HOVER = 1.35;                          // 虚影悬浮高度
  var DUR = 1.15, GAP = 0.2, STEP_GAP = 0.5, OP = 0.32;
  var SPEEDS = [0.5, 1, 1.5, 2];

  var playBtn = document.getElementById('ansPlay');
  var speedBtn = document.getElementById('ansSpeed');
  var closeBtn = document.getElementById('ansClose');
  var track = document.getElementById('ansTrack');
  var fill = document.getElementById('ansFill');
  var nodesEl = document.getElementById('ansNodes');
  var labelEl = document.getElementById('ansLabel');
  var iconPlay = playBtn.querySelector('.ic-play');
  var iconPause = playBtn.querySelector('.ic-pause');

  var completionTimer = 0;
  var root = null, items = [], stepEnd = [], maxT = 0;
  var t = 0, playing = false, rafId = 0, lastNow = 0, speedIdx = 1;

  function schedule() {
    var cur = 0.3, lastStep = -1;
    items.forEach(function (it) {
      if (it.step !== lastStep && lastStep >= 0) cur += STEP_GAP;
      lastStep = it.step;
      it.start = cur;
      cur += DUR + GAP;
      stepEnd[it.step] = cur - GAP;
    });
    maxT = cur + 0.4;
  }

  function build() {
    if (!(window.KBParts && KBParts.ready())) {
      KB.toast('Parts library is still loading, try again shortly');
      return false;
    }
    loadData();
    if (!DATA.parts.length) { KB.toast('No reference assembly in the part library'); return false; }
    root = new THREE.Group();
    root.userData.kbOverlay = true; // 抓帧时隐藏
    // 悬在装配区上方 —— 装配区已经挪到物料区前面,原点那边现在是托盘
    var c = window.KBWorkspace ? KBWorkspace.center : { x: 0, z: 0 };
    root.position.set(c.x, HOVER, c.z);
    items = [];
    stepEnd = [];
    DATA.parts.forEach(function (d) {
      var prims = KBParts.prims(d.key);
      if (!prims) return;
      var mat = ghostMaterial();
      var g = new THREE.Group();
      prims.forEach(function (pr) { addGhost(g, pr.geometry, mat); });
      g.visible = false;
      root.add(g);
      // 轨迹点(位置折线 + 姿态四元数),按段长做匀速插值
      var pts = d.path.map(function (w) { return new THREE.Vector3().fromArray(w.p); });
      var quats = d.path.map(function (w) {
        return new THREE.Quaternion().setFromEuler(new THREE.Euler(w.e[0], w.e[1], w.e[2], 'XYZ'));
      });
      var lens = [0];
      for (var i = 1; i < pts.length; i++) {
        lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
      }
      items.push({ g: g, mat: mat, name: d.name, step: d.step, start: 0,
        pts: pts, quats: quats, lens: lens, total: lens[lens.length - 1] || 1 });
    });
    schedule();
    KB.scene.add(root);
    buildBar();
    return true;
  }

  function destroy() {
    clearTimeout(completionTimer);
    if (window.KBGuide) KBGuide.hide();
    cancelAnimationFrame(rafId);
    rafId = 0;
    playing = false;
    if (root) {
      items.forEach(function (it) { it.mat.dispose(); }); // 几何体共享,不 dispose
      KB.scene.remove(root);
      root = null;
    }
    items = [];
    bar.style.display = 'none';
    if (btn) btn.classList.remove('on');
    clearFocus();
  }

  var tmpV = null, tmpQ = null;
  function poseAt(it, u) {
    // u∈[0,1] → 沿折线的弧长位置 + 分段姿态插值
    if (!tmpV) { tmpV = new THREE.Vector3(); tmpQ = new THREE.Quaternion(); }
    var s = u * it.total;
    var i = 1;
    while (i < it.lens.length - 1 && it.lens[i] < s) i++;
    var seg = it.lens[i] - it.lens[i - 1] || 1;
    var f = (s - it.lens[i - 1]) / seg;
    tmpV.lerpVectors(it.pts[i - 1], it.pts[i], f);
    tmpQ.slerpQuaternions(it.quats[i - 1], it.quats[i], f);
    it.g.position.copy(tmpV);
    it.g.quaternion.copy(tmpQ);
  }

  function render() {
    var current = null;
    items.forEach(function (it) {
      var u = (t - it.start) / DUR;
      if (u <= 0) { it.g.visible = false; return; }
      if (u > 1) u = 1;
      var e = 1 - Math.pow(1 - u, 3);
      it.g.visible = true;
      it.mat.opacity = OP * Math.min(u * 4, 1); // 前 1/4 淡入
      poseAt(it, e);
      if (t >= it.start) current = it;
    });
    bar.classList.toggle('next-guidance', !!focus);
    fill.style.width = (Math.min(t / maxT, 1) * 100) + '%';
    var dots = nodesEl.children;
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('reached', t >= stepEnd[i] - 0.01);
    }
    if (focus) {
      if (window.KBGuide) KBGuide.update(focus.step, focus.phase, focus.why);
      // 同一步反复重放时说清卡在哪:光看虚影不知道判定还差什么
      labelEl.textContent = focus.phase === 'workspace' ? focus.why : 'Next: ' + focus.step.name + (focus.why ? ' \u2014 ' + focus.why : '');
    } else if (t >= maxT - 0.01) {
      labelEl.textContent = 'Assembly complete \u00b7 ' + items.length + ' parts';
    } else if (current) {
      labelEl.textContent = 'Step ' + (current.step + 1) + '/' + DATA.steps.length +
        ' \u00b7 ' + current.name;
    } else {
      labelEl.textContent = 'Ready \u00b7 ' + DATA.steps.length + ' steps';
    }
  }

  function setPlaying(on) {
    playing = on;
    iconPlay.style.display = on ? 'none' : 'block';
    iconPause.style.display = on ? 'block' : 'none';
  }

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (!lastNow) lastNow = now;
    var dt = (now - lastNow) / 1000;
    lastNow = now;
    if (playing) {
      t += dt * SPEEDS[speedIdx];
      if (t >= maxT) { if (focus) t = 0; else { t = maxT; setPlaying(false); } }
      render();
    }
  }

  function buildBar() {
    nodesEl.innerHTML = '';
    DATA.steps.forEach(function (s, i) {
      var dot = document.createElement('button');
      dot.className = 'ans-node';
      var names = DATA.parts.filter(function (p) { return p.step === i; })
        .map(function (p) { return p.name; }).join('、');
      dot.title = 'Step ' + (i + 1) + ': ' + names + (s.label ? '\n' + s.label : '');
      dot.style.left = (stepEnd[i] / maxT * 100) + '%';
      dot.addEventListener('click', function (ev) {
        ev.stopPropagation();
        t = stepEnd[i];
        setPlaying(false);
        render();
      });
      nodesEl.appendChild(dot);
    });
    bar.style.display = 'flex';
    setPlaying(true);
  }

  playBtn.addEventListener('click', function () {
    if (!root) return;
    if (!playing && t >= maxT - 0.01) t = 0; // 结尾处再按播放 = 重来
    setPlaying(!playing);
  });
  speedBtn.addEventListener('click', function () {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    speedBtn.textContent = SPEEDS[speedIdx] + '×';
  });
  closeBtn.addEventListener('click', function () {
    destroy();
    KB.toast('Answer demo closed');
  });

  var scrubbing = false;
  function scrub(ev) {
    var r = track.getBoundingClientRect();
    t = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1) * maxT;
    setPlaying(false);
    render();
  }
  track.addEventListener('pointerdown', function (ev) {
    if (ev.target.classList.contains('ans-node')) return;
    scrubbing = true;
    track.setPointerCapture(ev.pointerId);
    scrub(ev);
  });
  track.addEventListener('pointermove', function (ev) { if (scrubbing) scrub(ev); });
  track.addEventListener('pointerup', function () { scrubbing = false; });

  /* 整机装配演示:44 步的虚影从头放到尾。工具栏上的 Answer 按钮已经拿掉
     (学员不该一键看答案),留 KBAnswer.play() 和 Shift+A 给出题/验收的人用 */
  function play() {
    if (root) { destroy(); KB.toast('Assembly demo closed'); return false; }
    if (!build()) return false;
    if (btn) btn.classList.add('on');
    t = 0;
    lastNow = 0;
    render();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
    KB.toast('Assembly demo: click nodes to jump \u00b7 drag the bar \u00b7 adjust speed');
    return true;
  }
  if (btn) btn.addEventListener('click', play);
  window.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (e.code !== 'KeyA' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    e.preventDefault();
    play();
  });

  /* ---------- "下一步"模式:把某一步的参考轨迹贴到用户当前的装配体上循环播放 ----------
     锚 = 该步里已装上的零件,或它的配合件里已装上的零件;都没有就拿桌上一个同类候选零件当锚。
     虚影的世界位姿 = 用户锚位姿 · inv(参考锚位姿) · 参考轨迹点,所以跟着用户的结构走。 */
  var focus = null;   // { step, lit:[node] }
  function nodeMatrix(key, pose) {
    var tr = KBParts.nodeTransform(key, pose);
    return new THREE.Matrix4().compose(new THREE.Vector3().fromArray(tr.p),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(tr.r[0], tr.r[1], tr.r[2], 'XYZ')), new THREE.Vector3(1, 1, 1));
  }
  function clearFocus() {
    if (!focus) return;
    focus.lit.forEach(function (nd) { KB.highlight(nd, null); });
    focus = null;
    if (nextBtn) nextBtn.classList.remove('on');
  }
  // Transfer guidance uses the same meshes as the real part; never move the real node.
  function showTransfer(step, anchor) {
    destroy();
    var node = anchor.node;
    while (node.parent && node.parent !== KB.objectsRoot) node = node.parent;
    node.updateWorldMatrix(true, true);
    var target = KBWorkspace.destination(node);
    if (node.parent) target.applyMatrix4(node.parent.matrixWorld);
    var shift = target.sub(node.getWorldPosition(new THREE.Vector3()));
    root = new THREE.Group(); root.userData.kbOverlay = true;
    items = []; stepEnd = [];
    node.traverse(function (part) {
      if (!KB.isPart(part)) return;
      var g = new THREE.Group(), mat = ghostMaterial();
      part.traverse(function (mesh) {
        if (!mesh.isMesh || mesh.userData.kbOverlay) return;
        var pair = new THREE.Group(); addGhost(pair, mesh.geometry, mat);
        pair.applyMatrix4(part.matrixWorld.clone().invert().multiply(mesh.matrixWorld));
        g.add(pair);
      });
      var start = part.getWorldPosition(new THREE.Vector3()), end = start.clone().add(shift);
      var q = part.getWorldQuaternion(new THREE.Quaternion());
      g.scale.copy(part.getWorldScale(new THREE.Vector3())); root.add(g);
      items.push({ g: g, mat: mat, name: part.name, step: 0, start: 0,
        pts: [start, start.clone().lerp(end, .5).add(new THREE.Vector3(0, 1, 0)), end],
        quats: [q, q.clone(), q.clone()], lens: [0, start.distanceTo(end)/2, start.distanceTo(end)], total: start.distanceTo(end) || 1 });
    });
    schedule(); maxT += .8; KB.scene.add(root);
    focus = { step: step, phase: 'workspace', base: node.userData.kbId || node.uuid, lit: [node],
      why: 'First: move ' + node.name + ' into the workspace. Select it, then click inside the green boundary.' };
    KB.highlight(node, 0xe8a33d);
    nodesEl.innerHTML = ''; fill.style.width = '0%'; bar.style.display = 'flex';
    if (nextBtn) nextBtn.classList.add('on');
    t = 0; lastNow = 0; setPlaying(true); render();
    rafId = requestAnimationFrame(tick); return true;
  }
  function showStep(i) {
    if (!(window.KBParts && KBParts.ready() && window.KBCheck)) return false;
    var res = KBCheck.evaluate();
    if (!res || !res.ready || !res.steps[i]) return false;
    var step = res.steps[i], src = KBParts.answer();
    var anchor = null, candAnchor = null;
    if (step.assembly) {
      if (!step.base.part) { destroy(); KB.toast('Add the X-Lock to the scene first.'); return false; }
      anchor = { ref: step.base.ref, M: step.base.part.M, node: step.base.part.node };
    }
    step.slots.forEach(function (tt) { if (!anchor && tt.part && tt.near.length) anchor = { ref: tt.ref, M: tt.part.M, node: tt.part.node }; });
    if (!anchor) step.slots.forEach(function (tt) {
      tt.ref.mates.forEach(function (m) {
        if (anchor || m.slot.step > tt.ref.step) return;
        var ms = res.slots[m.slot.i];
        if (ms.part && (ms.ok || !ms.near.length || m.slot.step === tt.ref.step)) anchor = { ref: m.slot, M: ms.part.M, node: ms.part.node };
      });
    });
    // 该拿的零件:每个未到位槽位配一个桌上空闲的同类零件
    var free = res.users.filter(function (u) { return !u.slot; }), taken = [], cand = {};
    step.slots.forEach(function (tt) {
      if (tt.ok) return;
      if (step.assembly && tt.part) { cand[tt.ref.i] = tt.part; return; }
      var c = free.filter(function (u) { return u.ckey === tt.ref.ckey && taken.indexOf(u) < 0; }).sort(function (a, b) { return Number(KBWorkspace.contains(b.node)) - Number(KBWorkspace.contains(a.node)); })[0];
      if (c) { cand[tt.ref.i] = c; taken.push(c); }
    });
    if (!anchor) {
      var t0 = step.slots.filter(function (tt) { return cand[tt.ref.i]; })[0];
      if (t0) { candAnchor = t0.ref; anchor = { ref: t0.ref, M: cand[t0.ref.i].M, node: cand[t0.ref.i].node }; }
    }
    if (!anchor) { KB.toast('Nothing on the table to anchor this step to'); return false; }
    var receiver = anchor.node;
    while (receiver.parent && receiver.parent !== KB.objectsRoot) receiver = receiver.parent;
    if (window.KBWorkspace && !KBWorkspace.contains(receiver)) return showTransfer(step, anchor);
    destroy();
    var A = new THREE.Matrix4().multiplyMatrices(anchor.M, anchor.ref.Minv);   // 参考世界 → 用户世界
    root = new THREE.Group();
    root.userData.kbOverlay = true;
    items = []; stepEnd = [];
    step.slots.forEach(function (tt) {
      if (tt.ok || tt.ref === candAnchor) return;
      var d = src.parts[tt.ref.i], prims = KBParts.prims(d.key);
      if (!prims) return;
      var mat = ghostMaterial();
      var g = new THREE.Group();
      prims.forEach(function (pr) { addGhost(g, pr.geometry, mat); });
      g.visible = false;
      root.add(g);
      var pts = [], quats = [];
      var path = d.path;
      var sideIndex = step.assembly ? step.assembly.groups.findIndex(function (g) { return g.indexOf(d.id) >= 0; }) : -1;
      if (step.assembly) {
        var finalPose = d.path[d.path.length - 1], approach = Object.assign({}, finalPose);
        // Both members share the same translation, preserving the prepared pair.
        approach.x += sideIndex === 0 ? -40 : 40;
        path = [approach, finalPose];
      }
      path.forEach(function (w) {
        var M = nodeMatrix(d.key, w).premultiply(A), pp = new THREE.Vector3(), qq = new THREE.Quaternion();
        M.decompose(pp, qq, new THREE.Vector3());
        pts.push(pp); quats.push(qq);
      });
      if (pts.length === 1) { pts.unshift(pts[0].clone().add(new THREE.Vector3(0, 0.8, 0))); quats.unshift(quats[0].clone()); }
      var lens = [0];
      for (var k = 1; k < pts.length; k++) lens.push(lens[k - 1] + pts[k].distanceTo(pts[k - 1]));
      items.push({ g: g, mat: mat, name: d.name, batch: sideIndex, step: 0, start: 0, pts: pts, quats: quats, lens: lens, total: lens[lens.length - 1] || 1 });
    });
    if (!items.length) { KB.toast('This step is already complete'); return false; }
    schedule();
    if (step.assembly) {
      items.forEach(function (it) { it.start = .3 + it.batch * (DUR + GAP); });
      maxT = .3 + step.assembly.groups.length * (DUR + GAP); stepEnd = [maxT];
    }
    maxT += 0.8;   // 结尾停一下再循环
    KB.scene.add(root);
    focus = { step: step, phase: 'assembly', lit: [] };
    Object.keys(cand).forEach(function (k) { var nd = cand[k].node; KB.highlight(nd, 0xe8a33d); focus.lit.push(nd); });
    nodesEl.innerHTML = '';
    fill.style.width = '0%';
    bar.style.display = 'flex';
    if (nextBtn) nextBtn.classList.add('on');
    t = 0; lastNow = 0;
    setPlaying(true);
    render();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
    return true;
  }
  /* 这一步为什么还没算完成:优先具体问题,其次"还没放" */
  function reasonFor(st) {
    var res = KBCheck.results();
    if (!res || !res.ready) return '';
    // 有具体问题就说具体问题(差多少毫米、插反了……)
    var hit = res.issues.filter(function (i) {
      return i.slot && st.slots.some(function (t) { return t.ref === i.slot; });
    })[0];
    if (hit) return String(hit.msg);
    var missing = st.slots.filter(function (t) { return !t.ok && (!t.part || !t.near.length); });
    if (!missing.length) return '';
    // 零件就在场上、只是离该在的地方太远 —— 说成"还没放"会让人以为漏了零件
    var loose = missing.filter(function (t) {
      return res.users.some(function (u) { return !u.slot && u.ckey === t.ref.ckey; });
    });
    if (loose.length) return loose[0].ref.name + ' is not where the ghost shows it';
    return missing.length + ' part' + (missing.length > 1 ? 's' : '') + ' still to place';
  }

  function showNext() {
    if (!window.KBCheck) return false;
    KBCheck.evaluate();
    var nx = KBCheck.next();
    if (!nx) { KB.toast('Assembly complete \u2014 nothing left to do'); return false; }
    if (!showStep(nx.i)) { if (window.KBGuide) KBGuide.waiting(nx); return false; }
    if (focus.phase !== 'workspace') focus.why = reasonFor(nx);
    render();
    return true;
  }
  if (nextBtn) nextBtn.addEventListener('click', function () {
    if (focus) { destroy(); return; }
    showNext();
  });
  // 放下零件后:这一步做完了就换下一步,没做完就在新结构上重新贴一次
  var refreshTimer = 0;
  KB.onChange(function () {
    if (!focus) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      if (!focus || KB.interacting()) return;
      var cur = focus.step.i, res = KBCheck.evaluate();
      var st = res && res.steps[cur];
      if (st && st.state === 'complete') {
        setPlaying(false); if (root) root.visible = false;
        cancelAnimationFrame(rafId); bar.style.display = 'none';
        if (window.KBGuide) KBGuide.complete(st);
        clearTimeout(completionTimer);
        completionTimer = setTimeout(function () {
          if (KB.interacting()) return;
          var latest = KBCheck.evaluate(), current = latest.steps[cur];
          if (current.state !== 'complete') { showStep(cur); return; }
          var upcoming = KBCheck.next();
          destroy();
          if (upcoming) {
            if (!showStep(upcoming.i) && window.KBGuide) KBGuide.waiting(upcoming);
          } else if (window.KBGuide) KBGuide.complete(current, 'All available assembly steps are complete.');
        }, 1500);
        return;
      }
      var target = st || KBCheck.next();
      if (!target) { destroy(); return; }
      if (target.state === 'premature') {
        setPlaying(false); if (root) root.visible = false;
        if (window.KBGuide) KBGuide.update(target, 'assembly', '');
        return;
      }
      if (!showStep(target.i)) { destroy(); return; }
      if (target.i === cur && focus.phase !== 'workspace') focus.why = reasonFor(target);   // 又是这一步:告诉他为什么没过
      render();
    }, 350);
  });

  /* 测试 / 调试入口 + 标准答案数据(供 Checks 对照) */
  // ?demo=1:开页面就放整机装配演示(给出题 / 验收的人看的,学员那边不会带这个参数)
  if (new URLSearchParams(location.search).has('demo')) {
    (function wait() {
      if (window.KBParts && KBParts.ready()) setTimeout(play, 400);   // 桌上有没有零件都能放
      else setTimeout(wait, 150);
    })();
  }

  /* 把镜头对准当前虚影 —— 调试页面用;正常装配时不会自己动镜头 */
  function frameGhost() {
    if (!root) return false;
    // 不管这一帧可不可见都算进去:虚影是循环播的,取景时零件常常还没"飞出来"
    var box = new THREE.Box3();
    root.updateMatrixWorld(true);
    root.traverse(function (n) {
      if (!n.isMesh) return;
      if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
      box.union(n.geometry.boundingBox.clone().applyMatrix4(n.matrixWorld));
    });
    if (box.isEmpty()) return false;
    var c = box.getCenter(new THREE.Vector3());
    // 留出周边:只框零件本身的话,一颗 6 mm 的螺丝会把镜头怼到看不出在哪
    var r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.9, 1.8);
    KB.flyCamera([c.x + r * 1.5, c.y + r * 1.15, c.z + r * 2.0], [c.x, c.y, c.z]);
    return true;
  }

  window.KBAnswer = {
    play: play,
    frameGhost: frameGhost,
    playing: function () { return !!root; },
    showStep: showStep,
    showNext: showNext,
    hide: destroy,
    focus: function () { return focus ? { step: focus.step.i, name: focus.step.name, phase: focus.phase, base: focus.base } : null; },
    poses: function () {
      loadData();
      return DATA.parts.map(function (d) {
        var last = d.path[d.path.length - 1];
        return { key: d.key, name: d.name, step: d.step, p: last.p, e: last.e };
      });
    },
    stepLabel: function (i) { loadData(); return (DATA.steps[i] && DATA.steps[i].label) || ('Step ' + (i + 1)); },
    stepCount: function () { loadData(); return DATA.steps.length; },
    /* 任务图里步骤 i 的前置步骤(答案步骤下标),供 Checks 判装配顺序;无数据时 null */
    requires: function (i) { loadData(); return DATA.source && DATA.steps[i] ? DATA.steps[i].requires : null; },
    seekStep: function (i) { t = stepEnd[i]; setPlaying(false); render(); },
    info: function () {
      return { active: !!root, t: t, maxT: maxT, playing: playing,
        steps: stepEnd.length,
        placed: items.filter(function (it) { return t >= it.start + DUR - 1e-6; }).length };
    }
  };
})();
