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
    parts.forEach(function (d) {
      d.path.forEach(function (w) { w.p = [w.p[0] - cx, w.p[1] - minY, w.p[2] - cz]; });
    });
    DATA = {
      source: src,
      steps: src.steps.map(function (st) { return { i: st.i, label: st.name, requires: st.requires || [] }; }),
      parts: parts
    };
  }

  var btn = document.getElementById('btnAnswer');
  var nextBtn = document.getElementById('btnNext');
  var bar = document.getElementById('answerBar');
  if (!btn || !bar) return;

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
    root.position.set(0, HOVER, 0);
    items = [];
    stepEnd = [];
    DATA.parts.forEach(function (d) {
      var prims = KBParts.prims(d.key);
      if (!prims) return;
      var mat = new THREE.MeshBasicMaterial({
        color: 0x9fd3ef, transparent: true, opacity: 0, depthWrite: false
      });
      var g = new THREE.Group();
      prims.forEach(function (pr) { g.add(new THREE.Mesh(pr.geometry, mat)); });
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
    btn.classList.remove('on');
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
    fill.style.width = (Math.min(t / maxT, 1) * 100) + '%';
    var dots = nodesEl.children;
    for (var i = 0; i < dots.length; i++) {
      dots[i].classList.toggle('reached', t >= stepEnd[i] - 0.01);
    }
    if (focus) {
      labelEl.textContent = 'Next: ' + focus.step.name;
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

  btn.addEventListener('click', function () {
    if (root) { destroy(); KB.toast('Answer demo closed'); return; }
    if (!build()) return;
    btn.classList.add('on');
    t = 0;
    lastNow = 0;
    render();
    rafId = requestAnimationFrame(tick);
    KB.toast('Answer demo: click nodes to jump \u00b7 drag the bar \u00b7 adjust speed');
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
  function showStep(i) {
    if (!(window.KBParts && KBParts.ready() && window.KBCheck)) return false;
    var res = KBCheck.evaluate();
    if (!res || !res.ready || !res.steps[i]) return false;
    var step = res.steps[i], src = KBParts.answer();
    var anchor = null, candAnchor = null;
    step.slots.forEach(function (tt) { if (!anchor && tt.part && tt.near.length) anchor = { ref: tt.ref, M: tt.part.M }; });
    if (!anchor) step.slots.forEach(function (tt) {
      tt.ref.mates.forEach(function (m) {
        if (anchor || m.slot.step > tt.ref.step) return;
        var ms = res.slots[m.slot.i];
        if (ms.part && (ms.ok || !ms.near.length || m.slot.step === tt.ref.step)) anchor = { ref: m.slot, M: ms.part.M };
      });
    });
    // 该拿的零件:每个未到位槽位配一个桌上空闲的同类零件
    var free = res.users.filter(function (u) { return !u.slot; }), taken = [], cand = {};
    step.slots.forEach(function (tt) {
      if (tt.ok) return;
      var c = free.filter(function (u) { return u.ckey === tt.ref.ckey && taken.indexOf(u) < 0; })[0];
      if (c) { cand[tt.ref.i] = c; taken.push(c); }
    });
    if (!anchor) {
      var t0 = step.slots.filter(function (tt) { return cand[tt.ref.i]; })[0];
      if (t0) { candAnchor = t0.ref; anchor = { ref: t0.ref, M: cand[t0.ref.i].M }; }
    }
    if (!anchor) { KB.toast('Nothing on the table to anchor this step to'); return false; }
    destroy();
    var A = new THREE.Matrix4().multiplyMatrices(anchor.M, anchor.ref.Minv);   // 参考世界 → 用户世界
    root = new THREE.Group();
    root.userData.kbOverlay = true;
    items = []; stepEnd = [];
    step.slots.forEach(function (tt) {
      if (tt.ok || tt.ref === candAnchor) return;
      var d = src.parts[tt.ref.i], prims = KBParts.prims(d.key);
      if (!prims) return;
      var mat = new THREE.MeshBasicMaterial({ color: 0x9fd3ef, transparent: true, opacity: 0, depthWrite: false });
      var g = new THREE.Group();
      prims.forEach(function (pr) { g.add(new THREE.Mesh(pr.geometry, mat)); });
      g.visible = false;
      root.add(g);
      var pts = [], quats = [];
      d.path.forEach(function (w) {
        var M = nodeMatrix(d.key, w).premultiply(A), pp = new THREE.Vector3(), qq = new THREE.Quaternion();
        M.decompose(pp, qq, new THREE.Vector3());
        pts.push(pp); quats.push(qq);
      });
      if (pts.length === 1) { pts.unshift(pts[0].clone().add(new THREE.Vector3(0, 0.8, 0))); quats.unshift(quats[0].clone()); }
      var lens = [0];
      for (var k = 1; k < pts.length; k++) lens.push(lens[k - 1] + pts[k].distanceTo(pts[k - 1]));
      items.push({ g: g, mat: mat, name: d.name, step: 0, start: 0, pts: pts, quats: quats, lens: lens, total: lens[lens.length - 1] || 1 });
    });
    if (!items.length) { KB.toast('This step is already complete'); return false; }
    schedule();
    maxT += 0.8;   // 结尾停一下再循环
    KB.scene.add(root);
    focus = { step: step, lit: [] };
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
  function showNext() {
    if (!window.KBCheck) return false;
    KBCheck.evaluate();
    var nx = KBCheck.next();
    if (!nx) { KB.toast('Assembly complete \u2014 nothing left to do'); return false; }
    return showStep(nx.i);
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
      if (!focus) return;
      var cur = focus.step.i, res = KBCheck.evaluate();
      var st = res && res.steps[cur];
      var target = st && st.state !== 'complete' && st.state !== 'premature' ? st : KBCheck.next();
      if (target) showStep(target.i); else destroy();
    }, 350);
  });

  /* 测试 / 调试入口 + 标准答案数据(供 Checks 对照) */
  window.KBAnswer = {
    showStep: showStep,
    showNext: showNext,
    hide: destroy,
    focus: function () { return focus ? { step: focus.step.i, name: focus.step.name } : null; },
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
