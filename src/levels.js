/* ============================================================
 * 难度分级
 *
 *   Level 1  点零件 —— 它自己飞到答案位姿(按步骤顺序,只认现在能做的那一步)
 *   Level 2  点孔 —— 点对了孔,零件自己摆正、插到底,不用再用方向键微调;
 *            点错了孔会被拒绝并说明原因
 *   Level 3  现在的做法:点孔配合,方向键自己调
 *
 * 位姿怎么算在 check.js(levelTarget / levelMateTarget),这里只管交互和动画。
 * 教程进行中一律按 Level 3 走 —— 教程教的就是点孔。
 * 级别来源:URL ?level=、ARISTOS 的 kb:init options.level / kb:setLevel、工具栏按钮;
 * 记在 localStorage 里,下次打开还是这一级。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var KEY = 'kb.level';
  var DEFAULT = 1;          // 先照顾不会的人:没选过就从最简单的开始
  var level = DEFAULT;
  var busy = false;

  function clamp(n) { n = parseInt(n, 10); return n >= 1 && n <= 3 ? n : null; }
  (function initial() {
    var fromUrl = clamp(new URLSearchParams(location.search).get('level'));
    var saved = null;
    try { saved = clamp(localStorage.getItem(KEY)); } catch (e) { /* 隐私模式 */ }
    level = fromUrl || saved || DEFAULT;
  })();

  function tutorialOn() { return !!(window.KBTutorial && KBTutorial.active()); }

  /* ---------- 飞过去:先到接近位姿,再落位 —— 和点孔配合是同一种手感 ---------- */
  function toParentLocal(node, world) {
    var m = world.clone();
    if (node.parent) {
      node.parent.updateMatrixWorld(true);
      m.premultiply(new THREE.Matrix4().copy(node.parent.matrixWorld).invert());
    }
    var p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    return { p: p, q: q };
  }
  /* 算出来的是"零件本身"该在的世界位姿;零件要是已经跟别的编成了组,就整组一起挪 */
  function moverFor(node, want) {
    var top = KB.topOf ? KB.topOf(node) : node;
    if (top === node) return { node: node, want: want };
    node.updateMatrixWorld(true);
    top.updateMatrixWorld(true);
    var delta = new THREE.Matrix4().multiplyMatrices(want, new THREE.Matrix4().copy(node.matrixWorld).invert());
    return { node: top, want: delta.multiply(top.matrixWorld.clone()) };
  }
  function fly(part, target, then) {
    var mv = moverFor(part, target.want);
    var end = toParentLocal(mv.node, mv.want);
    var start = mv.node.position.clone();
    var via = null;
    if (target.approach) {
      // 接近位姿给的是"零件本身";整组挪时,组跟零件保持现在的相对关系
      var aw = mv.node === part ? target.approach
        : new THREE.Matrix4().multiplyMatrices(target.approach, new THREE.Matrix4().copy(part.matrixWorld).invert())
            .multiply(mv.node.matrixWorld.clone());
      via = toParentLocal(mv.node, aw);
    }
    busy = true;
    KB.emit('grab', mv.node);
    // 告诉 focus.js 零件要飞去哪:用户采用过推荐视角的话,镜头跟着过去
    KB.emit('levelFlight', { node: part, want: target.want.clone(), force: !!target.followCam,
                             approach: target.approach ? target.approach.clone() : null });
    function done(interrupted) {
      busy = false;
      if (interrupted) return;
      KB.emit('place', mv.node);
      KB.pushSnapshot();
      then && then(mv.node);
    }
    var dist = start.distanceTo(via ? via.p : end.p);
    var first = { duration: 0.45 + Math.min(0.45, dist * 0.08), arc: Math.min(0.7, 0.15 + dist * 0.1) };
    if (via) {
      first.onDone = function (interrupted) {
        if (interrupted) { busy = false; return; }
        KB.tween(mv.node, end.p, end.q, { duration: 0.34, onDone: done });
      };
      KB.tween(mv.node, via.p, via.q, first);
    } else {
      first.onDone = done;
      KB.tween(mv.node, end.p, end.q, first);
    }
  }
  /* ---------- Level 1:点零件就到位 ---------- */
  var canvas = document.getElementById('viewport');
  var down = null, clickAt = 0;
  if (canvas) {
    canvas.addEventListener('pointerdown', function (e) { down = e.button === 0 ? [e.clientX, e.clientY] : null; }, true);
    canvas.addEventListener('pointerup', function (e) {
      if (e.button === 0 && down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) <= 5) clickAt = performance.now();
      down = null;
    }, true);
  }
  var queued = null;         // 飞行动画还没结束时点的零件:等前一个落位再飞,别让点击石沉大海
  function placeByClick(node, followCam) {
    if (!window.KBCheck) return;
    if (busy) { queued = node; return; }
    var r = KBCheck.levelTarget(node);
    if (!r || r.already || !r.want) return;       // 已经装好了 / 不属于这一步(另有提示)
    r.followCam = !!followCam;
    fly(node, r, function (moved) {
      KBCheck.markLevelPlaced(node, r.slot);
      KB.setSelection([]);                           // 放好就松手,免得下一下点网格把它又挪走
      KBCheck.evaluate();
      if (queued) { var q = queued; queued = null; placeByClick(q); }
    });
  }
  KB.onSelection(function (sel) {
    if (level !== 1 || tutorialOn() || sel.length !== 1) return;
    if (performance.now() - clickAt > 450) return;   // 只响应真正的点击,程序里设的选择不算
    var node = sel[0];
    if (!KB.isPart(node)) {                          // 点到的是一组:取组里第一个还没到位的零件
      var inner = null;
      node.traverse(function (o) { if (!inner && o !== node && KB.isPart(o)) inner = o; });
      if (!inner) return;
      node = inner;
    }
    placeByClick(node);
  });

  /* ---------- Level 2 引导:先亮零件(focus.js 做的) -> 选中零件后亮它该点的孔
     -> 点了那个孔,再亮装配区里对应的孔,镜头给那个孔特写 ---------- */
  var guide = null, guideFor = null;
  function spot(list) { if (window.KBMate) KBMate.spotlight(list); }
  function clearGuide() {
    if (!guide && !guideFor) return;
    guide = null; guideFor = null;
    spot([]);
  }
  function srcSpot() { return [{ node: guideFor, id: guide.srcId, end: guide.srcEnd }]; }
  KB.onSelection(function (sel) {
    if (level !== 2 || tutorialOn() || !window.KBCheck) return;
    if (sel.length !== 1) { clearGuide(); return; }
    var node = sel[0];
    if (!KB.isPart(node)) {
      var inner = null;
      node.traverse(function (o) { if (!inner && o !== node && KB.isPart(o)) inner = o; });
      node = inner;
    }
    var g = node && KBCheck.level2Guide(node);
    if (!g) {
      clearGuide();
      if (!node) return;
      // 没有可点的孔:要么它就是这一步的基座(还没东西可配)——点一下直接放进装配区;
      // 要么得先放它要装上去的那个零件
      var b = KBCheck.level2Base(node);
      var clicked = performance.now() - clickAt < 450;
      // 二级里基座放进装配区后镜头一定跟过去:接下来要点的孔就在那儿
      if (b && b.isBase) { if (clicked) placeByClick(node, true); }
      else if (b && b.baseName) KB.toast('Place ' + b.baseName + ' first \u2014 this part goes into it');
      else if (clicked) placeByClick(node, true);          // 只贴合、没有孔可点的零件:和一级一样直接到位
      return;
    }
    guide = g; guideFor = node;
    spot(srcSpot());                                   // spotlight 会顺带按新规则重建圆片
  });
  KB.on('mateArmed', function (a) {
    if (level !== 2 || tutorialOn() || !guide) return;
    if (!a) { spot(srcSpot()); return; }               // 取消了:回到"点这个零件的孔"
    if (a.node !== guideFor) return;
    spot([{ node: guide.dst, id: guide.dstId, end: guide.dstEnd }]);
    closeUp(guide);
  });
  /* 镜头给目标孔特写:站在孔口那一侧,稍微斜一点,别正对着孔里看 */
  function closeUp(g) {
    var c = g.mouth.clone(), dir = g.axis.clone();
    if (Math.abs(dir.y) > 0.8) {
      var side = KB.camera.position.clone().sub(c).setY(0);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 1);
      dir.addScaledVector(side.normalize(), 0.75);
    } else {
      dir.addScaledVector(new THREE.Vector3(0, 1, 0), 0.6);
    }
    dir.normalize();
    var r = Math.max(g.holeR * 12, 0.6);
    var dist = r / Math.tan(THREE.MathUtils.degToRad(KB.camera.fov || 45) / 2) * 1.6;
    var p = c.clone().addScaledVector(dir, dist);
    if (p.y < 0.08) p.y = 0.08;
    KB.flyCamera(p.toArray(), c.toArray());
  }

  /* ---------- 只显示用得上的孔(二、三级都生效) ----------
     - 已经被占的孔/销不显示(有螺丝插在里面了)
     - 选中源孔后:只显示装配区里零件上的空孔,料盘里的不显示;源零件自己只留选中的那个
     - 二级有引导时:选中零件只显示该点的那个;点了之后只显示目标零件上的空孔 */
  if (window.KBMate) hookFilter(); else (function wait() { if (window.KBMate) hookFilter(); else setTimeout(wait, 50); })();
  function hookFilter() {
    KBMate.setFilter({
      begin: function (armedInfo) {
        return { occ: window.KBCheck ? KBCheck.occupied() : {}, armed: armedInfo,
                 guide: level === 2 ? guide : null, guideFor: level === 2 ? guideFor : null };
      },
      keep: function (ctx, node, f, kind) {
        var a = ctx.armed;
        if (a && node === a.node) return f.id === a.id;                   // 源零件只留选中的那个
        if (a) {
          if (window.KBWorkspace && !KBWorkspace.contains(node)) return false;   // 料盘里的零件不是目标
          if (ctx.guide && a.node === ctx.guideFor) return node === ctx.guide.dst && kind === 'hole';
          return true;
        }
        if (ctx.guide && node === ctx.guideFor) return f.id === ctx.guide.srcId;
        return true;
      },
      // 已经插上东西的孔口不显示;孔按孔口算,另一头空着照样显示(立柱顶上还要拧螺丝)
      keepEnd: function (ctx, node, f, kind, end) {
        if (ctx.armed && node === ctx.armed.node) return true;
        if (ctx.guide && node === ctx.guide.dst && f.id === ctx.guide.dstId) return true;   // 引导目标永远留着
        return !ctx.occ[node.uuid + '|' + f.id + '|' + end];
      }
    });
  }

  /* ---------- Level 2:点对了孔,位姿交给答案 ---------- */
  /* ---------- 三级:会报错的装配不执行 ----------
     配合前先问答案:零件不属于这一步、或这两个孔根本对不上 -> 直接拒绝,零件不动;
     放行的,配合完再看一眼:这个零件报了错(比如装反了)-> 退回原位,错误挂在指引卡片上(红) */
  var pendingCheck = null;
  function guard3(src, dst) {
    var r = KBCheck.levelMateTarget(src.node, src.id, dst.node, dst.id);
    if (r.reason) {
      var back = KBCheck.levelMateTarget(dst.node, dst.id, src.node, src.id);
      if (back.reason) { KBCheck.noteHole(src.node, r.reason); return r.reason; }
      r = back;
    }
    var nx = KBCheck.next();
    if (nx && r.slot) {
      var inStep = nx.slots.some(function (t) { return t.ref === r.slot; }) || (nx.base && nx.base.ref === r.slot) || r.slot.step === nx.i;
      if (!inStep) {
        var msg = 'Not yet \u2014 this step is \u201c' + nx.name + '\u201d. ' + (r.slot.name || 'That part') + ' comes later.';
        KBCheck.noteHole(src.node, msg);
        return msg;
      }
    }
    KBCheck.noteHole(null);                 // 这一下点对了:之前点错留下的那条先清掉,不然配合完会被它误判
    var top = src.node; while (top.parent && top.parent !== KB.objectsRoot) top = top.parent;
    pendingCheck = { node: src.node, src: src, dst: dst, top: top, p: top.position.clone(), q: top.quaternion.clone(), at: performance.now() };
    return null;                                                // 放行:照常配合
  }
  KB.on('snapAttempt', function (a) {
    var pc = pendingCheck;
    if (level !== 3 || !pc || !a || a.object1 !== pc.node) return;
    pendingCheck = null;
    if (!a.success) return;
    // 等配合的补间落定、检查跑完,再看这个零件有没有被判错
    (function wait(n) {
      if (((KB.tweening && KB.tweening()) || KB.interacting()) && n < 40) { setTimeout(function () { wait(n + 1); }, 100); return; }
      var res = KBCheck.evaluate();
      if (!res || !res.ready) return;
      var mine = {}; pc.top.traverse(function (x) { if (KB.isPart(x)) mine[x.uuid] = true; });
      var bad = res.issues.filter(function (i) { return i.severity === 'error' && i.key !== 'hole' && i.node && mine[i.node.uuid]; })[0];
      if (!bad) { KBCheck.noteHole(null); return; }
      if (window.KBMate && KBMate.release) KBMate.release(pc.node);
      // 配合当时报了成功,检查判错后撤销:再补一条失败的 handleMatch
      KB.emit('handleMatch', { a: pc.src, b: pc.dst, success: false, error: bad.msg + ' (undone)' });
      KB.tween(pc.top, pc.p, pc.q, { duration: 0.45, onDone: function () { KB.pushSnapshot(); KBCheck.noteHole(pc.node, bad.msg + ' \u2014 undone, try again'); } });
      KB.toast('Not like that \u2014 ' + bad.msg);
    })(0);
  });

  function resolve(src, dst) {
    if (level === 3 && window.KBCheck) return guard3(src, dst);
    if (level !== 2 || !window.KBCheck) return null;
    // 上一个零件还在飞:别放行成"点哪个孔就装哪个孔"(那是三级的装法,误点一下就装进错孔)
    if (busy) return 'Wait for the part to land, then click again';
    var r = KBCheck.levelMateTarget(src.node, src.id, dst.node, dst.id), mover = src.node;
    if (r.reason === 'These two parts do not go together') {
      // 点的顺序反了:先点的零件已经在位(比如装好的楔块组件),该动的是后点的那个(X-Lock)。
      // 两个零件本来就配在一起,就把没到位的那个装过去
      var back = KBCheck.levelMateTarget(dst.node, dst.id, src.node, src.id);
      if (!back.reason) { r = back; mover = dst.node; }
    }
    if (r.reason) { KBCheck.noteHole(src.node, r.reason); return r.reason; }
    KBCheck.noteHole(null);
    clearGuide();
    fly(mover, r, function () {
      KBCheck.markLevelPlaced(mover, r.slot);
      KBCheck.evaluate();
    });
    return 'handled';
  }

  /* ---------- 切换 ---------- */
  var TIPS = {
    1: 'Level 1 — click a part and it moves into place by itself',
    2: 'Level 2 — click the right hole on each part; the part seats itself',
    3: 'Level 3 — mate hole to hole and fine-tune with the arrow keys'
  };
  function paint() {
    var box = document.getElementById('levelSeg');
    if (!box) return;
    Array.prototype.forEach.call(box.querySelectorAll('button[data-level]'), function (b) {
      var on = +b.dataset.level === level;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.body.dataset.level = level;
  }
  function apply() {
    if (level !== 2) clearGuide();
    if (window.KBMate) {
      KBMate.setEnabled(level !== 1);
      KBMate.setResolver(resolve);
    }
    paint();
    if (window.KBCheck && KBCheck.results()) KBCheck.evaluate();   // 报哪些错跟着难度变
  }
  function set(n, quiet) {
    n = clamp(n);
    if (!n) return level;
    level = n;
    try { localStorage.setItem(KEY, String(n)); } catch (e) { /* 隐私模式 */ }
    apply();
    if (!quiet) KB.toast(TIPS[n]);
    KB.emit('levelChange', n);
    if (window.KBCheck) KBCheck.evaluate();
    return level;
  }
  var box = document.getElementById('levelSeg');
  if (box) box.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-level]');
    if (b) set(b.dataset.level);
  });

  window.KBLevel = { get: function () { return level; }, set: set, tips: TIPS, busy: function () { return busy; } };
  // mate.js 在本文件之后加载,等它就绪再接上开关
  (function hook() { if (window.KBMate) apply(); else setTimeout(hook, 50); })();
})();
