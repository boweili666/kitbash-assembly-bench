/* ============================================================
 * Checks — 装配失败检测(规则引擎)
 *
 * 实时规则(由 snap.js 上报):
 *   nofit   粗销进不了细孔(严格模式拒绝吸附;提示模式允许但标红)
 *   loose   松配合(⌀3 螺丝放进 ⌀5.5 孔)
 *   short / long  螺丝长度不对(杆尖进不到下一段孔 / 顶底)
 * 对照标准答案(每次场景变化后重算):
 *   以后板为基准把答案位姿对齐到用户装配,逐件比对 →
 *   完成度评分、放错孔位、用错零件、装配顺序错误
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var btn = document.getElementById('btnCheck');
  var panel = document.getElementById('checkPanel');
  if (!btn || !panel) return;

  var elMode = document.getElementById('ckMode');
  var elScore = document.getElementById('ckScore');
  var elBar = document.getElementById('ckBar');
  var elList = document.getElementById('ckList');
  var elNow = document.getElementById('ckNow');
  var elClose = document.getElementById('ckClose');

  var PREF = 'kitbash-checks-v1';
  var strictMode = true;
  try { var pref = JSON.parse(localStorage.getItem(PREF) || '{}'); if (pref.strict === false) strictMode = false; } catch (e) { /* 忽略 */ }
  elMode.value = strictMode ? 'strict' : 'warn';
  elMode.addEventListener('change', function () {
    strictMode = elMode.value === 'strict';
    try { localStorage.setItem(PREF, JSON.stringify({ strict: strictMode })); } catch (e) { /* 忽略 */ }
    KB.toast(strictMode ? 'Strict mode: incompatible parts refuse to snap' : 'Warn mode: mismatches snap but get flagged');
  });

  var POS_TOL = 0.08, ANG_TOL = 12, NEAR = 0.3, NEAR_ANG = 45;   // 世界单位 / 度
  // 顺序硬依赖:X-Lock → 机臂 → 前板(后板是对齐基准、楔块装在 X-Lock 侧面,不参与)
  var STRUCT = { aluminum_x_lock: 1, arm_5in: 1, split_front_plate: 1 };
  function family(key) { return key.indexOf('screw_') === 0 ? 'screw' : key.indexOf('split_') === 0 ? 'plate' : key; }
  var REVOLVE = { screw_m3x6_pan: 1, screw_m3x16_pan: 1, screw_m3x16_socket_cap: 1, screw_m3x22_pan: 1, knurled_standoff: 1 };

  var live = {};        // 实时问题:key → {issue, at}
  var results = null;   // 答案比对结果
  var LIVE_TTL = 6000;

  /* ---------- 实时问题上报(snap.js 调用) ---------- */
  function report(issue) {
    var key = issue.code + '|' + (issue.node ? issue.node.uuid : '');
    var now = performance.now();
    var prev = live[key];
    live[key] = { issue: issue, at: now };
    if (!prev || now - prev.at > 2500) {
      if (issue.severity === 'error' || issue.code === 'nofit') KB.toast('⚠ ' + issue.msg);
      btn.classList.add('warn');
      setTimeout(function () { btn.classList.remove('warn'); }, 1500);
    }
    render();
  }

  /* ---------- 对照标准答案 ---------- */
  function slotMatrix(p, e) {
    return new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(p),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2], 'XYZ')),
      new THREE.Vector3(1, 1, 1));
  }
  function collectParts() {
    var list = [];
    KB.scene.traverse(function (o) { if (KB.isPart(o) && !o.userData.kbPending) list.push(o); });
    return list;
  }
  function angleBetween(qa, qb) {
    var d = Math.abs(qa.dot(qb));
    return THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, d)));
  }
  function axisAngle(key, qa, qb) {
    var spec = KBParts.spec(key);
    var f = spec && ((spec.pegs && spec.pegs[0]) || (spec.holes && spec.holes[0]));
    if (!f) return angleBetween(qa, qb);
    var d = new THREE.Vector3().fromArray(f.d);
    var va = d.clone().applyQuaternion(qa), vb = d.clone().applyQuaternion(qb);
    return THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(va.dot(vb)))));
  }

  function evaluate() {
    if (!(window.KBParts && KBParts.ready() && window.KBAnswer)) return;
    var parts = collectParts();
    var slots = KBAnswer.poses();
    var anchorKey = 'split_rear_plate';
    var userPlate = null;
    parts.forEach(function (n) { if (!userPlate && n.userData.kbType === 'part:' + anchorKey) userPlate = n; });
    var plateSlot = null;
    slots.forEach(function (s) { if (!plateSlot && s.key === anchorKey) plateSlot = s; });
    if (!userPlate || !plateSlot) {
      results = { ready: false, issues: [], correct: 0, total: slots.length, note: 'Load the kit (needs the Rear Plate as reference)' };
      render();
      return;
    }
    userPlate.updateMatrixWorld(true);
    var T = new THREE.Matrix4().multiplyMatrices(userPlate.matrixWorld, slotMatrix(plateSlot.p, plateSlot.e).invert());

    // 每个答案槽位的世界目标位姿
    var targets = slots.map(function (s) {
      var M = new THREE.Matrix4().multiplyMatrices(T, slotMatrix(s.p, s.e));
      var pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      M.decompose(pos, q, sc);
      return { slot: s, pos: pos, q: q, part: null, err: null };
    });
    var partInfo = parts.map(function (n) {
      n.updateMatrixWorld(true);
      var pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      n.matrixWorld.decompose(pos, q, sc);
      return { node: n, key: n.userData.kbType.slice(5), pos: pos, q: q, slot: null };
    });

    // 贪心分配:同类零件按位置误差最近
    targets.forEach(function (t) {
      var best = null;
      partInfo.forEach(function (pi) {
        if (pi.slot || pi.key !== t.slot.key) return;
        var d = pi.pos.distanceTo(t.pos);
        if (!best || d < best.d) best = { pi: pi, d: d };
      });
      if (best && best.d < NEAR) {
        var ang = REVOLVE[t.slot.key] ? axisAngle(t.slot.key, best.pi.q, t.q) : angleBetween(best.pi.q, t.q);
        if (best.d < POS_TOL || ang < NEAR_ANG) { // 姿态也大致对才算"试图放这里"
          t.part = best.pi; best.pi.slot = t; t.err = { d: best.d, ang: ang };
          t.ok = best.d < POS_TOL && ang < ANG_TOL;
        }
      }
    });

    var issues = [], correct = 0;
    var us = KBParts.unitScale();
    var mm = function (w) { return (w / us * 1000).toFixed(1); };
    targets.forEach(function (t) {
      if (t.part && t.ok) { correct += 1; return; }
      if (t.part) {
        issues.push({ severity: 'warn', node: t.part.node,
          msg: t.slot.name + ' is misaligned: off by ' + mm(t.err.d) + ' mm / ' + t.err.ang.toFixed(0) + '° from its slot' });
        return;
      }
      // 槽位空着:是否有别的零件占了这个位置(用错零件)
      var wrong = null;
      partInfo.forEach(function (pi) {
        if (pi.key === t.slot.key || family(pi.key) !== family(t.slot.key)) return; // 只在同族零件间判错件
        var d = pi.pos.distanceTo(t.pos);
        if (d < POS_TOL * 1.5 && (!wrong || d < wrong.d)) wrong = { pi: pi, d: d };
      });
      if (wrong) {
        issues.push({ severity: 'error', node: wrong.pi.node,
          msg: 'Wrong part at ' + t.slot.name + '’s slot: found ' + wrong.pi.node.name + ', expected ' + t.slot.name });
      }
    });

    // 顺序:结构件已到位,但更早步骤的结构件还没到位
    var placedStruct = targets.filter(function (t) { return t.ok && STRUCT[t.slot.key]; });
    placedStruct.forEach(function (t) {
      targets.forEach(function (u) {
        if (u.ok || !STRUCT[u.slot.key] || u.slot.step >= t.slot.step) return;
        var key = 'order|' + t.slot.name;
        if (issues.some(function (i) { return i.key === key; })) return;
        issues.push({ key: key, severity: 'warn', node: t.part.node,
          msg: 'Out of order: ' + t.slot.name + ' (step ' + (t.slot.step + 1) + ') placed before ' +
            u.slot.name + ' (step ' + (u.slot.step + 1) + ': ' + KBAnswer.stepLabel(u.slot.step) + ')' });
      });
    });

    results = { ready: true, issues: issues, correct: correct, total: targets.length };
    render();
  }

  /* ---------- 渲染 ---------- */
  function render() {
    var now = performance.now();
    Object.keys(live).forEach(function (k) { if (now - live[k].at > LIVE_TTL) delete live[k]; });
    var liveIssues = Object.keys(live).map(function (k) { return live[k].issue; });

    if (results && results.ready) {
      elScore.textContent = results.correct + ' / ' + results.total + ' parts in place';
      elBar.style.width = (results.correct / results.total * 100) + '%';
      elBar.className = 'ck-bar ' + (results.correct === results.total ? 'done' : '');
    } else {
      elScore.textContent = results && results.note ? results.note : 'Not evaluated yet';
      elBar.style.width = '0%';
    }
    var all = liveIssues.concat(results ? results.issues : []);
    elList.innerHTML = '';
    if (!all.length) {
      var ok = document.createElement('div');
      ok.className = 'ck-empty';
      ok.textContent = results && results.ready ? 'No issues detected' : 'Snap parts with Ctrl — problems show up here';
      elList.appendChild(ok);
    }
    all.slice(0, 14).forEach(function (is) {
      var row = document.createElement('button');
      row.className = 'ck-row ' + (is.severity || 'error');
      row.innerHTML = '<span class="ck-dot"></span><span class="ck-text"></span>';
      row.querySelector('.ck-text').textContent = is.msg;
      row.title = 'Click to select the part';
      row.addEventListener('click', function () { if (is.node && is.node.parent) KB.setSelection([is.node]); });
      elList.appendChild(row);
    });
    var errs = all.filter(function (i) { return i.severity === 'error' || i.code === 'nofit'; }).length;
    btn.classList.toggle('has-errors', errs > 0);
  }
  setInterval(render, 1000);

  /* ---------- 触发 ---------- */
  var evalTimer = 0;
  KB.onChange(function () {
    clearTimeout(evalTimer);
    evalTimer = setTimeout(evaluate, 300);
  });
  elNow.addEventListener('click', evaluate);
  elClose.addEventListener('click', function () { panel.style.display = 'none'; });
  btn.addEventListener('click', function () {
    var open = panel.style.display === 'flex';
    panel.style.display = open ? 'none' : 'flex';
    if (!open) evaluate();
  });

  window.KBCheck = {
    strict: function () { return strictMode; },
    setStrict: function (v) { strictMode = !!v; elMode.value = strictMode ? 'strict' : 'warn'; },
    report: report,
    evaluate: function () { evaluate(); return results; },
    results: function () { return results; },
    liveIssues: function () { return Object.keys(live).map(function (k) { return live[k].issue; }); }
  };
})();
