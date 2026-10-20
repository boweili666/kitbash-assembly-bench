/* ============================================================
 * 零件名字标签 —— 写在零件脚下
 *
 * 82 件里一多半是长得一样的螺丝。以前名字只在属性面板(要先选中)和报错文案里
 * 露过面,没选中的零件人是不知道它叫什么的。
 *
 * 两个区域两条规矩:
 *
 *   料盘(等候区)  每一件都写全名。零件还没上台, 名字就是它此刻唯一的身份 ——
 *                 二十颗一模一样的螺丝里要挑出一颗, 靠的就是 "Standoff #3"
 *                 里那个 3。
 *   装配区        默认不写, **点中了才写**。这里已经搭起来了, 字会盖住
 *                 刚装上的零件和它旁边的孔, 而那正是人在看的东西。
 *
 * 工具栏的 Names 按钮切成"全写", 装配区里的也一起写。
 *
 * 位置是包围盒底面中心的正下方(世界坐标),不是屏幕坐标的正下方 ——
 * 零件躺在料盘里和装进装配区之后朝向不同,跟着屏幕走会压在零件上。
 *
 * 挂在 kbOverlay 组里,所以**抓帧时自动隐藏**:发给 tutor 的画面里没有这些字。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var ALL = 'all', STEP = 'step', OFF = 'off', SELECTED = 'selected';
  // 默认关闭 —— 现在用 bowei 的 tray zone 认零件。API 留着, 以后别的场景
  // 可以 KBNames.set('step'|'all') 打开。
  var mode = OFF;
  var root = new THREE.Group();
  root.userData.kbOverlay = true;          // 抓帧时隐藏,和孔位标签同一个约定
  KB.scene.add(root);

  var tags = [];        // [{node, sprite}]
  var selected = [];    // KB 不导出当前选择, 只给钩子, 所以自己记一份
  KB.onSelection(function (sel) { selected = sel || []; });

  /* 屏幕上看着一样大:字宽按世界单位给,和零件大小无关 */
  function sprite(text) {
    var cv = document.createElement('canvas');
    var ctx = cv.getContext('2d');
    ctx.font = '600 34px "IBM Plex Mono", monospace';
    var w = Math.ceil(ctx.measureText(text).width) + 24;
    cv.width = w; cv.height = 52;
    ctx = cv.getContext('2d');
    ctx.font = '600 34px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(16,20,25,0.92)';
    ctx.lineWidth = 7;
    ctx.strokeText(text, w / 2, 27);
    ctx.fillStyle = '#dfe7ef';
    ctx.fillText(text, w / 2, 27);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true
    }));
    var h = 0.085;      // 全名比缩写长得多, 字小一点才排得开
    sp.scale.set(h * w / 52, h, 1);
    return sp;
  }

  /* 写零件自己的名字, 一个字不改。
     试过缩写: 首字母法出来是 "SS#1", 说不出那是什么; 按词砍又会让
     "Split Rear Plate" 和 "Split Front Plate" 都变成 "Plate"。
     这批名字本来就短(最长 34 个字符, 中位数 13), 全写是最容易读的写法,
     也是唯一不会把两件不同的东西写成同一个词的写法。

     真正让画面糊的是**写了多少件**, 不是每个名字多长 —— 那由 wanted() 管:
     料盘里全写, 装配区里只写点中的和正被点名的那几件。 */
  function textFor(node) {
    var n = node.name || '';
    return n.length > 34 ? n.slice(0, 33) + '…' : n;
  }

  /* 料盘里的零件:还没装上去的都算。装配区外 = 等候区 */
  function inTray(node) {
    return !window.KBWorkspace || !KBWorkspace.contains(node);
  }

  function wanted() {
    var set = [];
    if (mode === OFF) return set;   // 关闭: 一个标签都不画
    function add(n) { if (n && KB.isPart(n) && set.indexOf(n) < 0) set.push(n); }
    // selected: only what was clicked (every part of a clicked assembly), nothing the bench points at
    if (mode === SELECTED) {
      selected.forEach(function (n) { if (n) n.traverse(add); });
      return set;
    }

    KB.objectsRoot.traverse(function (o) {
      if (!KB.isPart(o)) return;
      // 全写模式不分区;平时只写料盘里的
      if (mode === ALL || inTray(o)) add(o);
    });

    // 装配区里的:点中了才写。也包括正被高亮/报错点名的那几件 ——
    // 人正在被要求看它们, 这时候知道它叫什么才有用。
    selected.forEach(add);
    if (window.KBFocus && KBFocus.lit) KBFocus.lit().forEach(add);
    if (window.KBCheck && KBCheck.results && KBCheck.results()) {
      (KBCheck.results().issues || []).forEach(function (i) { add(i.node); });
    }
    return set;
  }

  /* 一样 = 同样这几件, 而且每一件的字也没变(点中会把缩写换成全名) */
  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].node !== b[i] || a[i].text !== textFor(b[i])) return false;
    }
    return true;
  }

  function rebuild(set) {
    tags.forEach(function (t) {
      root.remove(t.sprite);
      t.sprite.material.map.dispose();
      t.sprite.material.dispose();
    });
    tags = set.map(function (node) {
      var sp = sprite(textFor(node));
      if (mode === SELECTED) {
        // the clicked part's name: the same size on screen however far the camera is
        sp.material.sizeAttenuation = false;
        sp.scale.multiplyScalar(TAG_SCREEN_H / sp.scale.y);
        sp.center.set(0, 0.5);           // anchored at its left end, so it starts beside the part
      }
      root.add(sp);
      return { node: node, sprite: sp, text: textFor(node) };
    });
  }

  /* 脚下 = 包围盒底面中心再往下一点。每帧重算,因为零件会被搬动、翻转、成组 */
  var box = new THREE.Box3(), c = new THREE.Vector3(), frame = 0;
  var TAG_SCREEN_H = 0.024;              // selected mode: tag height, a fraction of the view's height
  var corner = new THREE.Vector3(), ndc = new THREE.Vector3();
  // the part's box in its own frame (tighter than a world box when it lies at an angle)
  function localBox(node) {
    var b = new THREE.Box3(), inv = new THREE.Matrix4();
    node.updateMatrixWorld(true);
    inv.copy(node.matrixWorld).invert();
    node.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      b.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)));
    });
    return b;
  }
  // selected mode: just right of the part as seen on screen, level with its middle
  function beside(t) {
    var cam = KB.camera, maxX = -Infinity, lb = t.local || (t.local = localBox(t.node));
    if (lb.isEmpty()) return;
    for (var i = 0; i < 8; i++) {
      corner.set(i & 1 ? lb.max.x : lb.min.x, i & 2 ? lb.max.y : lb.min.y, i & 4 ? lb.max.z : lb.min.z)
        .applyMatrix4(t.node.matrixWorld).project(cam);
      if (corner.x > maxX) maxX = corner.x;
    }
    lb.getCenter(c).applyMatrix4(t.node.matrixWorld);
    ndc.copy(c).project(cam);
    ndc.x = Math.min(maxX + 0.02, 0.98);
    t.sprite.position.copy(ndc.unproject(cam));
  }
  (function tick() {
    requestAnimationFrame(tick);
    // 该写谁每 10 帧重算一次。82 个零件的遍历很便宜, 而且比挂一堆事件可靠 ——
    // 高亮、报错、选中三者都会变, 事件漏一个就出现"名字跟不上高亮"。
    if (frame++ % 10 === 0) {
      var set = wanted();
      if (!sameSet(tags, set)) rebuild(set);
    }
    tags.forEach(function (t) {
      box.setFromObject(t.node);
      if (box.isEmpty()) return;
      box.getCenter(c);
      if (mode === SELECTED) beside(t);
      else t.sprite.position.set(c.x, box.min.y - 0.13, c.z);
    });
  })();

  function paint() {
    var b = document.getElementById('btnNames');
    if (!b) return;
    b.classList.toggle('on', mode === ALL);
    b.setAttribute('aria-pressed', String(mode === ALL));
    var lbl = b.querySelector('.lbl');
    if (lbl) lbl.textContent = mode === ALL ? 'All names' : 'Names';
  }
  var btn = document.getElementById('btnNames');
  if (btn) btn.addEventListener('click', function () {
    mode = mode === ALL ? STEP : ALL;
    rebuild(wanted());
    paint();
  });
  paint();

  function setMode(m) { mode = m === ALL ? ALL : m === OFF ? OFF : m === SELECTED ? SELECTED : STEP; rebuild(wanted()); paint(); }
  // the settings file: ui.nameTags 'off' | 'selected' | 'step' | 'all'
  KB.on('config', function () {
    var m = window.KBConfig && KBConfig.get('ui.nameTags');
    if (m && m !== mode) setMode(m);
  });

  window.KBNames = {
    mode: function () { return mode; },
    set: setMode
  };
})();
