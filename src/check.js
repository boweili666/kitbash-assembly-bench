/* ============================================================
 * Checks — 装配状态判定(对照任务图生成的参考装配)
 *
 * 判定基于场景状态,不是操作顺序:每次场景变化后整体重算。
 *  · 零件"到位" = 它相对于配合件(参考里同一步或更早步骤、与它装在一起的零件)
 *    的相对位姿与参考一致:3.2 mm / 12°,零件与配合件各自的旋转对称视为同一姿态。
 *    因为是相对判定,子装配在桌上任何地方拼都算,整体搬动也不影响。
 *  · 步骤完成 = 该步所有零件到位;available = 前置步骤全部完成;否则 blocked。
 *    顺序按任务图依赖(DAG),不是线性清单 —— 图允许的任何顺序都不算错。
 *  · 配对(哪个用户零件占哪个参考槽位):唯一零件直接对应;其余从已配对的配合件
 *    出发,按相对位姿吻合度传播;两个都没配对但互为配合的(楔块+螺丝)枚举零件对。
 *    相同零件因此可互换。
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

  var POS_TOL = 0.08, ANG_TOL = 12;      // 到位:场景单位(1 = 40.4 mm)→ 3.2 mm / 12°
  var NEAR = 0.5, NEAR_ANG = 45;         // 在配合件旁边但没到位:20 mm / 45°
  var PAIR_TOL = POS_TOL * 2;            // 两个都未配对的零件互相配上的门槛(没有锚,严一点)
  var REVOLVE = { screw_m3x6_pan: 1, screw_m3x16_pan: 1, screw_m3x16_socket_cap: 1, screw_m3x22_pan: 1,
    screw_m3x8_socket_cap: 1, knurled_standoff: 1, motor_nut_m5: 1, damper_m2: 1 };
  var SCREW = { screw_m3x6_pan: 1, screw_m3x16_pan: 1, screw_m3x16_socket_cap: 1, screw_m3x22_pan: 1, screw_m3x8_socket_cap: 1 };
  function family(key) { return key.indexOf('screw_') === 0 ? 'screw' : key.indexOf('split_') === 0 ? 'plate' : key; }
  // 暂不区分头型:M3×16 盘头 与 M3×16 杯头 视为同一种零件
  var SAME = { screw_m3x16_socket_cap: 'screw_m3x16_pan' };
  function canon(key) { return SAME[key] || key; }

  var results = null;

  function collectParts() {
    var list = [];
    KB.scene.traverse(function (o) { if (KB.isPart(o) && !o.userData.kbPending) list.push(o); });
    return list;
  }
  function angleBetween(qa, qb) {
    var d = Math.abs(qa.dot(qb));
    return THREE.MathUtils.radToDeg(2 * Math.acos(Math.min(1, d)));
  }
  /* 零件的对称等价变换列表(节点局部):S_k = T(c)·R_k·T(-c),含恒等 */
  var symCache = {};
  function symTransforms(key) {
    if (symCache[key]) return symCache[key];
    var spec = KBParts.spec(key);
    var list = [new THREE.Matrix4()];
    if (spec && spec.sym && spec.sym.length) {
      var c = new THREE.Vector3().fromArray(spec.sym_center || [0, 0, 0]);
      spec.sym.forEach(function (sy) {
        var R = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3().fromArray(sy.axis).normalize(), THREE.MathUtils.degToRad(sy.deg));
        list.push(new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z)));
      });
    }
    symCache[key] = list;
    return list;
  }

  /* 回转件:比较轴向。螺丝有头 → 用"杆→头"的有向向量(能识别装反);螺柱/螺母对称 → 无向 */
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

  /* ---------- 参考模型:每套答案数据建一次 ---------- */
  var ref = null;   // { source, slots:[{i,id,key,ckey,name,step,M,Minv,mates:[{slot,kind,features}]}], steps:[{i,id,name,requires,slots}] }

  // 答案位姿(mm,GLB 原点)→ 零件节点在参考场景中的世界矩阵(场景单位)
  function matrixOf(key, pose) {
    var t = KBParts.nodeTransform(key, pose);
    return new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(t.p),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(t.r[0], t.r[1], t.r[2], 'XYZ')),
      new THREE.Vector3(1, 1, 1));
  }
  function buildRef() {
    var a = KBParts.answer && KBParts.answer();
    if (!a) { ref = null; return false; }
    if (ref && ref.source === a) return true;
    var byId = {};
    var slots = a.parts.map(function (d, idx) {
      var M = matrixOf(d.key, d.path[d.path.length - 1]);
      var s = { i: idx, id: d.id, key: d.key, ckey: canon(d.key), name: d.name, step: d.step,
        M: M, Minv: M.clone().invert(), mates: [] };
      byId[d.id] = s;
      return s;
    });
    a.parts.forEach(function (d, idx) {
      (d.mates || []).forEach(function (m) {
        var ms = byId[m.id];
        if (ms) slots[idx].mates.push({ slot: ms, kind: m.kind, features: m.features || [] });
      });
    });
    var steps = a.steps.map(function (st) {
      return { i: st.i, id: st.id, name: st.name, requires: st.requires || [],
        slots: slots.filter(function (s) { return s.step === st.i; }) };
    });
    ref = { source: a, slots: slots, steps: steps, byId: byId };
    return true;
  }

  /* 槽位 t 的用户零件 u,相对于配合件(参考槽 m,用户零件 um)的位姿与参考相对位姿的偏差。
     用户:inv(M_um)·M_u;参考:inv(S_m)·inv(M_m)·M_t·S_t,取配合件对称 × 零件对称里最接近的一组。 */
  var _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  var _p2 = new THREE.Vector3(), _q2 = new THREE.Quaternion();
  function relError(t, u, m, um) {
    var Rref = new THREE.Matrix4().multiplyMatrices(m.Minv, t.M);
    var Ruser = new THREE.Matrix4().multiplyMatrices(um.Minv, u.M);
    Ruser.decompose(_p2, _q2, _s);
    var best = null;
    symTransforms(m.key).forEach(function (Sm) {
      var left = new THREE.Matrix4().multiplyMatrices(Sm.clone().invert(), Rref);
      symTransforms(t.key).forEach(function (St) {
        new THREE.Matrix4().multiplyMatrices(left, St).decompose(_p, _q, _s);
        var d = _p.distanceTo(_p2);
        var ang = REVOLVE[t.key] ? axisAngle(t.key, _q2, _q) : { deg: angleBetween(_q2, _q), signed: false };
        var reversed = ang.signed && ang.deg > 90;
        var nearAng = reversed ? 180 - ang.deg : ang.deg;
        var score = d + (reversed ? 0.02 : nearAng / 180 * 0.05);
        if (!best || score < best.score) best = { score: score, d: d, ang: ang.deg, reversed: reversed, nearAng: nearAng };
      });
    });
    return best;
  }
  function isNear(e) { return e.d < NEAR && (e.d < POS_TOL || e.nearAng < NEAR_ANG); }
  // 零件 GLB 原点在节点局部坐标里的位置(烘焙时 v' = S·(v − offset),所以原点在 −offset·S)
  function glbOrigin(key) {
    var spec = KBParts.spec(key), S = KBParts.unitScale();
    return spec ? new THREE.Vector3(-spec.offset[0] * S, -spec.offset[1] * S, -spec.offset[2] * S) : new THREE.Vector3();
  }
  function isOk(e) { return e.d < POS_TOL && !e.reversed && e.ang < ANG_TOL; }

  function evaluate() {
    if (!(window.KBParts && KBParts.ready() && buildRef())) {
      results = { ready: false, issues: [], correct: 0, total: 0, note: 'No reference assembly in the part library' };
      render();
      return;
    }
    var users = collectParts().map(function (n) {
      n.updateMatrixWorld(true);
      return { node: n, id: n.userData.kbId || null, key: n.userData.kbType.slice(5),
        ckey: canon(n.userData.kbType.slice(5)), M: n.matrixWorld.clone(), Minv: n.matrixWorld.clone().invert(), slot: null };
    });
    var slots = ref.slots.map(function (s) { return { ref: s, part: null, near: [], ok: false, err: null }; });

    // 1) 唯一锚:该类型在答案里只有一个槽、场景里也只有一个零件(X-Lock、前后板、电调……)
    var slotCount = {}, userCount = {};
    ref.slots.forEach(function (s) { slotCount[s.ckey] = (slotCount[s.ckey] || 0) + 1; });
    users.forEach(function (u) { userCount[u.ckey] = (userCount[u.ckey] || 0) + 1; });
    slots.forEach(function (t) {
      if (slotCount[t.ref.ckey] !== 1 || userCount[t.ref.ckey] !== 1) return;
      var u = users.filter(function (x) { return x.ckey === t.ref.ckey; })[0];
      t.part = u; u.slot = t;
    });

    // 2) 传播:从已配对的配合件出发,给空槽找相对位姿吻合的同类零件;全局按误差贪心
    function assignBest(cands) {
      cands.sort(function (a, b) { return a.e.score - b.e.score; });
      var n = 0;
      cands.forEach(function (c) {
        if (c.t.part || c.u.slot) return;
        if (c.t2 && (c.t2.part || c.u2.slot)) return;
        c.t.part = c.u; c.u.slot = c.t; n++;
        if (c.t2) { c.t2.part = c.u2; c.u2.slot = c.t2; n++; }
      });
      return n;
    }
    for (var guard = 0; guard < 80; guard++) {
      var cands = [];
      slots.forEach(function (t) {
        if (t.part) return;
        t.ref.mates.forEach(function (m) {
          var ms = slots[m.slot.i];
          if (!ms.part) return;
          users.forEach(function (u) {
            if (u.slot || u.ckey !== t.ref.ckey) return;
            var e = relError(t.ref, u, m.slot, ms.part);
            if (isNear(e)) cands.push({ t: t, u: u, e: e });
          });
        });
      });
      if (assignBest(cands)) continue;
      // 3) 两个都没配对、互为配合的槽(同一步的楔块+螺丝、电机+螺母):枚举零件对,没有锚所以门槛更严
      var pairCands = [];
      slots.forEach(function (t) {
        if (t.part) return;
        t.ref.mates.forEach(function (m) {
          var ms = slots[m.slot.i];
          if (ms.part || m.slot.i <= t.ref.i) return;
          users.forEach(function (u) {
            if (u.slot || u.ckey !== t.ref.ckey) return;
            users.forEach(function (v) {
              if (v === u || v.slot || v.ckey !== m.slot.ckey) return;
              var e = relError(t.ref, u, m.slot, v);
              if (e.d < PAIR_TOL && e.nearAng < NEAR_ANG) pairCands.push({ t: t, u: u, t2: ms, u2: v, e: e });
            });
          });
        });
      });
      if (!assignBest(pairCands)) break;
    }

    // 4) 逐槽判定:只看同一步或更早步骤的配合件(更晚步骤的配合件是那一步的事)。
    //    没有任何配合件挨着 → 只是配上了名字,还没装;有配合件挨着但相对位姿不对 → 没到位。
    slots.slice().sort(function (a, b) { return (a.ref.step - b.ref.step) || (a.ref.i - b.ref.i); }).forEach(function (t) {
      if (!t.part) return;
      t.ref.mates.forEach(function (m) {
        if (m.slot.step > t.ref.step) return;
        var ms = slots[m.slot.i];
        if (!ms.part) return;
        // 前面步骤的配合件如果已被判定为放错(有参照却不吻合),那是它的问题,不拿它来评这个零件;
        // 只是它自己的前置还没装(没有参照可判)的,仍可作为参照系
        if (m.slot.step < t.ref.step && ms.near.length && !ms.ok) return;
        var e = relError(t.ref, t.part, m.slot, ms.part);
        if (e.d < NEAR * 2) t.near.push({ m: m, ms: ms, e: e });
      });
      if (!t.near.length) return;
      t.near.sort(function (a, b) {
        return ((a.m.kind !== 'feature') - (b.m.kind !== 'feature')) || (a.e.score - b.e.score);
      });
      var bad = t.near.filter(function (x) { return !isOk(x.e); });
      t.ok = !bad.length;
      t.err = bad.length ? bad[0] : t.near[0];
    });

    // 5) 问题清单
    var issues = [], correct = 0;
    var us = KBParts.unitScale();
    var mm = function (w) { return (w / us * 1000).toFixed(1); };
    var pairSeen = {};
    slots.forEach(function (t) {
      if (t.part && t.ok) { correct += 1; return; }
      if (t.part && t.err) {
        var e = t.err.e, mate = t.err.m.slot;
        var pk = Math.min(t.ref.i, mate.i) + '|' + Math.max(t.ref.i, mate.i);
        if (pairSeen[pk]) return;
        pairSeen[pk] = 1;
        if (e.reversed) {
          issues.push({ severity: 'error', node: t.part.node, slot: t.ref,
            msg: t.ref.name + ' is inserted backwards into ' + mate.name + ' — the head faces the wrong way' });
        } else if (e.d >= POS_TOL) {
          issues.push({ severity: 'warn', node: t.part.node, slot: t.ref,
            msg: t.ref.name + ' is ' + mm(e.d) + ' mm off its place on ' + mate.name });
        } else {
          issues.push({ severity: 'warn', node: t.part.node, slot: t.ref,
            msg: t.ref.name + ' is tilted ' + e.ang.toFixed(0) + '° on ' + mate.name });
        }
        return;
      }
      if (t.part) return;   // 配上了名字但还没装到任何配合件上:零件还在桌上
      // 空槽:同族的别种零件占了这个位置(相对某个已配对、步骤不晚于本步的配合件)→ 用错零件
      var wrong = null;
      t.ref.mates.forEach(function (m) {
        if (m.slot.step > t.ref.step) return;
        var ms = slots[m.slot.i];
        if (!ms.part) return;
        // 该槽零件的 GLB 原点应在的世界位置:M_um · inv(M_m) · M_t · origin_t
        var expected = glbOrigin(t.ref.key).applyMatrix4(t.ref.M).applyMatrix4(m.slot.Minv).applyMatrix4(ms.part.M);
        users.forEach(function (u) {
          if (u.slot || u.ckey === t.ref.ckey || family(u.ckey) !== family(t.ref.ckey)) return;
          var d = glbOrigin(u.key).applyMatrix4(u.M).distanceTo(expected);
          if (d < POS_TOL * 1.5 && (!wrong || d < wrong.d)) wrong = { u: u, d: d, m: m };
        });
      });
      if (wrong) {
        issues.push({ severity: 'error', node: wrong.u.node, slot: t.ref,
          msg: 'Wrong part on ' + wrong.m.slot.name + ': found ' + wrong.u.node.name + ', expected ' + t.ref.name });
      }
    });

    // 6) 步骤状态:complete / available / blocked;顺序按任务图依赖
    var steps = ref.steps.map(function (st) {
      var ss = st.slots.map(function (s) { return slots[s.i]; });
      var okN = ss.filter(function (x) { return x.ok; }).length;
      return { i: st.i, id: st.id, name: st.name, requires: st.requires, slots: ss,
        total: ss.length, ok: okN, started: ss.some(function (x) { return x.part && x.near.length; }),
        complete: ss.length > 0 && okN === ss.length, state: null };
    });
    // complete = 做完且前置全部 complete(传递);premature = 几何上做完了但某个前置没做 ——
    // 不解锁后续步;available = 没做、前置全部 complete;其余 blocked。requires 已是拓扑序。
    steps.forEach(function (s) {
      var pre = s.requires.every(function (r) { return steps[r].state === 'complete'; });
      s.state = s.complete ? (pre ? 'complete' : 'premature') : (pre ? 'available' : 'blocked');
    });
    // 乱序提示:premature,或 blocked 却已经开始装(零件挨到了配合件上)—— 后者就是
    // "开始往错的地方插"的时刻;只是抓起、还没挨上不算
    steps.forEach(function (s) {
      if (!(s.state === 'premature' || (s.state === 'blocked' && s.started))) return;
      // 前置步骤已经开始但没到位的,它自己的位置问题已经报过,这里不连坐;只报"还没开始"的前置
      var pre = s.requires.map(function (r) { return steps[r]; }).filter(function (p) { return p.state !== 'complete' && !p.started; })[0];
      if (!pre) return;
      var node = (s.slots.filter(function (x) { return x.part && x.near.length; })[0] || {}).part;
      issues.push({ key: 'order|' + s.i, severity: 'warn', node: node ? node.node : null, step: s,
        msg: 'Out of order: “' + s.name + '” ' + (s.state === 'premature' ? 'done' : 'started') +
          ' before “' + pre.name + '” (' + pre.slots.map(function (x) { return x.ref.name; }).join(', ') + ')' });
    });

    results = { ready: true, issues: issues, correct: correct, total: slots.length,
      steps: steps, slots: slots, users: users,
      // stepsComplete:几何上做完的步(给用户看的进度);stepsSettled:且前置齐全的(任务图意义上的完成)
      stepsComplete: steps.filter(function (s) { return s.complete; }).length,
      stepsSettled: steps.filter(function (s) { return s.state === 'complete'; }).length };
    render();
  }

  /* 下一步:可做的步里优先已开始的,其余按答案顺序 */
  function next() {
    if (!results || !results.ready) return null;
    var avail = results.steps.filter(function (s) { return s.state === 'available'; });
    avail.sort(function (a, b) { return (b.started - a.started) || (a.i - b.i); });
    return avail[0] || null;
  }

  /* 可序列化的状态,供桥接发给宿主(ARISTOS) */
  function state() {
    if (!results || !results.ready) return null;
    var stepId = function (i) { return results.steps[i].id; };
    return {
      steps: results.steps.map(function (s) {
        return { id: s.id, index: s.i, name: s.name, state: s.state,
          progress: s.total ? s.ok / s.total : 0, requires: s.requires.map(stepId) };
      }),
      parts: results.slots.map(function (t) {
        return { id: t.ref.id, name: t.ref.name, step: stepId(t.ref.step), placed: !!(t.part && t.near.length),
          ok: t.ok, by: t.part ? t.part.id : null };
      }),
      issues: results.issues.map(function (i) {
        return { severity: i.severity, message: i.msg, objectId: (i.node && i.node.userData.kbId) || null,
          step: i.step ? i.step.id : (i.slot ? stepId(i.slot.step) : null) };
      }),
      next: (function () { var n = next(); return n ? n.id : null; })(),
      score: { partsOk: results.correct, partsTotal: results.total,
        stepsComplete: results.stepsComplete, stepsSettled: results.stepsSettled, stepsTotal: results.steps.length }
    };
  }

  function render() {
    if (results && results.ready) {
      elScore.textContent = results.stepsComplete + ' / ' + results.steps.length + ' steps · ' +
        results.correct + ' / ' + results.total + ' parts in place';
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
      var n = next();
      ok.textContent = !(results && results.ready) ? 'Place parts — problems show up here'
        : n ? 'No issues · Next: ' + n.name : 'No issues · Assembly complete';
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
    results: function () { return results; },
    state: state,
    next: next,
    ref: function () { buildRef(); return ref; },
    /* 用户零件节点当前占的参考槽位(评估结果里的),没有则 null */
    slotOf: function (node) {
      if (!results || !results.ready) return null;
      for (var i = 0; i < results.slots.length; i++) if (results.slots[i].part && results.slots[i].part.node === node) return results.slots[i];
      return null;
    }
  };
})();
