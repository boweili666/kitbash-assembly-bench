/* ============================================================
 * 「答案」虚影动画 — Frame Bottom Assembly 装配演示(带播放控制)
 *
 * 数据:aristos 装配图 step_3d_paths.json —— 每个零件取其安装步骤内
 * 终点前的真实接近/插入轨迹点(螺丝沿轴插入、楔块侧向滑入等),
 * 已换算到编辑器单位。步骤名来自装配任务图。
 * 控制条:播放/暂停 · 速度 · 进度条(可点/拖)· 步骤节点(点击跳转)。
 * 虚影不可选中、不参与吸附、不进撤销/导出。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var DATA = {"steps":[{"i":0,"label":"Feed Screw through Arm Wedge (A)"},{"i":1,"label":"Feed Screw through Arm Wedge (B)"},{"i":2,"label":"Attach Arm Wedge Assembly to X-Lock (A)"},{"i":3,"label":"Place Assembly Aluminum X-Lock with Wedges on Rear Plate"},{"i":4,"label":"Feed Screw through X-Lock and Rear Plate (A)"},{"i":5,"label":"Feed Screw through X-Lock and Rear Plate (B)"},{"i":6,"label":"Feed Screw through X-Lock and Rear Plate (D)"},{"i":7,"label":"Insert Arm into X-Lock Assembly (A)"},{"i":8,"label":"Insert Arm into X-Lock Assembly (B)"},{"i":9,"label":"Insert Arm into X-Lock Assembly (C)"},{"i":10,"label":"Insert Arm into X-Lock Assembly (D)"},{"i":11,"label":"Place Front Plate on Rear Plate and Arm Assembly"},{"i":12,"label":"Attach Front Plate on Rear Plate and Arm Assembly"},{"i":13,"label":"Feed Standoff Screw through Frame Bottom (A)"},{"i":14,"label":"Attach Knurled Standoff to Frame Bottom (A)"},{"i":15,"label":"Feed Standoff Screw through Frame Bottom (B)"},{"i":16,"label":"Attach Knurled Standoff to Frame Bottom (B)"},{"i":17,"label":"Feed Standoff Screw through Frame Bottom (C)"},{"i":18,"label":"Attach Knurled Standoff to Frame Bottom (C)"},{"i":19,"label":"Feed Standoff Screw through Frame Bottom (D)"},{"i":20,"label":"Attach Knurled Standoff to Frame Bottom (D)"}],"parts":[{"key":"aluminum_arm_wedge_5mm","name":"Arm Wedge 1","step":0,"path":[{"p":[-1.407,0.545,0.087],"e":[0.0,-1.5708,0.0]},{"p":[-0.515,0.545,0.087],"e":[0.0,-1.5708,0.0]}]},{"key":"screw_m3x16_socket_cap","name":"M3×16 Cap 1","step":0,"path":[{"p":[-2.618,0.607,0.087],"e":[-0.0,0.0,1.5708]},{"p":[-0.141,0.607,0.087],"e":[-0.0,0.0,1.5708]}]},{"key":"aluminum_arm_wedge_5mm","name":"Arm Wedge 2","step":1,"path":[{"p":[1.421,0.553,0.087],"e":[0.0,1.5708,0.0]},{"p":[0.529,0.553,0.087],"e":[0.0,1.5708,0.0]}]},{"key":"screw_m3x16_socket_cap","name":"M3×16 Cap 2","step":1,"path":[{"p":[2.608,0.607,0.087],"e":[0.0,0.0,-1.5708]},{"p":[0.131,0.607,0.087],"e":[0.0,0.0,-1.5708]}]},{"key":"aluminum_x_lock","name":"X-Lock","step":2,"path":[{"p":[-0.005,1.437,0.078],"e":[-0.0,0.0,-0.0]},{"p":[-0.005,0.545,0.078],"e":[-0.0,0.0,-0.0]}]},{"key":"split_rear_plate","name":"Rear Plate","step":3,"path":[{"p":[-0.005,-0.396,0.748],"e":[-0.0,0.0,-0.0]},{"p":[-0.005,0.495,0.748],"e":[-0.0,0.0,-0.0]}]},{"key":"screw_m3x22_pan","name":"M3×22 1","step":4,"path":[{"p":[0.378,1.283,0.538],"e":[-1.5708,0.0,0.0]},{"p":[0.378,0.391,0.538],"e":[-1.5708,0.0,0.0]}]},{"key":"screw_m3x22_pan","name":"M3×22 2","step":5,"path":[{"p":[-0.388,1.283,0.538],"e":[-1.5708,0.0,0.0]},{"p":[-0.388,0.391,0.538],"e":[-1.5708,0.0,0.0]}]},{"key":"screw_m3x22_pan","name":"M3×22 3","step":5,"path":[{"p":[-0.388,1.283,-0.227],"e":[-1.5708,0.0,0.0]},{"p":[-0.388,0.391,-0.227],"e":[-1.5708,0.0,0.0]}]},{"key":"screw_m3x22_pan","name":"M3×22 4","step":6,"path":[{"p":[0.378,1.283,-0.227],"e":[-1.5708,0.0,0.0]},{"p":[0.378,0.391,-0.227],"e":[-1.5708,0.0,0.0]}]},{"key":"arm_5in","name":"Arm 1","step":7,"path":[{"p":[1.396,1.437,1.155],"e":[-0.0,0.9599,-0.0]},{"p":[1.396,0.545,1.155],"e":[-0.0,0.9599,-0.0]}]},{"key":"arm_5in","name":"Arm 2","step":8,"path":[{"p":[1.396,1.555,-0.991],"e":[-3.1416,0.9599,-0.0]},{"p":[1.396,0.663,-0.991],"e":[-3.1416,0.9599,-0.0]}]},{"key":"arm_5in","name":"Arm 3","step":9,"path":[{"p":[-1.317,1.437,-1.074],"e":[-3.1416,-0.8727,-3.1416]},{"p":[-1.317,0.545,-1.074],"e":[-3.1416,-0.8727,-3.1416]}]},{"key":"arm_5in","name":"Arm 4","step":10,"path":[{"p":[-1.396,1.56,1.159],"e":[-0.0,-0.9599,3.1416]},{"p":[-1.396,0.669,1.159],"e":[-0.0,-0.9599,3.1416]}]},{"key":"split_front_plate","name":"Front Plate","step":11,"path":[{"p":[-0.005,1.56,-0.537],"e":[-0.0,0.0,-0.0]},{"p":[-0.005,0.669,-0.537],"e":[-0.0,0.0,-0.0]}]},{"key":"screw_m3x6_pan","name":"M3×6","step":12,"path":[{"p":[-0.005,1.474,0.087],"e":[-0.0,0.0,-0.0]},{"p":[-0.005,0.582,0.087],"e":[-0.0,0.0,-0.0]}]},{"key":"screw_m3x16_pan","name":"M3×16 1","step":13,"path":[{"p":[0.362,1.227,-0.568],"e":[-0.0,0.0,-0.0]},{"p":[0.362,0.336,-0.568],"e":[-0.0,0.0,-0.0]}]},{"key":"knurled_standoff","name":"Standoff 1","step":14,"path":[{"p":[0.362,-0.644,-0.636],"e":[1.5708,0.0,-0.0]},{"p":[0.362,0.248,-0.636],"e":[1.5708,0.0,-0.0]}]},{"key":"screw_m3x16_pan","name":"M3×16 2","step":15,"path":[{"p":[0.362,1.227,0.743],"e":[-0.0,0.0,-0.0]},{"p":[0.362,0.336,0.743],"e":[-0.0,0.0,-0.0]}]},{"key":"knurled_standoff","name":"Standoff 2","step":16,"path":[{"p":[0.362,-0.644,0.675],"e":[1.5708,0.0,-0.0]},{"p":[0.362,0.248,0.675],"e":[1.5708,0.0,-0.0]}]},{"key":"screw_m3x16_pan","name":"M3×16 3","step":17,"path":[{"p":[-0.372,1.227,0.743],"e":[-0.0,0.0,-0.0]},{"p":[-0.372,0.336,0.743],"e":[-0.0,0.0,-0.0]}]},{"key":"knurled_standoff","name":"Standoff 3","step":18,"path":[{"p":[-0.372,-0.644,0.675],"e":[1.5708,0.0,-0.0]},{"p":[-0.372,0.248,0.675],"e":[1.5708,0.0,-0.0]}]},{"key":"screw_m3x16_pan","name":"M3×16 4","step":19,"path":[{"p":[-0.372,1.227,-0.568],"e":[-0.0,0.0,-0.0]},{"p":[-0.372,0.336,-0.568],"e":[-0.0,0.0,-0.0]}]},{"key":"knurled_standoff","name":"Standoff 4","step":20,"path":[{"p":[-0.372,-0.644,-0.636],"e":[1.5708,0.0,-0.0]},{"p":[-0.372,0.248,-0.636],"e":[1.5708,0.0,-0.0]}]}]};

  var btn = document.getElementById('btnAnswer');
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
    root = new THREE.Group();
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
    if (t >= maxT - 0.01) {
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
      if (t >= maxT) { t = maxT; setPlaying(false); }
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

  /* 测试 / 调试入口 */
  window.KBAnswer = {
    seekStep: function (i) { t = stepEnd[i]; setPlaying(false); render(); },
    info: function () {
      return { active: !!root, t: t, maxT: maxT, playing: playing,
        steps: stepEnd.length,
        placed: items.filter(function (it) { return t >= it.start + DUR; }).length };
    }
  };
})();
