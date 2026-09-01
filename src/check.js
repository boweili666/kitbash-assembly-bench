/* ============================================================
 * Checks — 装配失败检测(对照标准答案)
 *
 * 每次场景变化后:以后板为基准把答案位姿对齐到用户装配,逐槽位比对 →
 *   完成度评分 · 放错孔位 / 位置偏差 · 用错零件(同族零件间,如 M3×16 放到 M3×22 位)
 *   · 螺丝方向装反(头朝向与答案相反)· 装配顺序(X-Lock → 机臂 → 前板)
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var btn = document.getElementById('btnCheck');
  var panel = document.getElementById('checkPanel');
  if (!btn || !panel) return;

  var elScore = document.getElementById('ckScore');
  var elBar = document.getElementById('ckBar');
  var elList = document.getElementById('ckList');
  var elNow = document.getElementById('ckNow');
  var elClose = document.getElementById('ckClose');

  var POS_TOL = 0.08, ANG_TOL = 12, NEAR = 0.5, NEAR_ANG = 45;   // 世界单位 / 度
  // 顺序硬依赖:X-Lock → 机臂 → 前板(后板是对齐基准、楔块装在 X-Lock 侧面,不参与)
  var STRUCT = { aluminum_x_lock: 1, arm_5in: 1, split_front_plate: 1 };
  var REVOLVE = { screw_m3x6_pan: 1, screw_m3x16_pan: 1, screw_m3x16_socket_cap: 1, screw_m3x22_pan: 1, knurled_standoff: 1 };
  var SCREW = { screw_m3x6_pan: 1, screw_m3x16_pan: 1, screw_m3x16_socket_cap: 1, screw_m3x22_pan: 1 };
  function family(key) { return key.indexOf('screw_') === 0 ? 'screw' : key.indexOf('split_') === 0 ? 'plate' : key; }

  var results = null;

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
  /* 回转件:比较轴向。螺丝有头 → 用"杆→头"的有向向量(能识别装反);螺柱对称 → 无向 */
  function axisAngle(key, qa, qb) {
    var spec = KBParts.spec(key);
    var pegs = (spec && spec.pegs) || [];
    if (SCREW[key] && pegs.length >= 2) {
      var shaft = pegs[0], head = pegs[0];
      pegs.forEach(function (p) { if (p.r < shaft.r) shaft = p; if (p.r > head.r) head = p; });
      var v = new THREE.Vector3().fromArray(head.c).sub(new THREE.Vector3().fromArray(shaft.c));
      if (v.lengthSq() < 1e-8) v = new THREE.Vector3().fromArray(shaft.d);
      v.normalize();
      var a = v.clone().applyQuaternion(qa), b = v.clone().applyQuaternion(qb);
      return { deg: THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1))), signed: true };
    }
    var f = pegs[0] || (spec && spec.holes && spec.holes[0]);
    if (!f) return { deg: angleBetween(qa, qb), signed: false };
    var d = new THREE.Vector3().fromArray(f.d);
    var va = d.clone().applyQuaternion(qa), vb = d.clone().applyQuaternion(qb);
    return { deg: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(va.dot(vb))))), signed: false };
  }

  function evaluate() {
    if (!(window.KBParts && KBParts.ready() && window.KBAnswer)) return;
    var parts = collectParts();
    var slots = KBAnswer.poses();
    var anchorKey = 'split_rear_plate';
    var userPlate = null, plateSlot = null;
    parts.forEach(function (n) { if (!userPlate && n.userData.kbType === 'part:' + anchorKey) userPlate = n; });
    slots.forEach(function (s) { if (!plateSlot && s.key === anchorKey) plateSlot = s; });
    if (!userPlate || !plateSlot) {
      results = { ready: false, issues: [], correct: 0, total: slots.length, note: 'Load the kit (needs the Rear Plate as reference)' };
      render();
      return;
    }
    userPlate.updateMatrixWorld(true);
    var T = new THREE.Matrix4().multiplyMatrices(userPlate.matrixWorld, slotMatrix(plateSlot.p, plateSlot.e).invert());

    var targets = slots.map(function (s) {
      var M = new THREE.Matrix4().multiplyMatrices(T, slotMatrix(s.p, s.e));
      var pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      M.decompose(pos, q, sc);
      return { slot: s, pos: pos, q: q, part: null, err: null, ok: false };
    });
    var partInfo = parts.map(function (n) {
      n.updateMatrixWorld(true);
      var pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      n.matrixWorld.decompose(pos, q, sc);
      return { node: n, key: n.userData.kbType.slice(5), pos: pos, q: q, slot: null };
    });

    // 贪心分配:同类零件按位置误差最近;姿态大致对(或位置很准)才算"放在这里"
    targets.forEach(function (t) {
      var best = null;
      partInfo.forEach(function (pi) {
        if (pi.slot || pi.key !== t.slot.key) return;
        var d = pi.pos.distanceTo(t.pos);
        if (!best || d < best.d) best = { pi: pi, d: d };
      });
      if (!best || best.d >= NEAR) return;
      var ang = REVOLVE[t.slot.key] ? axisAngle(t.slot.key, best.pi.q, t.q) : { deg: angleBetween(best.pi.q, t.q), signed: false };
      var reversed = ang.signed && ang.deg > 90;
      var nearAng = reversed ? (180 - ang.deg) : ang.deg;   // 装反的螺丝轴线仍对得上,只是头朝向相反
      if (best.d < POS_TOL || nearAng < NEAR_ANG) {
        t.part = best.pi; best.pi.slot = t;
        t.err = { d: best.d, ang: ang.deg, reversed: reversed };
        t.ok = best.d < POS_TOL && !reversed && ang.deg < ANG_TOL;
      }
    });

    var issues = [], correct = 0;
    var us = KBParts.unitScale();
    var mm = function (w) { return (w / us * 1000).toFixed(1); };
    targets.forEach(function (t) {
      if (t.part && t.ok) { correct += 1; return; }
      if (t.part) {
        if (t.err.reversed) {
          issues.push({ severity: 'error', node: t.part.node,
            msg: t.slot.name + ' is inserted backwards — the head faces the wrong way' });
        } else if (t.err.d >= POS_TOL) {
          issues.push({ severity: 'warn', node: t.part.node,
            msg: t.slot.name + ' is in the wrong hole / position: off by ' + mm(t.err.d) + ' mm' });
        } else {
          issues.push({ severity: 'warn', node: t.part.node,
            msg: t.slot.name + ' is tilted ' + t.err.ang.toFixed(0) + '° from its slot' });
        }
        return;
      }
      var wrong = null;   // 槽位空着:同族的别种零件占了这个位置 → 用错零件
      partInfo.forEach(function (pi) {
        if (pi.key === t.slot.key || family(pi.key) !== family(t.slot.key)) return;
        var d = pi.pos.distanceTo(t.pos);
        if (d < POS_TOL * 1.5 && (!wrong || d < wrong.d)) wrong = { pi: pi, d: d };
      });
      if (wrong) {
        issues.push({ severity: 'error', node: wrong.pi.node,
          msg: 'Wrong part at ' + t.slot.name + '’s slot: found ' + wrong.pi.node.name + ', expected ' + t.slot.name });
      }
    });

    targets.filter(function (t) { return t.ok && STRUCT[t.slot.key]; }).forEach(function (t) {
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

  function render() {
    if (results && results.ready) {
      elScore.textContent = results.correct + ' / ' + results.total + ' parts in place';
      elBar.style.width = (results.correct / results.total * 100) + '%';
      elBar.className = 'ck-bar ' + (results.correct === results.total ? 'done' : '');
    } else {
      elScore.textContent = results && results.note ? results.note : 'Not evaluated yet';
      elBar.style.width = '0%';
    }
    var all = results ? results.issues : [];
    elList.innerHTML = '';
    if (!all.length) {
      var ok = document.createElement('div');
      ok.className = 'ck-empty';
      ok.textContent = results && results.ready ? 'No issues detected' : 'Place parts — problems show up here';
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
    btn.classList.toggle('has-errors', all.some(function (i) { return i.severity === 'error'; }));
  }

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
    evaluate: function () { evaluate(); return results; },
    results: function () { return results; }
  };
})();
