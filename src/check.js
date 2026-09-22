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
        if (!best || score < best.score) {
          best = { score: score, d: d, ang: ang.deg, reversed: reversed, nearAng: nearAng,
            // 期望位姿(配合件当前所在处):用于"往哪个方向差"的说明和虚影
            want: new THREE.Matrix4().multiplyMatrices(um.M, new THREE.Matrix4().compose(_p.clone(), _q.clone(), new THREE.Vector3(1, 1, 1))) };
        }
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
    slots.forEach(function (t) {
      // 跟大多数配合件都对不上的零件:哪怕它自己"没有更早的参照可判",也要点名,
      // 否则真正偏了的那个零件永远不出现在清单里
      if (t.part && t.ok && t.disagree && t.agree < t.disagree) {
        t.ok = false;
        if (!t.err) {
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
          issues.push({ severity: 'warn', node: t.part.node, slot: t.ref, want: e.want,
            msg: t.ref.name + ' is ' + mm(e.d) + ' mm off its place on ' + mate.name + which(t.part.node, e.want) });
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
      if (!t.part || !t.ok) return;
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

  function applySnaps(plans, label) {
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

  window.KBCheck = {
    evaluate: function () { evaluate(); return results; },
    diagnose: diagnose,
    /* 落位吸附开关:放下时离正确位置 10 mm / 25° 以内就吸到参考位姿 */
    autoSnap: function (on) { if (on !== undefined) autoSnap = !!on; return autoSnap; },
    snapIntoPlace: snapIntoPlace,
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
