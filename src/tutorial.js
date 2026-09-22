/* ============================================================
 * 新手教程 — 几个小课,每课两个零件,做完一课自动换下一课的零件
 *
 *   课 1「绕孔转」:机臂 + 前板 —— 选中机臂 → 机臂孔套到前板孔上(孔对孔)→ ←→ 绕孔转
 *   课 2「插入」  :楔块 + 螺丝 —— 选中螺丝、点螺丝杆 P1 → 点楔块的孔(销入孔)→ ↑↓ 沿孔推拉
 *   要点的孔口会聚光;点错了拒绝并提示该点哪个。做对了自动进下一步,也可以 Skip。
 *   顶栏 Tutorial 按钮或 ?tutorial=1 启动;× 退出。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var HL = 0x3d7be8; // 蓝色高亮:这一步要碰的零件

  var el = document.getElementById('tutorial');
  var barEl = el.querySelector('.tt-bar i');
  var bodyEl = el.querySelector('.tt-body');
  var stepEl = el.querySelector('.tt-step');
  var textEl = el.querySelector('.tt-text');
  var hintEl = el.querySelector('.tt-hint');
  var nextBtn = document.getElementById('ttNext');
  var closeBtn = document.getElementById('ttClose');

  var stageEl = el.querySelector('.tt-stage');
  var inputsEl = el.querySelector('.tt-inputs');
  var actionsEl = el.querySelector('.tt-actions');
  var statusEl = el.querySelector('.tt-status');
  var advanceTimer = 0;
  var introTimers = [];
  var completed = {};
  var onboarding = false;
  var currentSelection = [];

  var parts = null;   // 当前课的零件 {arm, plate} / {wedge, screw}
  var idx = -1;
  var timer = 0;
  var lit = [];
  var flags = {};     // 事件观察:本步开始后发生过什么

  /* ---------- 课程:每课自己的零件、镜头、步骤 ---------- */
  function o(key, name, p, r) {
    return { id: KB.newId(), name: name, type: 'part:' + key, p: p, r: r || [0, 0, 0], s: [1, 1, 1] };
  }
  var VIEW = { p: [2.6, 3.8, 5.4], t: [-0.3, 0.3, 0.5] };
  var courses = [
    {
      name: 'Turn on a hole', names: { arm: 'Arm', plate: 'Front Plate' },
      scene: function () {
        return [o('split_front_plate', 'Front Plate', [0.4, 0, -0.6]), o('arm_5in', 'Arm', [-0.6, 0, 2.2], [0, Math.PI / 2, 0])];
      },
      steps: [
        { tag: 'select', light: function () { return [parts.arm]; },
          done: function () { return flags.selected === parts.arm; },
          lesson: { title: 'Meet your first part', hint: 'The glowing arm is your target. A single click selects it and reveals its hole.',
            demo: 'select', label: 'Click to select', target: 'Arm', actions: ['Find the glowing arm', 'Left-click it once'] } },
        { tag: 'move', light: function () { return [parts.arm]; },
          done: function () { return flags.placed === parts.arm; },
          lesson: { title: 'Move it closer', hint: 'The selected part flies to the spot you click on the grid. Its height stays the same; \u2191 / \u2193 raise or lower it.',
            demo: 'move', label: 'Click an empty spot', target: 'Arm', actions: ['Keep the arm selected', 'Left-click an empty spot on the grid near the plate'] } },
        { tag: 'mateArm', light: function () { return [parts.arm, parts.plate]; },
          expect: function () { return { source: [{ node: parts.arm, id: 'H1', end: -1 }], target: [{ node: parts.plate, id: 'H6', end: 1 }] }; },
          done: function () { return flags.mate && flags.mate[0] === parts.arm && flags.mate[1] === parts.plate; },
          lesson: { title: 'Set the arm on the plate', hint: 'The two glowing discs will touch: the LOWER disc of the arm hole and the TOP disc of the plate hole. Tilt the view a little to reach the lower one.',
            demo: 'mate', label: 'Click source \u2192 click target', target: 'Plate hole', actions: ['Click the glowing LOWER disc of the arm hole', 'Click the glowing disc on the plate'] } },
        { tag: 'turn', light: function () { return [parts.arm]; },
          done: function () { return Math.abs(flags.turned || 0) >= 10; },
          lesson: { title: 'Turn it on the hole', hint: 'The arm is locked on that hole. \u2190 / \u2192 turn it around the hole, 1\u00b0 a press (Shift = 90\u00b0). Turn it at least 10\u00b0.',
            demo: 'adjust', label: 'Turn \u2190 \u2192', target: 'Arm', actions: ['Hold \u2190 or \u2192 (1\u00b0 a press, Shift = 90\u00b0)', 'Watch the arm swing around the hole'] } }
      ]
    },
    {
      name: 'Insert a screw', names: { wedge: 'Wedge', screw: 'Screw' },
      view: { p: [1.7, 1.9, 2.8], t: [0.6, 0.1, 0.3] }, // 小零件,镜头凑近
      scene: function () {
        return [o('aluminum_arm_wedge_5mm', 'Wedge', [0, 0, 0]), o('screw_m3x16_socket_cap', 'Screw', [1.4, 0, 0.9])]; // 楔块平放,孔是横着的:螺丝横着插进去
      },
      steps: [
        { tag: 'armScrew', light: function () { return [parts.screw]; },
          expect: function () { return { source: [{ node: parts.screw, id: 'P1', end: 0 }], target: [] }; },
          done: function () { var a = KBMate.armed(); return !!a && a.node === parts.screw && a.id === 'P1'; },
          lesson: { title: 'New parts: a screw and a wedge', hint: 'Click the screw to select it, then click the glowing disc on its shaft. Green means ready to connect.',
            demo: 'arm', label: 'Click the shaft disc', target: 'Screw', actions: ['Click the glowing screw', 'Click the glowing disc on its shaft'] } },
        { tag: 'mateScrew', light: function () { return [parts.wedge]; },
          expect: function () { return { source: [{ node: parts.screw, id: 'P1', end: 0 }], target: [{ node: parts.wedge, id: 'H1' }] }; },
          done: function () { return flags.mate && flags.mate[0] === parts.screw && flags.mate[1] === parts.wedge; },
          lesson: { title: 'Feed it through the wedge', hint: 'Click the glowing disc on the wedge\u2019s hole. The screw flies over, lines up with the hole and slides in sideways.',
            demo: 'insert', label: 'Click the wedge hole', target: 'Wedge hole', actions: ['Keep the shaft disc armed (green)', 'Click the glowing disc on the wedge'] } },
        { tag: 'slide', light: function () { return [parts.screw]; },
          done: function () { return !!flags.slide; },
          lesson: { title: 'Push and pull', hint: 'The screw is locked in that hole. \u2191 / \u2193 slide it along the hole (Shift = fine steps).',
            demo: 'adjust', label: 'Slide \u2191 \u2193', target: 'Screw', actions: ['Press \u2191 or \u2193', 'Watch the screw move along the hole'] } }
      ]
    }
  ];
  var FINAL = { light: function () { return []; }, done: function () { return false; },
    lesson: { title: 'You\u2019ve got the basics', hint: 'Select a part, click its hole, click the receiving hole. Arrow keys fine-tune on the hole. Use Kit to try the full assembly.',
      demo: 'complete', label: 'Ready for the full assembly', target: '', actions: ['Click a part to select', 'Click hole \u2192 hole to assemble', 'Use arrow keys to adjust the fit'] } };
  // 展平:steps[i] 带 course 索引;换课时重建场景
  var steps = [], lessons = [];
  courses.forEach(function (c, ci) { c.steps.forEach(function (st) { st.course = ci; steps.push(st); lessons.push(st.lesson); }); });
  FINAL.course = courses.length - 1;
  steps.push(FINAL); lessons.push(FINAL.lesson);
  var course = -1; // 当前已加载场景的课
  function at(tag) { return idx >= 0 && steps[idx].tag === tag; }

  function find(name) {
    var f = null;
    KB.objectsRoot.traverse(function (n) { if (!f && KB.isPart(n) && n.name === name) f = n; });
    return f;
  }

  function light(nodes) {
    unlight();
    nodes.forEach(function (n) { if (n) { KB.highlight(n, HL); lit.push(n); } });
  }
  function unlight() {
    lit.forEach(function (n) { KB.highlight(n, null); });
    lit = [];
  }
  // 高亮零件呼吸脉动
  (function pulse() {
    requestAnimationFrame(pulse);
    if (!lit.length) return;
    var k = KB.reducedMotion ? 0.55 : 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(performance.now() / 260));
    lit.forEach(function (n) {
      n.traverse(function (o) { if (o.isMesh && o.material && o.material.emissive) o.material.emissiveIntensity = k; });
    });
  })();

  function renderDemo() {
    var lesson = lessons[idx];
    var mode = lesson.demo;
    el.dataset.demo = mode;
    var firstCourse = steps[idx].course === 0;
    KBTutorialPreview.show(stageEl, {
      tag: steps[idx].tag || 'complete', course: steps[idx].course,
      label: lesson.label, objects: courses[steps[idx].course].scene(),
      source: firstCourse ? { name: 'Arm', id: 'H1', end: -1 } : { name: 'Screw', id: 'P1', end: 0 },
      target: firstCourse ? { name: 'Front Plate', id: 'H6', end: 1 } : { name: 'Wedge', id: 'H1', end: 1 }
    });
    KBTutorialPreview.pause(el.classList.contains('minimized'));
    inputsEl.innerHTML = mode === 'adjust' ?
      '<div class="tt-keyboard ' + (at('turn') ? 'tt-turn-keys' : 'tt-slide-keys') + '" aria-hidden="true"><kbd class="tt-key-up">↑</kbd><div><kbd class="tt-key-left">←</kbd><kbd class="tt-key-down">↓</kbd><kbd class="tt-key-right">→</kbd></div></div><div><strong>' + lesson.label + '</strong><small>' + (at('turn') ? 'Turn the arm around its hole' : 'Slide the screw along its axis') + '</small></div>' :
      mode === 'complete' ? '<span class="tt-finish-icon">✓</span><div><strong>' + lesson.label + '</strong><small>Esc · deselect &nbsp; Ctrl / ⌘ Z · undo</small></div>' :
      '<div class="tt-mouse" aria-hidden="true"><i></i><b></b></div><div><strong>' + lesson.label + '</strong><small>Left mouse button · one click at a time</small></div>';
  }

  function updateActions() {
    var selected = currentSelection.length === 1 ? currentSelection[0] : null;
    var armed = window.KBMate && KBMate.armed();
    var checks = [];
    var mated = function (a, b) { return !!flags.mate && flags.mate[0] === a && flags.mate[1] === b; };
    if (at('select')) checks = [selected === parts.arm, selected === parts.arm];
    if (at('move')) checks = [selected === parts.arm || flags.placed === parts.arm, flags.placed === parts.arm];
    if (at('mateArm')) checks = [!!armed && armed.node === parts.arm && armed.end === -1 || mated(parts.arm, parts.plate), mated(parts.arm, parts.plate)];
    if (at('turn')) checks = [!!flags.turn, Math.abs(flags.turned || 0) >= 10];
    if (at('armScrew')) checks = [selected === parts.screw || !!armed && armed.node === parts.screw, !!armed && armed.node === parts.screw];
    if (at('mateScrew')) checks = [!!armed && armed.node === parts.screw || mated(parts.screw, parts.wedge), mated(parts.screw, parts.wedge)];
    if (at('slide')) checks = [!!flags.slide, !!flags.slide];
    // 本步已完成:全部打勾
    if (idx >= 0 && idx < steps.length - 1 && steps[idx].done()) checks = checks.map(function () { return true; });
    var current = checks.indexOf(false);
    if (current < 0) current = checks.length;
    Array.prototype.forEach.call(actionsEl.children, function (item, n) {
      item.classList.toggle('checked', !!checks[n]);
      item.classList.toggle('current', n === current && idx < steps.length - 1);
      item.querySelector('span').textContent = checks[n] ? '✓' : n + 1;
    });
  }

  function loadCourse(ci) {
    course = ci;
    var c = courses[ci];
    parts = null; // 换场景期间 onChange 看不到旧零件,别把教程当成"零件被删了"而结束
    KB.setSelection([]);
    KB.loadSceneData({ objects: c.scene() }, true);
    KB.pushSnapshot();
    parts = {};
    Object.keys(c.names).forEach(function (k) { parts[k] = find(c.names[k]); });
    var v = c.view || VIEW;
    KB.flyCamera(v.p, v.t);
    dropIn(Object.keys(parts).map(function (k) { return parts[k]; }));
  }
  // 零件依次从空中落到桌面
  function dropIn(nodes) {
    introTimers.forEach(function (intro) { clearTimeout(intro.timer); });
    introTimers = [];
    nodes.forEach(function (n, i) {
      var rest = n.position.clone();
      if (KB.reducedMotion) return;
      n.position.y += 2.2;
      n.updateMatrixWorld(true);
      var intro = { node: n, rest: rest, pending: true };
      intro.timer = setTimeout(function () { intro.pending = false; KB.tween(n, rest, n.quaternion, { duration: 0.55 }); }, 250 + i * 160);
      introTimers.push(intro);
    });
  }

  function show(i) {
    clearTimeout(advanceTimer);
    if (steps[i].course !== course) loadCourse(steps[i].course);
    clearTimeout(errTimer);
    statusEl.classList.remove('err');
    statusEl.classList.remove('warn');
    advancing = false;
    textEl.classList.remove('ok');
    idx = i;
    flags = {};
    var s = steps[i];
    stepEl.textContent = 'Lesson ' + (steps[i].course + 1) + ' \u00b7 ' + (i + 1) + ' / ' + steps.length;
    textEl.textContent = lessons[i].title;
    hintEl.textContent = lessons[i].hint;
    renderDemo();
    actionsEl.innerHTML = lessons[i].actions.map(function (action, n) {
      return '<li><span>' + (n + 1) + '</span><div>' + action + '</div></li>';
    }).join('');
    updateActions();
    statusEl.textContent = i === steps.length - 1 ? Object.keys(completed).length + ' / ' + (steps.length - 1) + ' steps practiced'
      : courses[steps[i].course].name + ' \u00b7 your turn';
    el.querySelector('.tt-bar').setAttribute('aria-valuenow', i + 1);
    nextBtn.textContent = i === steps.length - 1 ? (onboarding ? 'Start assembly →' : 'Finish ✓') : 'Skip step →';
    barEl.style.width = ((i + 1) / steps.length * 100) + '%';
    el.classList.toggle('done', i === steps.length - 1);
    // 文字滑入
    bodyEl.classList.remove('in');
    void bodyEl.offsetWidth;
    bodyEl.classList.add('in');
    light(s.light());
    applyExpect(s.expect ? s.expect() : null);
    if (s.view) KB.flyCamera(s.view.p, s.view.t);
  }

  /* ---------- 要点的孔口聚光;点错了拒绝并说明该点哪个 ---------- */
  // 不提 H1 / P1 这类编号(general 模式看不到):只说"哪个零件上的哪一面的亮圈"
  function describe(x) {
    var side = x.end === -1 ? 'lower ' : x.end === 1 ? 'top ' : '';
    return 'the ' + side + 'glowing disc on the ' + x.node.name;
  }
  function describeAny(x) {
    var side = x.end === -1 ? 'lower ' : x.end === 1 ? 'top ' : '';
    return 'the ' + side + 'disc on the ' + x.node.name;
  }
  function matches(x, i) { return x.node === i.node && x.id === i.id && (x.end === undefined || x.end === i.end); }
  function applyExpect(exp) {
    if (!window.KBMate) return;
    if (!exp) { KBMate.spotlight([]); KBMate.setGuard(null); return; }
    KBMate.spotlight(exp.source.concat(exp.target));
    KBMate.setGuard({
      arm: function (i) {
        if (exp.source.some(function (x) { return matches(x, i); })) return true;
        // 已经拿着正确的源,再点别的孔口 → 也拒绝(不换源)
        return 'Not that one. Click ' + exp.source.map(describe).join(' or ') + '.';
      },
      mate: function (src, dst) {
        if (!exp.target.length) return 'Not yet \u2014 first ' + lessons[idx].actions[0].toLowerCase() + '.';
        if (!exp.source.some(function (x) { return matches(x, src); })) {
          return 'Wrong source. Start again from ' + exp.source.map(describe).join(' or ') + '.';
        }
        if (exp.target.some(function (x) { return matches(x, dst); })) return true;
        return 'Wrong hole \u2014 that is ' + describeAny(dst) + '. Click ' + exp.target.map(describe).join(' or ') + '.';
      }
    });
  }
  KB.on('mateRejected', function (r) {
    if (idx < 0) return;
    statusEl.textContent = r.reason;
    statusEl.classList.add('err');
    clearTimeout(errTimer);
    errTimer = setTimeout(function () { if (idx >= 0 && !advancing) { statusEl.classList.remove('err'); statusEl.textContent = 'Your turn \u00b7 try it in the scene'; } }, 4000);
  });
  var errTimer = 0;

  var advancing = false;
  function tick() {
    if (idx < 0 || advancing) return;
    updateActions();
    if (steps[idx].status && !statusEl.classList.contains('err')) {
      var st = steps[idx].status();
      statusEl.textContent = st || 'Your turn \u00b7 try it in the scene';
      statusEl.classList.toggle('warn', !!st);
    }
    if (!steps[idx].done()) return;
    advancing = true;
    updateActions();
    textEl.classList.add('ok');
    completed[idx] = true;
    statusEl.textContent = 'Nice work! Moving to the next step…';
    var at = idx;
    advanceTimer = setTimeout(function () {
      advancing = false;
      textEl.classList.remove('ok');
      if (idx === at && idx < steps.length - 1) show(idx + 1);
    }, 700);
  }

  function start(opts) {
    if (!window.KBParts || !KBParts.ready()) { KB.toast('Parts library still loading…'); return; }
    stop('restart');
    onboarding = !!(opts && opts.onboarding);
    completed = {};
    if (KB.setExpert) KB.setExpert(false);
    course = -1;
    // 开场:相机从高处俯冲进来(show(0) 会加载第一课的零件并让它们落下)
    KB.camera.position.set(VIEW.p[0] * 2.2, VIEW.p[1] * 2.6, VIEW.p[2] * 2.2);
    KB.orbit.target.fromArray(VIEW.t);
    el.classList.remove('minimized');
    document.getElementById('ttMinimize').setAttribute('aria-expanded', 'true');
    document.getElementById('ttMinimize').setAttribute('aria-label', 'Minimize tutorial');
    document.getElementById('ttMinimize').textContent = '−';
    el.classList.add('show');
    show(0);
    clearInterval(timer);
    timer = setInterval(tick, 150);
  }

  function stop(reason) {
    var wasActive = idx >= 0;
    KBTutorialPreview.stop();
    clearTimeout(advanceTimer);
    introTimers.forEach(function (intro) {
      clearTimeout(intro.timer);
      if (intro.pending) { intro.node.position.copy(intro.rest); intro.node.updateMatrixWorld(true); }
    });
    introTimers = [];
    advancing = false;
    clearInterval(timer);
    timer = 0;
    idx = -1;
    unlight();
    applyExpect(null);
    statusEl.classList.remove('err');
    el.classList.remove('show');
    if (wasActive && reason !== 'restart') KB.emit('tutorialEnd', { reason: reason === 'completed' ? 'completed' : 'skipped' });
  }

  /* ---------- 观察 ---------- */
  KB.onSelection(function (sel) { currentSelection = sel.slice(); if (idx >= 0 && sel.length === 1) flags.selected = sel[0]; });
  // Registered before mate.js: observe the key before its capture handler consumes it.
  // The place event confirms that a key actually moved the tutorial screw.
  var activeArrow = null, lastShift = false;
  window.addEventListener('keydown', function (e) {
    if (!(at('turn') || at('slide')) || !/^Arrow(Up|Down|Left|Right)$/.test(e.code) || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    activeArrow = e.code;
    lastShift = e.shiftKey;
    setTimeout(function () { activeArrow = null; }, 0);
  }, true);
  KB.on('place', function (node) {
    if (idx < 0) return;
    flags.placed = node;
    if (at('turn') && node === parts.arm && activeArrow && /Left|Right/.test(activeArrow)) {
      flags.turn = true;
      flags.turned = (flags.turned || 0) + (activeArrow === 'ArrowLeft' ? 1 : -1) * (lastShift ? 90 : 1);
    }
    if (at('slide') && node === parts.screw && activeArrow && /Up|Down/.test(activeArrow)) flags.slide = true;
  });
  KB.on('snapAttempt', function (a) { if (idx >= 0 && a.success) flags.mate = [a.object1, a.object2, a.snapPoint1, a.snapPoint2]; });
  KB.onChange(function () {
    // 零件被删掉 / 撤销到教程之前:结束
    if (idx >= 0 && parts && Object.keys(parts).some(function (k) { return !parts[k] || !find(parts[k].name); })) stop();
  });

  document.getElementById('ttReplay').addEventListener('click', function () { if (idx >= 0) renderDemo(); });
  document.getElementById('ttMinimize').addEventListener('click', function () {
    var minimized = el.classList.toggle('minimized');
    KBTutorialPreview.pause(minimized);
    this.setAttribute('aria-expanded', String(!minimized));
    this.setAttribute('aria-label', minimized ? 'Expand tutorial' : 'Minimize tutorial');
    this.textContent = minimized ? '+' : '−';
  });
  nextBtn.addEventListener('click', function () {
    if (idx >= steps.length - 1) stop('completed'); else show(Math.max(idx, 0) + 1);
  });
  closeBtn.addEventListener('click', stop);
  document.getElementById('btnTutorial').addEventListener('click', function () {
    if (el.classList.contains('show')) { stop(); return; }
    if (KB.objectsRoot.children.length &&
        !confirm('Start the tutorial? The current scene will be replaced (undoable).')) return;
    start();
  });

  window.KBTutorial = { start: start, stop: stop, active: function () { return idx >= 0; },
    _debug: function () { return { idx: idx, advancing: advancing, parts: Object.keys(parts || {}).map(function (k) { return k + ':' + (parts[k] && parts[k].name); }), timer: timer }; } };

  if (new URLSearchParams(location.search).has('tutorial')) {
    (function wait() { if (window.KBParts && KBParts.ready()) start(); else setTimeout(wait, 100); })();
  }
})();
