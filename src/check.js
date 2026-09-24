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

  // Compact automatic feedback, including when the full Checks panel is closed.
  var notice = document.createElement('div'); notice.id = 'checkNotice';
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  var noticeButton = document.createElement('button'); noticeButton.type = 'button';
  noticeButton.innerHTML = '<span class="ck-notice-icon" aria-hidden="true">!</span><span class="ck-notice-text"></span><span class="ck-notice-count"></span>';
  noticeButton.tabIndex = -1; notice.appendChild(noticeButton); document.body.appendChild(notice);
  noticeButton.addEventListener('click', function () { panel.style.display = 'flex'; elClose.focus(); });
  function renderNotice(issues) {
    var errors = issues.filter(function (issue) { return issue.severity === 'error'; });
    var warn = !errors.length;
    if (warn) errors = issues.filter(function (issue) { return issue.severity === 'warn'; });
    notice.classList.toggle('warn', warn);
    var message = errors.length ? errors[0].msg : '';
    var label = errors.length ? 'Checks: ' + message : '';
    var count = errors.length > 1 ? '+' + (errors.length - 1) : '';
    var text = noticeButton.querySelector('.ck-notice-text');
    if (text.textContent !== label) text.textContent = label;
    var badge = noticeButton.querySelector('.ck-notice-count');
    if (badge.textContent !== count) badge.textContent = count;
    noticeButton.title = label + (count ? ' (' + errors.length + ' errors)' : '');
    noticeButton.setAttribute('aria-label', label ? label + '. Open Checks for details.' : 'Checks');
    noticeButton.tabIndex = errors.length ? 0 : -1;
    notice.setAttribute('aria-hidden', String(!errors.length));
    notice.classList.toggle('show', !!errors.length);
    document.body.classList.toggle('has-check-error', !!errors.length && !warn);
  }


  var POS_TOL = 0.08, ANG_TOL = 12;      // 到位:场景单位(1 = 40.4 mm)→ 3.2 mm / 12°
  var NEAR = 0.5, NEAR_ANG = 45;         // 在配合件旁边但没到位:20 mm / 45°
  var PAIR_TOL = POS_TOL * 2;            // 两个都未配对的零件互相配上的门槛(没有锚,严一点)
  var REVOLVE = { screw_m3x6_pan: 1, screw_m3x16_pan: 1, screw_m3x16_socket_cap: 1, screw_m3x22_pan: 1,
    screw_m3x8_socket_cap: 1, knurled_standoff: 1, motor_nut_m5: 1, damper_m2: 1,
    // 桨装上去绕轴转到哪个角度都一样(三叶,自己也是 120° 周期)
    propeller_cw: 1, propeller_ccw: 1 };
  var SCREW = { screw_m3x6_pan: 1, screw_m3x16_pan: 1, screw_m3x16_socket_cap: 1, screw_m3x22_pan: 1,
    screw_m3x8_socket_cap: 1 };
  function family(key) { return key.indexOf('screw_') === 0 ? 'screw' : key.indexOf('split_') === 0 ? 'plate' : key; }
  // 暂不区分头型:M3×16 盘头 与 M3×16 杯头 视为同一种零件。
  // 正反桨同理:任务图只说"把桨装到电机轴上",没说哪条对角线装正桨,
  // 所以两种桨互相顶替都算对(derive_final_assembly.py 里也写了这件事)
  var SAME = { screw_m3x16_socket_cap: 'screw_m3x16_pan', propeller_ccw: 'propeller_cw' };
  function canon(key) { return SAME[key] || key; }

  var results = null;

  /* ---------- 归位:把零件吸到参考装配里的精确位姿 ----------
   * 默认不自动做 —— 自动吸会和手上的微调打架。按 S 对选中的零件手动归位;
   * 想要放下即吸的话 KBCheck.autoSnap(true)。插反的螺丝不吸:那是要指出来的错。*/
  var SNAP_POS_MM = 10, SNAP_ANG = 25;
  // 点选装配之后零件绕孔轴的转角是随手的,常常差几十度 —— 这种 Checks 根本认不出它占哪个槽位。
  // 归位时对「还没认领槽位」的零件放宽到这个范围,按"离哪个槽位最近"认领
  var LOOSE_POS_MM = 60, LOOSE_ANG = 60;
  var radiusCache = {};
  function partRadius(key) {   // 零件包围盒半对角(场景单位)
    if (radiusCache[key] !== undefined) return radiusCache[key];
    var spec = KBParts.spec(key), r = 0;
    if (spec) {
      r = 0.5 * Math.hypot(spec.bbox.max[0] - spec.bbox.min[0],
        spec.bbox.max[1] - spec.bbox.min[1], spec.bbox.max[2] - spec.bbox.min[2]);
    }
    radiusCache[key] = r;
    return r;
  }
  var autoSnap = false;
  var snapping = false;

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
      return { i: st.i, id: st.id, name: st.name, requires: st.requires || [], assembly: st.assembly || null,
        slots: slots.filter(function (s) { return s.step === st.i; }) };
    });
    ref = { source: a, slots: slots, steps: steps, byId: byId };
    return true;
  }

  /* 槽位 t 的用户零件 u,相对于配合件(参考槽 m,用户零件 um)的位姿与参考相对位姿的偏差。
     用户:inv(M_um)·M_u;参考:inv(S_m)·inv(M_m)·M_t·S_t,取配合件对称 × 零件对称里最接近的一组。 */
  var _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  var _p2 = new THREE.Vector3(), _q2 = new THREE.Quaternion();
  function screwRoll(key, delta) {
    var spec = KBParts.spec(key), shaft = spec.pegs.reduce(function (a, b) { return a.r < b.r ? a : b; });
    var axis = new THREE.Vector3().fromArray(shaft.d).normalize();
    var projection = delta.x * axis.x + delta.y * axis.y + delta.z * axis.z;
    var twist = new THREE.Quaternion(axis.x * projection, axis.y * projection, axis.z * projection, delta.w);
    if (twist.lengthSq() < 1e-12) twist.identity(); else twist.normalize();
    var c = new THREE.Vector3().fromArray(shaft.c);
    return new THREE.Matrix4().makeTranslation(c.x, c.y, c.z)
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(twist))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  }
  function relError(t, u, m, um) {
    var Rref = new THREE.Matrix4().multiplyMatrices(m.Minv, t.M);
    var Ruser = new THREE.Matrix4().multiplyMatrices(um.Minv, u.M);
    Ruser.decompose(_p2, _q2, _s);
    var best = null;
    function consider(expected) {
      expected.decompose(_p, _q, _s);
      var d = _p.distanceTo(_p2);
      var ang = REVOLVE[t.key] ? axisAngle(t.key, _q2, _q) : { deg: angleBetween(_q2, _q), signed: false };
      var reversed = ang.signed && ang.deg > 90;
      var nearAng = reversed ? 180 - ang.deg : ang.deg;
      var score = d + (reversed ? 0.02 : nearAng / 180 * 0.05);
      if (!best || score < best.score) best = { score: score, d: d, ang: ang.deg, reversed: reversed, nearAng: nearAng,
        want: new THREE.Matrix4().multiplyMatrices(um.M, expected) };
    }
    symTransforms(m.key).forEach(function (Sm) {
      var left = new THREE.Matrix4().multiplyMatrices(Sm.clone().invert(), Rref);
      symTransforms(t.key).forEach(function (St) {
        var expected = new THREE.Matrix4().multiplyMatrices(left, St);
        consider(expected);
        // Continuous screw roll applies on either side of the relation. Rotate
        // about the actual shaft line, not an arbitrary node origin.
        var q = new THREE.Quaternion().setFromRotationMatrix(expected);
        if (SCREW[m.key]) {
          var roll = screwRoll(m.key, q.clone().multiply(_q2.clone().invert()));
          var aligned = roll.clone().invert().multiply(expected);
          consider(aligned);
          if (SCREW[t.key]) {
            var aq = new THREE.Quaternion().setFromRotationMatrix(aligned);
            consider(aligned.clone().multiply(screwRoll(t.key, aq.invert().multiply(_q2))));
          }
        }
        if (SCREW[t.key]) consider(expected.clone().multiply(screwRoll(t.key, q.invert().multiply(_q2))));
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

  /* 「差在哪」:把误差说成人话 —— 高了 / 低了 / 平move,而不是只给一个毫米数 */
  function which(node, want) {
    if (!want) return '';
    var now = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
    var goal = new THREE.Vector3().setFromMatrixPosition(want);
    var us = KBParts.unitScale();
    var dy = (goal.y - now.y) / us * 1000;
    var flat = Math.hypot(goal.x - now.x, goal.z - now.z) / us * 1000;
    var bits = [];
    if (Math.abs(dy) > 1) bits.push(Math.abs(dy).toFixed(1) + ' mm too ' + (dy > 0 ? 'low' : 'high'));
    if (flat > 1) bits.push(flat.toFixed(1) + ' mm sideways');
    return bits.length ? ' (' + bits.join(', ') + ')' : '';
  }

  /* 点问题 → 在正确位置显示半透明虚影,再点一次收起 */
  var ghost = null;
  function showGhost(node, want) {
    hideGhost();
    if (!want || !node) return;
    var key = node.userData.kbType.slice(5);
    var prims = KBParts.prims(key);
    if (!prims) return;
    var g = new THREE.Group();
    g.userData.kbOverlay = true;
    var mat = new THREE.MeshBasicMaterial({ color: 0x8fe3a4, transparent: true, opacity: 0.45,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    prims.forEach(function (pr) {
      g.add(new THREE.Mesh(pr.geometry, mat));
      // 轮廓线:半透明实体在深色零件上不显眼,加一圈边让"该在哪"一眼看清
      var edges = new THREE.LineSegments(new THREE.EdgesGeometry(pr.geometry, 35),
        new THREE.LineBasicMaterial({ color: 0xb6f7c6, transparent: true, opacity: 0.95, depthTest: false }));
      g.add(edges);
    });
    g.matrixAutoUpdate = false;
    g.matrix.copy(want);
    g.matrixWorldNeedsUpdate = true;
    g.renderOrder = 997;
    KB.toast('Ghost: where this part belongs \u2014 click the row again to hide it');
    KB.scene.add(g);
    ghost = { group: g, mat: mat, node: node };
  }
  function hideGhost() {
    if (!ghost) return;
    ghost.group.traverse(function (o) {
      if (o.isLineSegments) { o.geometry.dispose(); o.material.dispose(); }
    });
    ghost.mat.dispose();
    KB.scene.remove(ghost.group);
    ghost = null;
  }

  var settleTimer = 0, lastSig = '';
  /* 影响判定的一切:每个零件的位姿和所在的组、按级别摆过的、配过的、拿错 / 点错的提示、难度 */
  function signature() {
    KB.scene.updateMatrixWorld();
    var out = [], e;
    collectParts().forEach(function (n) {
      e = n.matrixWorld.elements;
      out.push(n.uuid, n.parent ? n.parent.uuid : '');
      for (var i = 0; i < 16; i++) out.push(Math.round(e[i] * 1e5));
    });
    out.push(Object.keys(levelPlaced).join(','), Object.keys(userMated).length,
      lastPick ? lastPick.node.uuid + lastPick.step + lastPick.msg : '',
      lastHole ? lastHole.node.uuid + lastHole.step + lastHole.msg : '',
      window.KBLevel ? KBLevel.get() : 3);
    return out.join('|');
  }
  function evaluate() {
    if (KB.interacting && KB.interacting()) return;
    // 教程场景里的楔块 / 螺丝和正式零件同型号,拿去对照答案只会报一堆假错误 —— 教程期间不判
    if (window.KBTutorial && KBTutorial.active()) {
      results = { ready: false, issues: [], correct: 0, total: 0, note: 'Checks are off during the tutorial' };
      render();
      return;
    }
    // 零件还在飞(自动到位 / 装配补间):半路上的位姿不作数,落定了再判,免得途中闪一下 error
    if ((KB.tweening && KB.tweening()) || (window.KBLevel && KBLevel.busy && KBLevel.busy())) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(evaluate, 200);
      return;
    }
    if (!(window.KBParts && KBParts.ready() && buildRef())) {
      results = { ready: false, issues: [], correct: 0, total: 0, note: 'No reference assembly in the part library' };
      render();
      return;
    }
    // 场面没变就不重算:一次点击里 levelTarget / Next 动画 / 推荐视角 / 指引卡片都会来要结果,
    // 每次 ~20 ms,重复算几遍就是肉眼可见的卡顿
    var sig = signature();
    if (sig === lastSig && results && results.ready) return;
    lastSig = sig;
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

    // 3b) 相同零件的槽位串位修正:四根机臂各差几毫米时,贪心很容易让一根占了邻居的槽位,
    //     报出来的偏差就完全不像话。两两对调,只要总误差变小就换 —— 直到换不动为止。
    // 代价 = 对「所有已摆好的配合件」的误差之和。只取最小的那个会出事:
    // 前板有 180° 对称,单看前板时对角的两个槽位是一样的,于是机臂被配到对角槽位
    // 也能得零分 —— 但相对后板就差了十几毫米。要所有参照都说得通才算配对正确。
    function costOf(t, u) {
      var sum = 0, n = 0;
      t.ref.mates.forEach(function (m) {
        var ms = slots[m.slot.i];
        if (!ms.part || ms.part === u) return;
        sum += relError(t.ref, u, m.slot, ms.part).score;
        n += 1;
      });
      return n ? sum / n : Infinity;
    }
    for (var swap = 0; swap < 40; swap++) {
      var improved = false;
      for (var ai = 0; ai < slots.length; ai++) {
        for (var bi = ai + 1; bi < slots.length; bi++) {
          var ta = slots[ai], tb = slots[bi];
          if (!ta.part || !tb.part || ta.ref.ckey !== tb.ref.ckey) continue;
          var now = costOf(ta, ta.part) + costOf(tb, tb.part);
          var alt = costOf(ta, tb.part) + costOf(tb, ta.part);
          if (!(alt < now - 1e-6)) continue;
          var tmp = ta.part;
          ta.part = tb.part; tb.part = tmp;
          ta.part.slot = ta; tb.part.slot = tb;
          improved = true;
        }
      }
      if (!improved) break;
    }
    // 3c) 谁可以当参照:拿每个零件对「所有已摆好的配合件」的吻合票数算。
    //     一个早装的零件如果自己偏了,它只跟更早的零件比,照样被判"到位",
    //     于是后面每个碰它的零件都替它背锅(机臂明明分毫不差,却报 4 mm)。
    //     和大多数配合件都对不上的零件,不拿来评别人。
    slots.forEach(function (t) {
      t.agree = 0; t.disagree = 0;
      if (!t.part) return;
      t.ref.mates.forEach(function (m) {
        var ms = slots[m.slot.i];
        if (!ms.part) return;
        var e = relError(t.ref, t.part, m.slot, ms.part);
        if (e.d >= NEAR) return;                 // 离得远的不算票
        if (isOk(e)) t.agree += 1; else t.disagree += 1;
      });
    });
    function trustedRef(ms) { return !ms.disagree || ms.agree >= ms.disagree; }

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
        if (!trustedRef(ms) && trustedRef(t)) return;   // 参照自己跟大家都对不上:别拿它评这个零件
        var e = relError(t.ref, t.part, m.slot, ms.part);
        if (e.d < NEAR * 2) t.near.push({ m: m, ms: ms, e: e });
      });
      if (!t.near.length) return;
      t.near.sort(function (a, b) {
        return ((a.m.kind !== 'feature') - (b.m.kind !== 'feature')) || (a.e.score - b.e.score);
      });
      var bad = t.near.filter(function (x) { return !isOk(x.e); });
      // 多数配合件认可就算到位。要求"每一个参照都同意"太脆:旁边一颗螺丝转了 5°,
      // 从长零件那头看就是好几毫米(误差是不对称的 —— 螺丝自己那边只看到零点几毫米,
      // 于是它全票"到位",账全记在机臂头上)。真放错的零件会跟大多数邻居都对不上。
      var agreeing = t.near.length - bad.length;
      t.ok = !bad.length || agreeing > bad.length;
      t.err = bad.length ? bad[0] : t.near[0];
    });

    // 5) 问题清单
    var issues = [], correct = 0;
    var us = KBParts.unitScale();
    var mm = function (w) { return (w / us * 1000).toFixed(1); };
    var pairSeen = {};
    // 同一个零件可能对着好几个候选位置都"不对",只留最贴近的那条,免得刷屏
    var misfits = {};
    function keepClosest(node, d, msg, severity, host, reversed, ang, kind) {
      var id = node.uuid;
      if (!misfits[id] || d < misfits[id].d) {
        misfits[id] = { node: node, d: d, msg: msg, severity: severity || 'error', kind: kind || 'hole',
                        host: host || null, reversed: !!reversed, ang: ang || 0 };
      }
    }
    slots.forEach(function (t) {
      // 跟大多数配合件都对不上的零件:哪怕它自己"没有更早的参照可判",也要点名,
      // 否则真正偏了的那个零件永远不出现在清单里
      if (t.part && t.ok && t.disagree && t.agree < t.disagree) {
        t.ok = false;
        if (!t.err || isOk(t.err.e)) {
          var worst = null;
          t.ref.mates.forEach(function (m) {
            var ms = slots[m.slot.i];
            if (!ms.part) return;
            var e = relError(t.ref, t.part, m.slot, ms.part);
            if (e.d < NEAR && !isOk(e) && (!worst || e.score > worst.e.score)) worst = { m: m, ms: ms, e: e };
          });
          if (worst) { t.err = worst; t.near.push(worst); }
        }
      }
      if (t.part && window.KBWorkspace && !KBWorkspace.contains(t.part.node)) {
        var assembled = t.ok || t.near.length;
        t.ok = false;
        // 还没搬进装配区不算装错,是"接下来该干什么"
        if (assembled) issues.push({ severity: 'hint', kind: 'hint', node: t.part.node, slot: t.ref,
          msg: KBWorkspace.message(t.part.node) });
        return;
      }
      if (t.part && t.ok) { correct += 1; return; }
      if (t.part && t.err) {
        var e = t.err.e, mate = t.err.m.slot;
        var pk = Math.min(t.ref.i, mate.i) + '|' + Math.max(t.ref.i, mate.i);
        if (pairSeen[pk]) return;
        pairSeen[pk] = 1;
        if (e.reversed) {
          issues.push({ severity: 'error', kind: 'hole', node: t.part.node, slot: t.ref,
            msg: t.ref.name + ' is inserted backwards into ' + mate.name + ' — the head faces the wrong way' });
        } else if (e.d >= POS_TOL) {
          issues.push({ severity: 'error', kind: 'align', node: t.part.node, slot: t.ref, want: e.want,
            msg: t.ref.name + ' is ' + mm(e.d) + ' mm off its place on ' + mate.name + which(t.part.node, e.want) });
        } else {
          issues.push({ severity: 'error', kind: 'align', node: t.part.node, slot: t.ref,
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
      // 第一步:桌上还没有任何装好的零件可当参照。退一步,用"配合件本身"当参照 ——
      // 场上有一个型号对得上、但还没被配上的配合件(比如楔块),就按它的实际位姿算
      // 这颗螺丝该在哪,再看那儿是不是杵着一个同族的别种零件
      if (!wrong) {
        t.ref.mates.forEach(function (m) {
          if (m.slot.step > t.ref.step || slots[m.slot.i].part) return;
          users.forEach(function (host) {
            if (host.slot || host.ckey !== m.slot.ckey) return;
            var expected = glbOrigin(t.ref.key).applyMatrix4(t.ref.M).applyMatrix4(m.slot.Minv).applyMatrix4(host.M);
            users.forEach(function (u) {
              if (u === host || u.slot || u.ckey === t.ref.ckey || family(u.ckey) !== family(t.ref.ckey)) return;
              var d = glbOrigin(u.key).applyMatrix4(u.M).distanceTo(expected);
              if (d < POS_TOL * 1.5 && (!wrong || d < wrong.d)) wrong = { u: u, d: d, m: m };
            });
          });
        });
      }
      if (wrong) {
        keepClosest(wrong.u.node, wrong.d,
          'Wrong part on ' + wrong.m.slot.name + ': found ' + wrong.u.node.name + ', expected ' + t.ref.name,
          'error', null, false, 0, 'pick');
        return;
      }
      // 插错孔:型号对得上的零件确实装在装配区里了,只是离它该在的位置太远,
      // 远到 NEAR 都够不着(挪一两个孔就是这种情况),否则上面那条"差 N 毫米"会先报
      var misplaced = null;
      t.ref.mates.forEach(function (m) {
        if (m.slot.step > t.ref.step) return;
        var ms = slots[m.slot.i];
        var host = ms.part ? ms.part : null;
        if (!host) {
          for (var k = 0; k < users.length; k++) {
            if (!users[k].slot && users[k].ckey === m.slot.ckey) { host = users[k]; break; }
          }
        }
        if (!host) return;
        var expected = glbOrigin(t.ref.key).applyMatrix4(t.ref.M).applyMatrix4(m.slot.Minv).applyMatrix4(host.M);
        users.forEach(function (u) {
          if (u.slot || u.ckey !== t.ref.ckey) return;
          var d = glbOrigin(u.key).applyMatrix4(u.M).distanceTo(expected);
          if (d >= NEAR * 6) return;
          // 位置之外还要看朝向:只比位置的话,装反会被说成"差了 8 毫米"
          var e = relError(t.ref, u, m.slot, host);
          var out = window.KBWorkspace && !KBWorkspace.contains(u.node);
          if (!misplaced || e.score < misplaced.e.score) misplaced = { u: u, d: e.d, e: e, m: m, outside: out, host: host };
        });
      });
      if (misplaced) {
        var me = misplaced.e;
        // 装配区外的零件只有一种说法:"你按答案装好了,但装在区外"。
        // 其余(装反 / 插错孔 / 差几毫米)一律不对区外的零件下结论 ——
        // 料盘里螺丝和立柱本来就一排排挨着、方向相反,照着几何去套必然误判
        if (misplaced.outside && !isOk(me) && !wasMated(misplaced.u.node)) {
          /* 躺在料盘里、从没被配过的零件:不作声 */
        } else if (misplaced.outside && isOk(me)) {
          // 真的按答案配好了、只是整组还在装配区外 —— 让人搬进去
          keepClosest(misplaced.u.node, misplaced.d,
            misplaced.u.node.name + ' is assembled outside the workspace — move it inside to be checked',
            'hint', misplaced.host.node, false, 0, 'hint');
        } else if (!me.reversed && misplaced.d < NEAR && me.nearAng >= ANG_TOL) {
          keepClosest(misplaced.u.node, misplaced.d,
            misplaced.u.node.name + ' is tilted ' + me.nearAng.toFixed(0) + '° in ' + misplaced.m.slot.name,
            'error', misplaced.host.node, false, me.nearAng, 'align');
        } else if (me.reversed) {
          keepClosest(misplaced.u.node, misplaced.d,
            misplaced.u.node.name + ' is inserted backwards into ' + misplaced.m.slot.name +
            ' — the head faces the wrong way', 'error', misplaced.host.node, true);
        } else if (misplaced.d < NEAR) {
          keepClosest(misplaced.u.node, misplaced.d,
            misplaced.u.node.name + ' is ' + mm(misplaced.d) + ' mm off its place on ' +
            misplaced.m.slot.name + ' (expected ' + t.ref.name + ')', 'error', misplaced.host.node, false, 0, 'align');
        } else {
          keepClosest(misplaced.u.node, misplaced.d,
            misplaced.u.node.name + ' is in the wrong hole on ' + misplaced.m.slot.name +
            ' — ' + mm(misplaced.d) + ' mm from where ' + t.ref.name + ' belongs', 'error', misplaced.host.node);
        }
      }
    });
    Object.keys(misfits).forEach(function (k) {
      var it = misfits[k];
      // A 是拿 B 当参照算出来的,而 B 自己也被判了错 —— 同一处错误的两种说法,只留说中根因的那条:
      // 先看谁点出了"装反",都没有的话留偏得更离谱的那条
      var hostIssue = it.host && misfits[it.host.uuid];
      if (hostIssue && hostIssue.host === it.node) {
        if (hostIssue.reversed && !it.reversed) return;
        if (!(it.reversed && !hostIssue.reversed)) {
          var meScrew = !!SCREW[it.node.userData.kbType.slice(5)];
          var otherScrew = !!SCREW[hostIssue.node.userData.kbType.slice(5)];
          if (otherScrew && !meScrew) return;        // 楔块没问题,是螺丝插得不对
          if (meScrew === otherScrew && (hostIssue.d + hostIssue.ang * 0.01) > (it.d + it.ang * 0.01)) return;
        }
      }
      issues.push({ severity: it.severity, kind: it.kind, node: it.node, slot: it.slot, msg: it.msg });
    });

    if (lastPick) {
      var cur = next();
      if (cur && cur.i === lastPick.step) {
        issues.push({ key: 'pick', severity: 'error', kind: 'pick', node: lastPick.node, msg: lastPick.msg });
      } else {
        lastPick = null;
      }
    }
    // 兜底:当前这一步没完成,而相关型号的零件用户明明已经配上去了、也在装配区里,
    // 却没有任何一条说法 —— 那就明说"配上了但和这一步对不上",绝不空着让人干等
    (function () {
      var cur = null;
      ref.steps.forEach(function (st) {
        if (cur) return;
        var ss = st.slots.map(function (sl) { return slots[sl.i]; });
        if (ss.some(function (t) { return !t.ok; })) cur = { st: st, ss: ss };
      });
      if (!cur) return;
      var spoken = {};
      issues.forEach(function (i) { if (i.node) spoken[i.node.uuid] = true; });
      // 这一步已经有具体说法了(装反 / 插错孔 / 差几毫米……),兜底就不再插嘴
      var keys = {};
      cur.ss.forEach(function (t) { keys[t.ref.ckey] = true; });
      var explained = users.some(function (u) { return keys[u.ckey] && spoken[u.node.uuid]; });
      if (explained) return;
      cur.ss.forEach(function (t) {
        if (t.ok || (t.part && spoken[t.part.node.uuid])) return;
        users.forEach(function (u) {
          if (u.ckey !== t.ref.ckey || spoken[u.node.uuid]) return;
          if (u.slot) return;                      // 已经被认成别的位置(比如上一步装好的那对)
          if (levelPlaced[u.node.uuid]) return;    // 按难度级别自动摆的,位置就是答案
          if (!wasMated(u.node)) return;
          if (window.KBWorkspace && !KBWorkspace.contains(u.node)) return;
          spoken[u.node.uuid] = true;
          issues.push({ severity: 'error', kind: 'hole', node: u.node, slot: t.ref,
            msg: u.node.name + ' is assembled, but not the way “' + cur.st.name +
                 '” needs it — check which hole it goes in and which way round' });
        });
      });
    })();

    // 6) 步骤状态:complete / available / blocked;顺序按任务图依赖
    var steps = ref.steps.map(function (st) {
      var ss = st.slots.map(function (s) { return slots[s.i]; });
      var baseSlot = null;
      if (st.assembly) {
        baseSlot = slots[ref.byId[st.assembly.base].i];
        ss = [].concat.apply([], st.assembly.groups).map(function (id) {
          var source = slots[ref.byId[id].i];
          var e = source.part && baseSlot.part ? relError(source.ref, source.part, baseSlot.ref, baseSlot.part) : null;
          var inside = source.part && baseSlot.part && (!window.KBWorkspace || (KBWorkspace.contains(source.part.node) && KBWorkspace.contains(baseSlot.part.node)));
          var link = e ? { m: { slot: baseSlot.ref, kind: 'feature' }, ms: baseSlot, e: e } : null;
          return { ref: source.ref, part: source.part, near: link && e.d < NEAR * 2 ? [link] : [],
            ok: !!(source.ok && inside && e && isOk(e)), err: link };
        });
        ss.forEach(function (t) {
          if (t.ok || !t.part) return;
          var msg = !baseSlot.part ? 'Bring the X-Lock into the workspace first.' :
            !t.near.length ? 'Attach ' + t.ref.name + ' to its side of the X-Lock.' :
            t.err.e.reversed ? t.ref.name + ' is facing the wrong direction on the X-Lock.' :
            t.err.e.d >= POS_TOL ? t.ref.name + ' is ' + mm(t.err.e.d) + ' mm off its place on the X-Lock.' :
            t.err.e.ang >= ANG_TOL ? t.ref.name + ' is tilted ' + t.err.e.ang.toFixed(0) + '° on the X-Lock.' :
            'Finish preparing ' + t.ref.name + ' and keep it fully inside the workspace.';
          issues.push({ severity: (!baseSlot.part || !t.near.length) ? 'hint' : 'error',
            kind: (!baseSlot.part || !t.near.length) ? 'hint' : t.err.e.reversed ? 'hole' : 'align',
            hint: !t.near.length, node: t.part.node, step: st, msg: msg });
        });
      }
      var okN = ss.filter(function (x) { return x.ok; }).length;
      return { i: st.i, id: st.id, name: st.name, requires: st.requires, slots: ss, assembly: st.assembly, base: baseSlot,
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
      issues.push({ key: 'order|' + s.i, severity: 'error', kind: 'pick', node: node ? node.node : null, step: s,
        msg: 'Out of order: “' + s.name + '” ' + (s.state === 'premature' ? 'done' : 'started') +
          ' before “' + pre.name + '” (' + pre.slots.map(function (x) { return x.ref.name; }).join(', ') + ')' });
    });

    // 二级:点错孔(点的时候就拒了,几何上什么都没发生)—— 挂在清单里,到下一步或装对了才消
    if (lastHole) {
      var curH = next();
      if (curH && curH.i === lastHole.step) issues.push({ key: 'hole', severity: 'error', kind: 'hole', node: lastHole.node, msg: lastHole.msg });
      else lastHole = null;
    }
    // 按难度只报该报的:
    //   一级 —— 只有"零件点错了";
    //   二级 —— 零件点错了 / 孔点错了;
    //   三级 —— 上面两种还是 error,零件和孔都对、只是还没对齐的,降成 warn
    var lv = window.KBLevel ? KBLevel.get() : 3;
    issues = issues.filter(function (i) {
      var k = i.kind || 'hole';
      if (k === 'hint') return true;
      if (lv === 1) return k === 'pick';
      if (lv === 2) return k === 'pick' || k === 'hole';
      return true;
    });
    if (lv === 3) issues.forEach(function (i) {
      if (i.kind === 'align' && i.severity === 'error') { i.severity = 'warn'; i.msg = 'Not aligned yet: ' + i.msg; }
    });
    var RANK = { error: 0, warn: 1, hint: 2 };
    issues.sort(function (a, b) { return (RANK[a.severity] || 0) - (RANK[b.severity] || 0); });

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
    renderNotice(all);
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
      row.title = is.want ? 'Click to select the part and ghost where it belongs' : 'Click to select the part';
      row.addEventListener('click', function () {
        if (is.node && is.node.parent) KB.setSelection([is.node]);
        if (ghost && ghost.node === is.node) hideGhost();
        else showGhost(is.node, is.want);
      });
      elList.appendChild(row);
    });
    btn.classList.toggle('has-errors', all.some(function (i) { return i.severity === 'error'; }));
  }

  /* 全局基准:场上已经判对、且最"稳"的那个零件(独一无二的优先,其次个头大的)。
   * 所有零件都以它为参照算目标位姿 —— 各算各的会互相矛盾(几个一样的零件抢同一个槽位)。*/
  function anchorSlot() {
    if (!results || !results.ready) return null;
    var best = null, bestScore = -1;
    var count = {};
    results.slots.forEach(function (s) { count[s.ref.ckey] = (count[s.ref.ckey] || 0) + 1; });
    results.slots.forEach(function (t) {
      if (!t.part || !t.ok || staged[t.part.node.uuid]) return;   // 暂放在一边的组件不当基准
      var score = partRadius(t.ref.key) + (count[t.ref.ckey] === 1 ? 100 : 0);
      if (score > bestScore) { bestScore = score; best = t; }
    });
    return best;
  }

  /* 以基准零件为参照,槽位 t 的目标世界位姿 */
  function wantVia(anchor, t) {
    return new THREE.Matrix4().multiplyMatrices(
      anchor.part.M, new THREE.Matrix4().multiplyMatrices(anchor.ref.Minv, t.ref.M));
  }

  /* 目标离现在够近才吸:位置 10 mm(长零件按角度差该甩出的距离放宽)+ 角度 25° */
  function withinReach(t, want) {
    var node = t.part.node;
    node.updateMatrixWorld(true);
    var p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), s0 = new THREE.Vector3();
    node.matrixWorld.decompose(p0, q0, s0);
    var p1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), s1 = new THREE.Vector3();
    want.decompose(p1, q1, s1);
    var ang = angleBetween(q0, q1);
    if (ang > SNAP_ANG) return false;
    var swing = partRadius(t.ref.key) * Math.sin(THREE.MathUtils.degToRad(ang));
    return p0.distanceTo(p1) <= SNAP_POS_MM * KBParts.unitScale() / 1000 + swing;
  }

  function planVia(anchor, t) {
    if (!t || !t.part || t.ok || t === anchor) return null;
    var want = wantVia(anchor, t);
    if (!withinReach(t, want)) return null;
    var node = t.part.node;
    var world = want.clone();
    if (node.parent) {
      node.parent.updateMatrixWorld(true);
      world.premultiply(new THREE.Matrix4().copy(node.parent.matrixWorld).invert());
    }
    var pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    world.decompose(pos, quat, scl);
    return { node: node, pos: pos, quat: quat, name: t.ref.name };
  }

  /* 归位按钮什么都没做时,说清卡在哪 —— 光说"不够近"是死胡同 */
  function whyNothingSnapped() {
    if (!results || !results.ready) return 'Nothing to check against yet';
    var anchor = anchorSlot();
    if (!anchor) return 'Place one part correctly first \u2014 everything else is measured from it';
    var pending = results.slots.filter(function (t) { return !t.ok; });
    if (!pending.length) return 'Everything is already in place';
    // 先说 Checks 列表里那些"已经认出来、只是没到位"的零件,并报出到底卡在距离还是角度 ——
    // 桌上还没开始装的零件(螺旋桨之类)不该拿来当理由
    var mm = function (w) { return (w / KBParts.unitScale() * 1000).toFixed(1); };
    var named = pending.filter(function (t) { return t.part && t.near.length; })[0];
    if (named) {
      var node = named.part.node;
      node.updateMatrixWorld(true);
      var p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), s0 = new THREE.Vector3();
      node.matrixWorld.decompose(p0, q0, s0);
      var p1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), s1 = new THREE.Vector3();
      wantVia(anchor, named).decompose(p1, q1, s1);
      var d = p0.distanceTo(p1), ang = angleBetween(q0, q1);
      var reach = withinReach(named, wantVia(anchor, named));
      return named.ref.name + ': ' + mm(d) + ' mm and ' + ang.toFixed(0) + '\u00b0 from where it belongs \u2014 '
        + (reach ? 'snapping it would not settle the parts around it either'
                 : 'too far to snap, move it nearer first');
    }
    return 'Nothing close enough to snap \u2014 the parts left are not recognised in the assembly yet';
  }

  /* 还没认领槽位的零件:按「离哪个空槽位最近」认领并归位(放宽阈值) */
  function looseCost(t, u, want) {
    u.node.updateMatrixWorld(true);
    var p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), s0 = new THREE.Vector3();
    u.node.matrixWorld.decompose(p0, q0, s0);
    var p1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), s1 = new THREE.Vector3();
    want.decompose(p1, q1, s1);
    var ang = angleBetween(q0, q1);
    if (ang > LOOSE_ANG) return null;
    var d = p0.distanceTo(p1);
    // 点选装配把零件按在了正确的孔上、只是绕孔转了几十度:原点因此甩出去很远,
    // 门槛里要把这份"本来就该甩出的距离"算进去,否则这种最常见的情况永远收编不了
    var swing = partRadius(t.ref.key) * Math.sin(THREE.MathUtils.degToRad(ang));
    if (d > LOOSE_POS_MM * KBParts.unitScale() / 1000 + swing) return null;
    return d + ang / 180 * partRadius(t.ref.key);
  }

  function loosePlans(anchor) {
    if (!anchor || !results || !results.ready) return [];
    var cands = [];
    results.slots.forEach(function (t) {
      if (t.part) return;
      var want = wantVia(anchor, t);
      results.users.forEach(function (u) {
        if (u.slot || u.ckey !== t.ref.ckey) return;
        var c = looseCost(t, u, want);
        if (c !== null) cands.push({ t: t, u: u, want: want, c: c });
      });
    });
    cands.sort(function (a, b) { return a.c - b.c; });
    var takenSlot = {}, takenPart = {}, out = [];
    cands.forEach(function (c) {
      if (takenSlot[c.t.ref.i] || takenPart[c.u.node.uuid]) return;
      takenSlot[c.t.ref.i] = 1;
      takenPart[c.u.node.uuid] = 1;
      var node = c.u.node, world = c.want.clone();
      if (node.parent) {
        node.parent.updateMatrixWorld(true);
        world.premultiply(new THREE.Matrix4().copy(node.parent.matrixWorld).invert());
      }
      var pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
      world.decompose(pos, quat, scl);
      out.push({ node: node, pos: pos, quat: quat, name: c.t.ref.name });
    });
    return out;
  }

  /* 没有基准可用时的退路:按这个零件自己最吻合的配合件算 */
  function planSnap(t) {
    if (!t || !t.part || t.ok || !t.near.length) return null;
    // 只以「已经判对的配合件」为基准:拿一个自己还没摆正的零件当参照,吸过去还是错的
    var usable = t.near.filter(function (x) { return x.ms.ok; });
    if (!usable.length) return null;
    var best = usable[0];
    usable.forEach(function (x) { if (x.e.score < best.e.score) best = x; });
    var e = best.e;
    if (!e.want || e.reversed || e.nearAng > SNAP_ANG) return null;
    // e.d 量的是零件原点的距离:长零件绕端头的孔歪一点,原点就甩出去很远。
    // 门槛里加上「这点角度差本来就会甩出多远」,判的才是"贴得差不多"而不是"零件多长"
    var swing = partRadius(t.ref.key) * Math.sin(THREE.MathUtils.degToRad(e.nearAng));
    if (e.d > SNAP_POS_MM * KBParts.unitScale() / 1000 + swing) return null;
    var node = t.part.node;
    var world = e.want.clone();
    if (node.parent) {
      node.parent.updateMatrixWorld(true);
      world.premultiply(new THREE.Matrix4().copy(node.parent.matrixWorld).invert());
    }
    var pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    world.decompose(pos, quat, scl);
    return { node: node, pos: pos, quat: quat, name: t.ref.name };
  }

  function inWorkspace(pl) {
    return !window.KBWorkspace || (KBWorkspace.contains(pl.node) && KBWorkspace.contains(pl.node, pl.pos, pl.quat));
  }
  function applySnaps(plans, label) {
    plans = plans.filter(inWorkspace);
    if (!plans.length) return 0;
    snapping = true;
    var left = plans.length;
    plans.forEach(function (pl) {
      KB.finishTween(pl.node);
      KB.tween(pl.node, pl.pos, pl.quat, { duration: 0.3, onDone: function () {
        if (window.KBMate) KBMate.release(pl.node);   // 吸到位后孔轴变了,解掉旧的锁
        if (--left) return;
        snapping = false;
        KB.pushSnapshot();
        KB.toast(label || (plans[0].name + ' snapped into place'));
      } });
    });
    return plans.length;
  }

  /* 这个槽位当前的"差多少":拿最吻合的那个配合件算,没有参照就是无穷 */
  function slotScore(t) {
    if (!t || !t.near.length) return Infinity;
    var best = Infinity;
    t.near.forEach(function (x) { if (x.e.score < best) best = x.e.score; });
    return best;
  }

  /* 一步里的基座:还没放的零件中,别的零件往它孔里插得最多的那个(并列看配合数,再看个头) */
  function baseOf(list) {
    var inStep = {}, best = null;
    list.forEach(function (t) { inStep[t.ref.i] = true; });
    list.forEach(function (t) {
      var inner = t.ref.mates.filter(function (m) { return inStep[m.slot.i]; });
      // 别的零件插进它的孔里 -> 它是被装的那个(楔块之于螺丝)。这条最优先:
      // 光比个头的话,16 mm 的螺丝会比楔块"大",反过来叫人先放螺丝
      var receives = inner.filter(function (m) {
        return (m.features || []).some(function (f) { return String(f[0]).charAt(0) === 'H'; });
      }).length;
      var score = receives * 100 + inner.length * 10 + partRadius(t.ref.key);
      if (!best || score > best.score) best = { score: score, t: t };
    });
    return best ? best.t : null;
  }
  /* 给人看的"这个零件放好了":单独一个基座(比如第一步的楔块)没有配合件可对照,
     判定上永远算不了"到位" —— 按级别自动摆好的,或者已经放进装配区、这一步还没有别的零件装上去的,
     清单里就先打勾。不影响判定:整步完成还是看配合关系 */
  function baseSeated(t) {
    if (!results || !results.ready || !t || t.ok) return false;
    var hit = false, parts = collectParts();
    parts.forEach(function (n) { if (levelPlaced[n.uuid] === t.ref) hit = true; });
    if (hit) return true;
    var st = results.steps[t.ref.step];
    if (!st || st.assembly) return false;
    if (st.slots.some(function (x) { return x.ok || (x.part && x.near.length); })) return false;
    var base = baseOf(st.slots);
    if (!base || base.ref !== t.ref) return false;
    return parts.some(function (n) {
      if (canon(n.userData.kbType.slice(5)) !== t.ref.ckey) return false;
      var s = slotForNode(n);
      if (s && s.ok) return false;
      return !window.KBWorkspace || KBWorkspace.contains(n);
    });
  }
  function slotForNode(node) {
    if (!results || !results.ready) return null;
    for (var i = 0; i < results.slots.length; i++) {
      if (results.slots[i].part && results.slots[i].part.node === node) return results.slots[i];
    }
    return null;
  }

  function snapIntoPlace(node) {
    if (snapping || !node || !KB.isPart(node) || !KB.tween) return false;   // autoSnap 只管"放下即吸",手动 S 不受它限制
    if (!(window.KBParts && KBParts.ready())) return false;
    evaluate();
    var t = slotForNode(node), a = anchorSlot();
    var pl = (a && planVia(a, t)) || planSnap(t);
    if (!pl) {   // 还没认领槽位:按最近的空槽位收编
      pl = loosePlans(a).filter(function (x) { return x.node === node; })[0] || null;
    }
    return pl ? !!applySnaps([pl]) : false;
  }

  /* 把所有「已经差不多」的零件一次性归位。
   * 分轮推进:每轮只吸得上有正确参照的零件,吸好的又成为下一轮的参照。
   * 先在内部静默算完最终位姿,再把零件放回原处一起做动画。 */
  function snapAll() {
    if (snapping || !KB.tween || !(window.KBParts && KBParts.ready())) return 0;
    var home = {}, final = {}, before = {};
    evaluate();
    if (results && results.ready) {
      results.slots.forEach(function (t) {
        if (t.part) before[t.part.node.uuid] = slotScore(t);
      });
    }
    for (var pass = 0; pass < 5; pass++) {
      evaluate();
      if (!results || !results.ready) break;
      var anchor = anchorSlot();
      var plans = [];
      results.slots.forEach(function (t) {
        var pl = anchor ? planVia(anchor, t) : planSnap(t);
        if (pl) plans.push(pl);
      });
      // 已认领的都摆好之后,再收编那些"在场上、大概就该放这儿"的零件
      if (!plans.length) plans = loosePlans(anchor);
      plans = plans.filter(inWorkspace);
      if (!plans.length) break;
      plans.forEach(function (pl) {
        var k = pl.node.uuid;
        if (!home[k]) home[k] = { pos: pl.node.position.clone(), quat: pl.node.quaternion.clone() };
        pl.node.position.copy(pl.pos);
        pl.node.quaternion.copy(pl.quat);
        pl.node.updateMatrixWorld(true);
        final[k] = pl;
      });
    }
    function putBack(k) {
      var pl = final[k], h = home[k];
      pl.node.position.copy(h.pos);
      pl.node.quaternion.copy(h.quat);
      pl.node.updateMatrixWorld(true);
      delete final[k];
    }
    // 核一遍:留下确实变好的。要求"吸完必须完全判对"太苛刻 —— 只要配合件自己也偏了一点,
    // 就没有任何位姿能同时满足所有参照,于是明明挪近了也被退回,按钮看着什么都没做。
    for (var v = 0; v < 3; v++) {
      evaluate();
      var bad = Object.keys(final).filter(function (k) {
        var t = slotForNode(final[k].node);
        if (!t) return true;                       // 连槽位都认不出来了:退回
        if (t.ok) return false;
        var was = before[k];
        return !(was !== undefined && slotScore(t) < was - 1e-6);   // 没变好:退回
      });
      if (!bad.length) break;
      bad.forEach(putBack);
    }
    var list = Object.keys(final).map(function (k) { return final[k]; });
    if (!list.length) { KB.toast(whyNothingSnapped()); return 0; }
    list.forEach(function (pl) {                      // 放回原处,交给补间飞过去
      var h = home[pl.node.uuid];
      pl.node.position.copy(h.pos);
      pl.node.quaternion.copy(h.quat);
      pl.node.updateMatrixWorld(true);
    });
    return applySnaps(list, list.length + ' part' + (list.length > 1 ? 's' : '') + ' snapped into place');
  }

  var evalTimer = 0;
  KB.on('place', function (node) { if (autoSnap) setTimeout(function () { snapIntoPlace(node); }, 0); });
  /* S:把选中的零件归位(离正确位置够近才吸,够不着就说一声) */
  var selection = [];
  KB.onSelection(function (sel) { selection = sel.slice(); });
  window.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (e.code !== 'KeyS' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    if (!selection.length) return;
    var n = 0;
    selection.forEach(function (node) {
      node.traverse(function (o) { if (KB.isPart(o) && snapIntoPlace(o)) n += 1; });
    });
    if (!n) KB.toast('Not close enough to snap \u2014 move it nearer to where it belongs');
  });
  KB.on('grab', hideGhost);   // 零件一动,旧虚影就过时了
  KB.onChange(function () {
    hideGhost();
    clearTimeout(evalTimer);
    evalTimer = setTimeout(evaluate, 300);
  });
  elNow.addEventListener('click', evaluate);
  var elSnapAll = document.getElementById('ckSnapAll');
  if (elSnapAll) elSnapAll.addEventListener('click', snapAll);
  elClose.addEventListener('click', function () { panel.style.display = 'none'; });
  btn.addEventListener('click', function () {
    var open = panel.style.display === 'flex';
    panel.style.display = open ? 'none' : 'flex';
    if (!open) evaluate();
  });

  /* 自检:把判定内部状态导成一段文字 —— 隔着截图猜不出来的东西,这一行全在里面 */
  function diagnose() {
    evaluate();
    if (!results || !results.ready) return 'not evaluated';
    var us = KBParts.unitScale();
    var mm = function (w) { return (w / us * 1000).toFixed(1); };
    var anchor = anchorSlot();
    var lines = ['build ' + (KB.build ? KB.build() : '?') +
      ' | ' + results.correct + '/' + results.total + ' parts, ' +
      results.stepsComplete + '/' + results.steps.length + ' steps' +
      ' | anchor: ' + (anchor ? anchor.ref.name : 'none')];
    results.slots.forEach(function (t) {
      if (!t.part) return;
      var viaAnchor = '-';
      if (anchor && t !== anchor) {
        t.part.node.updateMatrixWorld(true);
        var p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), s0 = new THREE.Vector3();
        t.part.node.matrixWorld.decompose(p0, q0, s0);
        var p1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), s1 = new THREE.Vector3();
        wantVia(anchor, t).decompose(p1, q1, s1);
        viaAnchor = mm(p0.distanceTo(p1)) + 'mm/' + angleBetween(q0, q1).toFixed(0) + '\u00b0';
      }
      lines.push([t.ref.name, '<-', t.part.node.name, t.ok ? 'ok' : 'BAD',
        'votes ' + t.agree + '/' + t.disagree, 'vsAnchor ' + viaAnchor,
        'worst ' + (t.err ? mm(t.err.e.d) + 'mm on ' + t.err.m.slot.name : '-')].join(' | '));
    });
    var loose = results.users.filter(function (u) { return !u.slot; });
    if (loose.length) lines.push('unassigned: ' + loose.map(function (u) { return u.node.name; }).join(', '));
    return lines.join('\n');
  }

  // Near-enough placement is corrected transactionally before grouping. Existing
  // subassemblies move rigidly; failed validation restores every original pose.
  function groupReadySteps() {
    if ((KB.interacting && KB.interacting()) || snapping || (window.KBTutorial && KBTutorial.active())) return 0;
    evaluate();
    if (!results || !results.ready) return 0;
    var limit = 5 * KBParts.unitScale() / 1000, count = 0;
    function close(e) { return !e.reversed && e.d <= limit && e.ang <= 15; }
    function top(n) { while (n.parent && n.parent !== KB.objectsRoot) n = n.parent; return n; }
    var indices = results.steps.map(function (s) { return s.i; });
    indices.forEach(function (index) {
      var step = results.steps[index], members = [], roots = [];
      var valid = step.slots.length && step.slots.every(function (t) {
        if (!t.part || (window.KBWorkspace && !KBWorkspace.contains(top(t.part.node)))) return false;
        var links = t.near.filter(function (link) {
          return close(link.e) && (!window.KBWorkspace || KBWorkspace.contains(top(link.ms.part.node)));
        });
        if (!links.length || (!t.ok && links.length <= t.near.length / 2)) return false;
        if (members.indexOf(t) < 0) members.push(t);
        links.forEach(function (link) { if (members.indexOf(link.ms) < 0) members.push(link.ms); });
        return true;
      });
      if (!valid) return;
      members.forEach(function (t) { var n = top(t.part.node); if (roots.indexOf(n) < 0) roots.push(n); });
      if (roots.length < 2) return;
      // Keep the earlier receiving assembly fixed, and prefer an existing group.
      members.sort(function (a, b) { return a.ref.step - b.ref.step || Number(KB.isPart(top(a.part.node))) - Number(KB.isPart(top(b.part.node))) || a.ref.i - b.ref.i; });
      var fixed = [top(step.assembly ? step.base.part.node : members[0].part.node)];
      var saved = roots.map(function (n) { return { n: n, p: n.position.clone(), q: n.quaternion.clone(), s: n.scale.clone() }; });
      var protectedParts = results.slots.filter(function (t) { return t.ok; }).map(function (t) { return t.part.node; });
      var expected = [];
      roots.forEach(function (root) { root.traverse(function (n) { if (KB.isPart(n)) expected.push(n); }); });
      function restore() {
        saved.forEach(function (h) { h.n.position.copy(h.p); h.n.quaternion.copy(h.q); h.n.scale.copy(h.s); h.n.updateMatrixWorld(true); });
        evaluate();
      }
      for (var pass = 0; pass < roots.length; pass++) {
        var advanced = false;
        members.forEach(function (original) {
          var node = original.part.node, root = top(node);
          if (fixed.indexOf(root) >= 0) return;
          var t = step.assembly ? results.steps[index].slots.find(function (s) { return s.part && s.part.node === node; }) : slotForNode(node);
          if (!t) return;
          var link = t.near.filter(function (x) { return fixed.indexOf(top(x.ms.part.node)) >= 0 && close(x.e); })[0];
          if (!link) return;
          node.updateWorldMatrix(true, false); root.updateWorldMatrix(true, true);
          var world = link.e.want.clone().multiply(node.matrixWorld.clone().invert()).multiply(root.matrixWorld);
          if (root.parent) world.premultiply(root.parent.matrixWorld.clone().invert());
          world.decompose(root.position, root.quaternion, root.scale); root.updateMatrixWorld(true);
          fixed.push(root); advanced = true; evaluate();
        });
        if (!advanced) break;
      }
      var ok = fixed.length === roots.length && results.steps[index].complete && expected.concat(protectedParts).every(function (n) {
        var t = slotForNode(n); return t && t.ok;
      }) && roots.every(function (n) { return !window.KBWorkspace || KBWorkspace.contains(n); });
      if (!ok) { restore(); return; }
      if (KB.groupNodes(roots, step.name)) count++; else restore();
    });
    // 小步也合组:一个零件已经装对了、它挨着的配合件也在正确位置,就当场把两边并成一组,
    // 不用等这一步所有零件都到齐(比如电机的四颗螺丝,装好一颗就和机臂连在一起)。
    // 暂放在一边的组件不和别的并;装配区外的不并
    evaluate();
    var merged = true, guard = 0;
    while (merged && guard++ < 80) {
      merged = false;
      results.slots.some(function (t) {
        if (!t.part || !t.ok || staged[t.part.node.uuid]) return false;
        var ra = top(t.part.node);
        if (window.KBWorkspace && !KBWorkspace.contains(ra)) return false;
        return t.near.some(function (link) {
          var ms = link.ms;
          if (!ms.part || !ms.ok || staged[ms.part.node.uuid] || !close(link.e)) return false;
          var rb = top(ms.part.node);
          if (ra === rb || (window.KBWorkspace && !KBWorkspace.contains(rb))) return false;
          var st = ref.steps[Math.max(t.ref.step, ms.ref.step)];
          if (!KB.groupNodes([ra, rb], st ? st.name : 'Assembly')) return false;
          count++; merged = true; evaluate();
          return true;
        });
      });
    }
    evaluate();
    return count;
  }

  /* ---------- 难度分级:算出零件"该去哪" ----------
     一级:点零件,直接飞到答案位姿;二级:点对了孔,位姿由答案给(不用再微调)。
     两者都只是"算目标",动画和交互在 levels.js。 */
  var levelPlaced = Object.create(null);    // 按级别摆放过的零件 uuid -> 参考槽位
  var liftCache = null;
  function refLift() {
    // 参考装配是绕原点、并且倒着采的(桨在最下面),整体抬到台面以上再放进装配区
    // 用零件真实的包围盒量最低点 —— 拿"半径"估的话,扁平的桨会把整机抬到半空
    if (liftCache !== null) return liftCache;
    var minY = Infinity, box = new THREE.Box3();
    ref.slots.forEach(function (sl) {
      var spec = KBParts.spec(sl.key);
      if (!spec || !spec.bbox) return;
      box.min.fromArray(spec.bbox.min); box.max.fromArray(spec.bbox.max);
      minY = Math.min(minY, box.clone().applyMatrix4(sl.M).min.y);
    });
    liftCache = isFinite(minY) ? Math.max(0.01, -minY + 0.01) : 0.5;
    return liftCache;
  }
  /* 参考坐标 -> 世界:场上已判对的基准优先;其次是按级别摆过、还在场上的零件;都没有就摆在装配区正中 */
  function refToWorld() {
    var a = anchorSlot();
    if (a) return new THREE.Matrix4().multiplyMatrices(a.part.M, a.ref.Minv);
    var hit = null;
    collectParts().forEach(function (n) {
      if (hit || !levelPlaced[n.uuid] || staged[n.uuid]) return;
      n.updateMatrixWorld(true);
      hit = new THREE.Matrix4().multiplyMatrices(n.matrixWorld, levelPlaced[n.uuid].Minv);
    });
    if (hit) return hit;
    var c = window.KBWorkspace ? KBWorkspace.center : new THREE.Vector3();
    return new THREE.Matrix4().makeTranslation(c.x, refLift(), c.z);
  }
  /* 答案里没有接近路点的零件(电机螺丝、ESC 垫圈):按零件自己的几何补一个"插入前的那个点" ——
     有杆有头的(螺丝)从杆指向头的方向就是它进来的方向;只有一根轴的(垫圈)沿轴从上方套下来。
     离最终位置 = 零件长度 + 10 mm。给的是世界位姿(和 want 同一个坐标系) */
  // 同一步里零件的先后(答案里没有,按实物装法补):ESC 那一步先放四个垫圈,再把 ESC 压上去
  var FIRST = { esc_4in1: { damper_m2: true } };
  function comesFirst(slotRef) {
    if (!ref || !slotRef) return false;
    var st = ref.steps[slotRef.step], k = canon(slotRef.key);
    return !!(st && st.slots.some(function (o) { var f = FIRST[canon(o.key)]; return f && f[k]; }));
  }
  function fallbackApproach(key, want, slotRef) {
    var sp = KBParts.spec(key);
    if (!sp) return null;
    var mm = KBParts.unitScale() / 1000, out = null;
    var pegs = (sp.pegs || []).slice().sort(function (a, b) { return a.r - b.r; });
    if (pegs.length >= 2) {
      out = new THREE.Vector3().fromArray(pegs[pegs.length - 1].c).sub(new THREE.Vector3().fromArray(pegs[0].c));
    } else {
      var f = pegs[0] || (sp.holes || [])[0];
      if (f) out = new THREE.Vector3().fromArray(f.d);
    }
    if (!out || out.lengthSq() < 1e-10) out = null;
    if (out) out.transformDirection(want);
    if (out && pegs.length < 2) {
      // 只有一根轴(垫圈):朝哪头进不确定 —— 跟同一步里有接近路点的零件走同一个方向(ESC 从下往上,垫圈也是)
      var hint = stepApproachDir(slotRef);
      if (hint ? out.dot(hint) < 0 : out.y < 0) out.negate();
    }
    if (!out) out = new THREE.Vector3(0, 1, 0);
    var len = sp.bbox ? new THREE.Vector3().fromArray(sp.bbox.max).sub(new THREE.Vector3().fromArray(sp.bbox.min)).length() : 10 * mm;
    var d = out.normalize().multiplyScalar(len + 10 * mm);
    return want.clone().premultiply(new THREE.Matrix4().makeTranslation(d.x, d.y, d.z));
  }
  // 同一步里有接近路点的零件,它是从哪边进来的(参考坐标系,单位向量);没有就 null
  function stepApproachDir(slotRef) {
    if (!ref || !slotRef || !ref.steps[slotRef.step]) return null;
    var dir = null;
    ref.steps[slotRef.step].slots.forEach(function (o) {
      if (dir || o === slotRef) return;
      var A = approachOf(o);
      if (!A) return;
      var d = new THREE.Vector3().setFromMatrixPosition(A).sub(new THREE.Vector3().setFromMatrixPosition(o.M));
      if (d.lengthSq() > 1e-10) dir = d.normalize();
    });
    return dir;
  }
  function approachOf(sl) {
    var a = KBParts.answer();
    var d = a && a.parts.filter(function (x) { return x.id === sl.id; })[0];
    if (!d || !d.path || d.path.length < 2) return null;
    var tr = KBParts.nodeTransform(d.key, d.path[0]);
    return new THREE.Matrix4().compose(new THREE.Vector3().fromArray(tr.p),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(tr.r[0], tr.r[1], tr.r[2], 'XYZ')), new THREE.Vector3(1, 1, 1));
  }
  function openSteps() {
    var open = {};
    results.steps.forEach(function (st) { if (st.state === 'available') open[st.i] = true; });
    return open;
  }
  /* 一级:这个零件该去哪。只认"现在能做"的步骤里还空着的位置,按顺序来 */
  function levelTarget(node) {
    evaluate();
    if (!results || !results.ready || !node || !node.userData.kbType) return { reason: 'Parts are still loading' };
    var mine = slotForNode(node);
    if (mine && mine.ok && staged[node.uuid]) return stagedTarget(node, mine);
    if (mine && mine.ok) return { already: true };
    var key = canon(node.userData.kbType.slice(5));
    // 一级严格按引导的顺序:只认当前这一步。推导补的步骤在任务图里没有前置关系,
    // 按"可做"放行的话,立柱 #1 会被当成第 28 步的立柱 #5 飞过去
    var nx = next();
    if (!nx) return { reason: null };
    var pool = results.slots.filter(function (t) {
      return t.ref.ckey === key && !t.ok && (!t.part || t.part.node === node) && t.ref.step === nx.i;
    });
    if (!pool.length) return { reason: null };           // 不属于现在能做的步骤:拿错零件的提示会说
    pool.sort(function (a, b) { return a.ref.i - b.ref.i; });
    var t = pool[0], W = refToWorld();
    var A0 = approachOf(t.ref);
    var want = new THREE.Matrix4().multiplyMatrices(W, t.ref.M), approach = A0 ? new THREE.Matrix4().multiplyMatrices(W, A0) : fallbackApproach(t.ref.key, want, t.ref);
    var off = stageFor(t.ref);
    if (off) {      // 之后要整组装到基座上的零件:先摆在旁边,给基座腾出地方
      var T = new THREE.Matrix4().makeTranslation(off.x, off.y, off.z);
      want.premultiply(T); if (approach) approach.premultiply(T);
    }
    return { slot: t.ref, want: want, approach: approach };
  }
  /* 二级:源零件上点的孔/销 -> 目标零件上点的孔。点对了孔,就给出答案位姿;
     点错了孔说"不是这个孔",两个零件根本不配就说"这两个不装在一起" */
  function featureOf(key, id) {
    var spec = KBParts.spec(key);
    var all = ((spec && spec.holes) || []).concat((spec && spec.pegs) || []);
    return all.filter(function (f) { return f.id === id; })[0] || null;
  }
  function levelMateTarget(srcNode, srcId, dstNode, dstId) {
    evaluate();
    if (!results || !results.ready) return { reason: 'Parts are still loading' };
    var sKey = srcNode.userData.kbType.slice(5), dKey = dstNode.userData.kbType.slice(5);
    var fS = featureOf(sKey, srcId), fD = featureOf(dKey, dstId);
    if (!fS || !fD) return { reason: 'Not that one — try again' };
    dstNode.updateMatrixWorld(true);
    var Md = dstNode.matrixWorld.clone();
    var cD = new THREE.Vector3().fromArray(fD.c).applyMatrix4(Md);
    var aD = new THREE.Vector3().fromArray(fD.d).transformDirection(Md);
    var sMine = slotForNode(srcNode), dMine = slotForNode(dstNode);
    // 同型号还没装好的位置都算候选(包括检查暂时把这个零件归过去的那个)。只看"归过去的那个"的话,
    // 对称的板子会把别的孔位映射到点的孔上:零件装对了孔,却被记成另一颗螺丝,随后报"插错孔"
    var srcSlots = sMine && sMine.ok && staged[srcNode.uuid] ? [sMine] : sMine && sMine.ok ? [] : results.slots.filter(function (t) {
      return t.ref.ckey === canon(sKey) && !t.ok && (!t.part || t.part.node === srcNode);
    });
    var dstSlots = dMine ? [dMine] : results.slots.filter(function (t) { return t.ref.ckey === canon(dKey); });
    var paired = false, best = null, open = openSteps(), nxt = next(), curStep = nxt ? nxt.i : -1;
    var hitTol = 3 * KBParts.unitScale() / 1000;                // 孔位偏 3 mm 以内算点对了孔
    srcSlots.forEach(function (s) {
      dstSlots.forEach(function (d) {
        if (!s.ref.mates.some(function (m) { return m.slot === d.ref; })) return;
        paired = true;
        symTransforms(d.ref.key).forEach(function (Sm, si) {
          var want = new THREE.Matrix4().multiplyMatrices(Md, Sm)
            .multiply(d.ref.Minv).multiply(s.ref.M);
          var cS = new THREE.Vector3().fromArray(fS.c).applyMatrix4(want);
          var aS = new THREE.Vector3().fromArray(fS.d).transformDirection(want);
          if (Math.abs(aS.dot(aD)) < Math.cos(THREE.MathUtils.degToRad(20))) return;
          var off = cS.clone().sub(cD);
          var radial = off.clone().sub(aD.clone().multiplyScalar(off.dot(aD))).length();
          // 先看是不是现在这一步的位置(绝对优先),再看能不能做、贴合多少、要不要经过对称映射。
          // 只按贴合比:采来的位姿有一两毫米误差,对称那一侧的别的零件位置可能"更贴",
          // 零件装对了孔却被记成另一个编号,后面的步骤全乱
          var score = (s.ref.step === curStep ? 0 : open[s.ref.step] ? 1 : 2) + radial + (si ? 0.01 : 0);
          if (radial > hitTol) return;                     // 孔位偏 3 mm 以上:不是这个孔,不参与挑选
          if (!best || score < best.score) best = { s: s, want: want, radial: radial, score: score };
        });
      });
    });
    if (!paired) return { reason: 'These two parts do not go together' };
    if (!best) return { reason: 'Not this hole — look at where the ghost goes' };
    var A0 = approachOf(best.s.ref);
    var W = new THREE.Matrix4().multiplyMatrices(best.want, best.s.ref.Minv);
    return { slot: best.s.ref, want: best.want,
             approach: A0 ? new THREE.Matrix4().multiplyMatrices(W, A0) : fallbackApproach(best.s.ref.key, best.want, best.s.ref) };
  }
  function markLevelPlaced(node, slotRef) {
    if (!node || !slotRef) return;
    levelPlaced[node.uuid] = slotRef;
    if (stageFor(slotRef)) { staged[node.uuid] = true; return; }
    // 装到基座上了:整组都不再是"暂放"
    var top = node; while (top.parent && top.parent !== KB.objectsRoot) top = top.parent;
    top.traverse(function (n) { delete staged[n.uuid]; });
  }
  /* ---------- 一二级:之后要整组装到基座上的组件(比如两个楔块组件之于 X-Lock),先摆在旁边 ----------
     基座还没放时,这些零件的目标位置往外挪一段(沿"基座中心 -> 这一组"的方向),标成暂放;
     暂放的不当基准。基座放好后,点这一组就整组飞进去(一级),或点它的孔再点基座的孔(二级) */
  var staged = Object.create(null);
  var STAGE_MM = 65;
  function stageFor(slotRef) {
    if (!ref || (window.KBLevel && KBLevel.get() > 2)) return null;
    var st = null;
    ref.steps.forEach(function (s) {
      if (st || !s.assembly || s.i <= slotRef.step) return;
      if ([].concat.apply([], s.assembly.groups).indexOf(slotRef.id) >= 0) st = s;
    });
    if (!st) return null;
    var base = ref.byId[st.assembly.base];
    if (!base) return null;
    var baseSlot = results && results.slots[base.i];
    var basePlaced = (baseSlot && baseSlot.part && (!window.KBWorkspace || KBWorkspace.contains(baseSlot.part.node))) ||
      collectParts().some(function (n) { return levelPlaced[n.uuid] === base; });
    if (basePlaced) return null;
    var group = st.assembly.groups.filter(function (g) { return g.indexOf(slotRef.id) >= 0; })[0];
    var gc = new THREE.Vector3(), n = 0;
    group.forEach(function (id) { var r = ref.byId[id]; if (r) { gc.add(new THREE.Vector3().setFromMatrixPosition(r.M)); n++; } });
    if (!n) return null;
    gc.divideScalar(n);
    var dir = gc.sub(new THREE.Vector3().setFromMatrixPosition(base.M)); dir.y = 0;
    if (dir.lengthSq() < 1e-8) return null;
    var W = refToWorld();
    return dir.transformDirection(W).setY(0).normalize().multiplyScalar(STAGE_MM * KBParts.unitScale() / 1000);
  }
  // 暂放的组件:基座放好之后,点它就整组装进基座
  function stagedTarget(node, mine) {
    var nx = next();
    if (!nx || !nx.assembly || [].concat.apply([], nx.assembly.groups).indexOf(mine.ref.id) < 0) return { already: true };
    var base = nx.base;
    var basePlaced = base && ((base.part && base.part.node && (!window.KBWorkspace || KBWorkspace.contains(base.part.node))) ||
      collectParts().some(function (n) { return levelPlaced[n.uuid] === base.ref; }));
    if (!basePlaced) return { reason: 'Place ' + (base ? base.ref.name : 'the base') + ' first \u2014 this goes into it' };
    var W = refToWorld(), want = new THREE.Matrix4().multiplyMatrices(W, mine.ref.M);
    // 从外侧(暂放的那一边)推进去
    node.updateMatrixWorld(true);
    var now = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld), at = new THREE.Vector3().setFromMatrixPosition(want);
    var away = now.sub(at).setY(0);
    var approach = away.lengthSq() > 1e-8 ? want.clone().premultiply(new THREE.Matrix4().makeTranslation(away.x * .45, 0, away.z * .45)) : null;
    return { slot: mine.ref, want: want, approach: approach };
  }

  /* 二级引导:这个零件该点它自己的哪个孔/销,再点装配区里哪个零件的哪个孔。
     不查答案里的特征表(有的配合只记了"接触"),直接算几何:把零件放到最终位置,
     找它哪个孔/销和场上已经装好的零件的哪个孔同轴、对得上 —— 和二级判"点对了没有"是同一个标准。 */
  function worldFeat(f, M) {
    return { c: new THREE.Vector3().fromArray(f.c).applyMatrix4(M),
             d: new THREE.Vector3().fromArray(f.d).transformDirection(M), r: f.r, depth: f.depth, id: f.id,
             kind: f.id.charAt(0) === 'H' ? 'hole' : 'peg' };
  }
  function featsOf(key) {
    var spec = KBParts.spec(key);
    return ((spec && spec.holes) || []).concat((spec && spec.pegs) || []);
  }
  /* 场上哪些孔/销已经被占了:有别的零件的销同轴插在孔里(轴平行、偏心 1.5 mm 内、轴向有重叠)。
     返回 { 'uuid|featId|end': true }(孔口 end = ±1,销 end = 0),被占的孔口和销不再放圆片 */
  function occupied() {
    var feats = [];
    collectParts().forEach(function (n) {
      n.updateMatrixWorld(true);
      featsOf(n.userData.kbType.slice(5)).forEach(function (f) { feats.push({ n: n, w: worldFeat(f, n.matrixWorld) }); });
    });
    var mm = KBParts.unitScale() / 1000, tol = 1.5 * mm, minFree = 2 * mm;
    var cosTol = Math.cos(THREE.MathUtils.degToRad(15)), out = {}, pairs = [];
    feats.forEach(function (a) {
      if (a.w.kind !== 'hole') return;
      feats.forEach(function (b) {
        if (b.w.kind !== 'peg' || b.n === a.n) return;
        if (Math.abs(a.w.d.dot(b.w.d)) < cosTol) return;
        var off = b.w.c.clone().sub(a.w.c);
        var along = off.dot(a.w.d);
        if (Math.abs(along) > (a.w.depth + b.w.depth) / 2) return;
        if (off.addScaledVector(a.w.d, -along).length() > tol) return;
        // 孔在销自己轴上占的那一段
        var t = a.w.c.clone().sub(b.w.c).dot(b.w.d);
        pairs.push({ a: a, b: b, along: along, t: t, sgn: a.w.d.dot(b.w.d) > 0 ? 1 : -1 });
      });
    });
    // 销上没被任何孔包住、又超过 2 mm 的那几截:还露在外面,别的零件还要套上去
    var free = new Map();
    feats.forEach(function (b) {
      if (b.w.kind !== 'peg') return;
      var h = b.w.depth / 2, cov = pairs.filter(function (p) { return p.b === b; })
        .map(function (p) { return [p.t - p.a.w.depth / 2, p.t + p.a.w.depth / 2]; })
        .sort(function (x, y) { return x[0] - y[0]; });
      var segs = [], at = -h;
      cov.forEach(function (c) { if (c[0] - at > minFree) segs.push([at, c[0]]); at = Math.max(at, c[1]); });
      if (h - at > minFree) segs.push([at, h]);
      if (cov.length && !segs.length) out[b.n.uuid + '|' + b.w.id + '|0'] = true;
      free.set(b, segs);
    });
    // 孔口:销盖住了这个孔口,而且从这个孔口往外没有露出来的一截,才算被占。
    // 立柱底下插了螺丝,顶上那头还空着;螺丝穿过板子还露在下面,板子下面那头也还要用
    pairs.forEach(function (p) {
      var a = p.a, b = p.b, segs = free.get(b);
      [-1, 1].forEach(function (e) {
        var m = e * a.w.depth / 2;
        if (Math.abs(m - p.along) > b.w.depth / 2 + tol) return;
        var tm = p.t + e * p.sgn * a.w.depth / 2, out1 = e * p.sgn;
        var open = segs.some(function (sg) { return out1 > 0 ? sg[0] >= tm - tol : sg[1] <= tm + tol; });
        if (!open) out[a.n.uuid + '|' + a.w.id + '|' + e] = true;
      });
    });
    return out;
  }
  function level2Guide(node) {
    var tg = levelTarget(node);
    if (!tg || !tg.want) return null;
    var sKey = node.userData.kbType.slice(5);
    var srcFeats = featsOf(sKey).map(function (f) { return worldFeat(f, tg.want); });
    if (!srcFeats.length) return null;
    // 候选目标:和这个槽位有配合关系、已经在场上摆好的零件
    var partners = [];
    tg.slot.mates.forEach(function (m) {
      var ms = results.slots[m.slot.i], pn = null;
      if (ms && ms.part && (ms.ok || levelPlaced[ms.part.node.uuid])) pn = ms.part.node;
      if (!pn) collectParts().forEach(function (n) { if (!pn && levelPlaced[n.uuid] === m.slot) pn = n; });
      if (!pn && ms && ms.part && window.KBWorkspace && KBWorkspace.contains(ms.part.node)) pn = ms.part.node;
      if (pn && pn !== node) partners.push({ node: pn, step: m.slot.step });
    });
    // 2.5 mm:采来的参考位姿有一两毫米误差(机臂 #1/#2 对后板的孔偏了 1.7 / 1.5 mm),
    // 1.5 mm 会把它们当成"没孔可点"。点的时候判对错的门槛是 3 mm,这里不能比它还严太多
    var tol = 2.5 * KBParts.unitScale() / 1000, cosTol = Math.cos(THREE.MathUtils.degToRad(15));
    var best = null;
    partners.forEach(function (pt) {
      pt.node.updateMatrixWorld(true);
      var dKey = pt.node.userData.kbType.slice(5);
      featsOf(dKey).forEach(function (fd0) {
        if (fd0.id.charAt(0) !== 'H') return;                 // 要点的目标是孔
        var fd = worldFeat(fd0, pt.node.matrixWorld);
        srcFeats.forEach(function (fs) {
          if (Math.abs(fs.d.dot(fd.d)) < cosTol) return;
          var off = fs.c.clone().sub(fd.c);
          var radial = off.clone().sub(fd.d.clone().multiplyScalar(off.dot(fd.d))).length();
          if (radial > tol) return;
          var axial = Math.abs(off.dot(fd.d));
          if (axial > (fs.depth + fd.depth) / 2 + tol * 4) return;   // 同一条轴上,但离得太远就不算
          // 优先刚装上去的那个零件;同一处优先细的那个销(螺丝杆),而不是螺丝头
          var score = pt.step * 10 - radial / tol - (fs.kind === 'peg' ? fs.r / tol : 0);
          if (!best || score > best.score) best = { score: score, fs: fs, fd: fd, node: pt.node };
        });
      });
    });
    if (!best) return null;
    // 目标孔从哪一头进:看零件是从哪边接近的
    var from = tg.approach ? new THREE.Vector3().setFromMatrixPosition(tg.approach) : new THREE.Vector3().setFromMatrixPosition(tg.want).add(new THREE.Vector3(0, 1, 0));
    var dEnd = from.clone().sub(best.fd.c).dot(best.fd.d) >= 0 ? 1 : -1;
    var sEnd = best.fs.kind === 'hole' ? (best.fd.c.clone().sub(best.fs.c).dot(best.fs.d) >= 0 ? 1 : -1) : 0;
    var mouth = best.fd.c.clone().addScaledVector(best.fd.d, dEnd * best.fd.depth / 2);
    return { srcId: best.fs.id, srcEnd: sEnd, dst: best.node, dstId: best.fd.id, dstEnd: dEnd,
             mouth: mouth, axis: best.fd.d.clone().multiplyScalar(dEnd), holeR: best.fd.r };
  }

  /* ---------- 用户真的配上去过的零件 ----------
     料盘里的零件从没被配过,拿这个当门槛,装配区外也能放心判错,
     不会再把托盘里挨着摆的螺丝和立柱说成"装反了" */
  var userMated = Object.create(null);
  KB.on('snapAttempt', function (a) {
    if (!a || !a.success) return;
    [a.object1, a.object2].forEach(function (n) {
      var top = n && (KB.topOf ? KB.topOf(n) : n);
      if (top && top.uuid) userMated[top.uuid] = true;
      if (n && n.uuid) userMated[n.uuid] = true;
    });
  });
  function wasMated(node) {
    if (!node) return false;
    if (userMated[node.uuid]) return true;
    var top = KB.topOf ? KB.topOf(node) : node;
    return !!(top && userMated[top.uuid]);
  }

  /* ---------- 拿错零件:选中 / 抓起一个这一步用不到的零件时当场提醒 ----------
     判定本身只看"零件摆在哪",选中不改变几何,所以这条得挂在交互上。
     说的是"这一步要什么、你手上这个是第几步用的",不拦着操作(可能只是想挪开)。 */
  var warnedFor = null;
  var lastPick = null;      // 手上拿着的这个零件不属于当前步骤 —— 面板里一直挂着,换零件就消
  var lastHole = null;      // 二级:孔点错了 —— 到下一步 / 装对一次就消
  function stepNeeding(node) {
    if (!ref) return null;
    var key = canon(node.userData.kbType.slice(5));
    var best = null;
    ref.steps.forEach(function (st) {
      st.slots.forEach(function (sl) {
        if (canon(sl.key) !== key) return;
        var slot = results && results.slots[sl.i];
        if (slot && slot.ok) return;                 // 这个位置已经装好了
        if (!best || sl.step < best.step) best = sl;
      });
    });
    return best;
  }
  function checkPicked(node) {
    if (!node || !KB.isPart(node) || !node.userData.kbType) return;
    if (!results || !results.ready) return;
    var nx = next();
    if (!nx) return;
    var slot = window.KBCheck && KBCheck.slotOf(node);
    if (slot && slot.ok) return;                     // 已经装到位的零件,随便挪
    var key = canon(node.userData.kbType.slice(5));
    var wanted = nx.slots.filter(function (t) { return !t.ok; });
    // "把预装好的组件装到基座上"这种步骤,零件清单里只有组件,基座(X-Lock)不在里面 ——
    // 不补上的话,点 X-Lock 会被说成"这一步用不到"
    if (nx.base && !nx.base.ok && wanted.indexOf(nx.base) < 0) wanted.push(nx.base);
    if (!wanted.length || wanted.some(function (t) { return canon(t.ref.key) === key; })) { lastPick = null; return; }
    var mine = stepNeeding(node);
    var msg = 'This step needs ' + wanted.map(function (t) { return t.ref.name; }).join(' / ') +
      '. ' + (node.name || 'That part') +
      (mine ? ' belongs to step ' + (mine.step + 1) + ' \u2014 ' + ref.steps[mine.step].name
            : ' is not used in this step');
    lastPick = { node: node, step: nx.i, msg: msg };   // 清单里每次都挂上
    var tag = nx.i + '|' + node.uuid;
    if (warnedFor === tag) return;                   // 弹窗同一步同一个零件只说一次
    warnedFor = tag;
    KB.toast(msg);
    KB.emit('pickWarn', { objectId: node.userData.kbId || null, name: node.name,
      key: node.userData.kbType.slice(5), step: nx.i, stepName: nx.name,
      belongsToStep: mine ? mine.step : null, message: msg });
  }
  KB.onSelection(function (sel) {
    if (sel.length === 1) checkPicked(sel[0]);
    else lastPick = null;
    if (lastPick && sel.indexOf(lastPick.node) < 0) lastPick = null;
    if (window.KBCheck) KBCheck.evaluate();      // 让面板立刻跟上
  });
  KB.on('grab', function (node) { checkPicked(KB.topOf ? KB.topOf(node) : node); });

  window.KBCheck = {
    groupReadySteps: groupReadySteps,
    evaluate: function () { evaluate(); return results; },
    diagnose: diagnose,
    /* 落位吸附开关:放下时离正确位置 10 mm / 25° 以内就吸到参考位姿 */
    autoSnap: function (on) { if (on !== undefined) autoSnap = !!on; return autoSnap; },
    snapIntoPlace: snapIntoPlace,
    levelTarget: levelTarget,
    canon: canon,
    /* 二级点错孔:记一条 error(null 清掉) */
    noteHole: function (node, msg) {
      var nx = next();
      lastHole = node && msg && nx ? { node: node, step: nx.i, msg: msg } : null;
      evaluate();
    },
    /* 参考坐标 -> 世界(场上那台机器实际怎么摆的):focus.js 用它判断机头朝哪 */
    refToWorld: function () { evaluate(); return results && results.ready ? refToWorld() : new THREE.Matrix4(); },
    levelMateTarget: levelMateTarget,
    markLevelPlaced: markLevelPlaced,
    level2Guide: function (node) { evaluate(); return results && results.ready ? level2Guide(node) : null; },
    occupied: function () { return (window.KBParts && KBParts.ready()) ? occupied() : {}; },
    /* 二级:这个零件现在没有可配的孔时,是它自己就是这一步的基座(该直接放进装配区),
       还是得先放别的零件。基座 = 这一步里还没放的零件中,和同一步别的零件配合最多的那个(并列取个头大的) */
    level2Base: function (node) {
      evaluate();
      if (!results || !results.ready) return null;
      var nx = next(), tg = levelTarget(node);
      if (!nx || !tg || !tg.slot) return null;
      if (comesFirst(tg.slot)) return { isBase: true, baseName: tg.slot.name };   // 先放的(垫圈):点一下自己到位
      var open = nx.slots.map(function (t) { return t; }).filter(function (t) {
        if (t.ok) return false;
        var placed = false;
        collectParts().forEach(function (n) { if (levelPlaced[n.uuid] === t.ref) placed = true; });
        return !placed;
      });
      if (nx.base && !nx.base.ok && open.indexOf(nx.base) < 0) open.unshift(nx.base);
      var best = baseOf(open);
      if (!best) return null;
      return { isBase: best.ref === tg.slot, baseName: best.ref.name };
    },
    baseSeated: baseSeated,
    /* 按级别自动摆过、占着哪个参考槽位(没有则 null) */
    levelPlacedSlot: function (node) { return (node && !staged[node.uuid] && levelPlaced[node.uuid]) || null; },
    isStaged: function (node) { return !!(node && staged[node.uuid]); },
    /* 按级别摆过的槽位,暂放的也算(找"还没用过的同型号零件"时要排除它们) */
    placedSlotAny: function (node) { return (node && levelPlaced[node.uuid]) || null; },
    approachFor: function (key, want, slotRef) { return fallbackApproach(key, want, slotRef); },
    comesFirst: comesFirst,
    snapAll: snapAll,
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
