/* 顶部 Help 按钮:卡住时弹出"这一步怎么做"的悬浮窗 —— 按难度的小动画(鼠标点哪儿)、
   要点的零件名、要不要键盘。另外把逐步指引做成常驻:装配时它一直在,不用再按 Next。 */
(function () {
  'use strict';
  var KB = window.KB;
  var btn = document.getElementById('btnHelp');
  if (!btn) return;

  function tutorialOn() { return !!(window.KBTutorial && KBTutorial.active()); }
  function level() { return window.KBLevel ? KBLevel.get() : 3; }

  /* ---------- 小动画:侧视的螺丝进楔块,和难度选择页上的一样 ---------- */
  var HOLE = '#ff2d95', PEG = '#8a4bff', ARMED = '#5ad35a', GLOW = '#ffc81e';
  var PLAN = {
    1: { dur: 3.2, cursor: ['124 66;22 40;22 40;22 40', '0;0.25;0.35;1', 0.4], clicks: [[0.3, 20, 36]],
         screw: ['0 0;0 0;44 0;44 0', '0;0.38;0.66;1'] },
    2: { dur: 3.8, cursor: ['124 66;57 40;57 40;94 40;94 40', '0;0.18;0.3;0.44;1', 0.56], clicks: [[0.22, 56, 36], [0.48, 93, 36]],
         screw: ['0 0;0 0;44 0;44 0', '0;0.52;0.74;1'], arm: 0.22, seat: 0.56 },
    3: { dur: 4.6, cursor: ['124 66;57 40;57 40;94 40;94 40', '0;0.15;0.25;0.37;1', 0.46], clicks: [[0.18, 56, 36], [0.4, 93, 36]],
         screw: ['0 0;0 0;28 0;28 0;36 0;36 0;44 0;44 0', '0;0.43;0.58;0.66;0.7;0.76;0.8;1'], arm: 0.18, seat: 0.46,
         keys: [0.6, 0.94, [0.66, 0.76]] }
  };
  function anim(lv) {
    var p = PLAN[lv], d = 'dur="' + p.dur + 's" repeatCount="indefinite"';
    var disc = function (t, a, b) { return 'values="' + a + ';' + b + '" keyTimes="0;' + t + '" calcMode="discrete"'; };
    var s = '<svg viewBox="0 0 140 72" aria-hidden="true">' +
      '<rect x=".5" y=".5" width="139" height="71" rx="8" fill="#0d1a28" stroke="#ffffff14"/>' +
      '<path d="M8 60H132" stroke="#8fb3c933"/>' +
      '<g><animateTransform attributeName="transform" type="translate" ' + d + ' values="' + p.screw[0] + '" keyTimes="' + p.screw[1] + '"/>' +
      (lv === 1 ? '<rect x="11" y="25" width="48" height="22" rx="7" fill="' + GLOW + '" opacity=".18"><animate attributeName="opacity" values=".1;.3;.1" dur="1.2s" repeatCount="indefinite"/></rect>' : '') +
      '<rect x="14" y="28" width="10" height="16" rx="2" fill="' + (lv === 1 ? GLOW : '#e9eef2') + '"/>' +
      '<rect x="24" y="33" width="32" height="6" rx="1.5" fill="' + (lv === 1 ? '#f1d27a' : '#cfd8de') + '"/>' +
      (lv !== 1 ? '<circle cx="56" cy="36" r="4.2" fill="' + PEG + '" stroke="#07080b"><animate attributeName="fill" ' + d + ' ' + disc(p.arm, PEG, ARMED) + '/></circle>' : '') +
      '</g>' +
      '<path d="M88 14H130V58H100Z" fill="#6b7681" stroke="#aab6bf"/><ellipse cx="93.5" cy="36" rx="2.4" ry="4" fill="#1a232c"/>' +
      (lv !== 1 ? '<circle cx="93" cy="36" r="4.6" fill="' + HOLE + '" stroke="#07080b"><animate attributeName="opacity" ' + d + ' ' + disc(p.seat, '1', '0') + '/></circle>' : '');
    if (p.keys) {
      var k = p.keys, kt = [0].concat(k[2].reduce(function (a, t) { return a.concat([t - 0.01, t, t + 0.04]); }, []), [1]).join(';');
      s += '<g opacity="0"><animate attributeName="opacity" ' + d + ' values="0;0;1;1;0" keyTimes="0;' + (k[0] - 0.02) + ';' + k[0] + ';' + k[1] + ';1"/>' +
        '<g transform="translate(52 50)"><rect width="15" height="15" rx="3" fill="#263a51" stroke="#efbf78"><animate attributeName="fill" ' + d +
        ' values="#263a51;#263a51;#efbf78;#263a51;#263a51;#efbf78;#263a51;#263a51" keyTimes="' + kt + '"/></rect><text x="7.5" y="11.5" text-anchor="middle" font-size="10" fill="#fff1d8">↑</text></g>' +
        '<g transform="translate(70 50)"><rect width="15" height="15" rx="3" fill="#263a51" stroke="#efbf78"/><text x="7.5" y="11.5" text-anchor="middle" font-size="10" fill="#fff1d8">↓</text></g></g>';
    }
    p.clicks.forEach(function (c) {
      s += '<circle cx="' + c[1] + '" cy="' + c[2] + '" r="2" fill="none" stroke="#fff" stroke-width="1.4" opacity="0">' +
        '<animate attributeName="r" ' + d + ' values="2;2;10;10" keyTimes="0;' + c[0] + ';' + (c[0] + 0.09) + ';1"/>' +
        '<animate attributeName="opacity" ' + d + ' values="0;0;.9;0;0" keyTimes="0;' + (c[0] - 0.005) + ';' + c[0] + ';' + (c[0] + 0.09) + ';1"/></circle>';
    });
    s += '<g><animateTransform attributeName="transform" type="translate" ' + d + ' values="' + p.cursor[0] + '" keyTimes="' + p.cursor[1] + '"/>' +
      '<animate attributeName="opacity" ' + d + ' values="0;1;1;0;0" keyTimes="0;0.04;' + (p.cursor[2] - 0.06) + ';' + p.cursor[2] + ';1"/>' +
      '<path d="M0 0L0 12L3.5 9L6 14L8 13L5.5 8.5L10 8.5Z" fill="#fff" stroke="#0b1522"/></g></svg>';
    return s;
  }

  /* ---------- 真实零件的小动画:这一步要拿的零件,按答案轨迹装进它的配合件 ----------
     独立的小渲染器,不动场景里的任何东西。数据不够(比如这一步的底座,没有配合件)时退回上面的示意图 */
  var mini = null;
  var TINT = new THREE.Color(0xe09a00), SPOT = 0x9af2ff, GREEN = 0x5ad35a;
  function kindColor(id) { return String(id).charAt(0) === 'P' ? 0x8a4bff : 0xff2d95; }
  function featLocal(key, id) {
    var sp = KBParts.spec(key), all = ((sp && sp.holes) || []).concat((sp && sp.pegs) || []);
    return all.filter(function (f) { return f.id === id; })[0] || null;
  }
  function discMesh(r, color) {
    var m = new THREE.Mesh(new THREE.RingGeometry(r * 0.35, r * 1.9, 36),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: .95, side: THREE.DoubleSide, depthTest: false, toneMapped: false }));
    m.renderOrder = 10;
    return m;
  }
  // 从场景里取这一步的数据;拿不到就返回 null
  function stepData() {
    var node = window.KBFocus && KBFocus.lit()[0];
    if (!node || !window.KBCheck || !window.KBParts) return null;
    var tg = KBCheck.levelTarget(node);
    if (!tg || !tg.want) return null;
    var g = KBCheck.level2Guide(node);
    // 没有配合孔(一步里第一个放的底座、插进槽里的机臂、放到螺柱上的 ESC):照样用真实零件和真实轨迹,
    // 只是不画孔上的圆片,光标直接点零件
    if (g && !g.dst) g = null;
    var key = node.userData.kbType.slice(5), dkey = g ? g.dst.userData.kbType.slice(5) : null;
    var want = tg.want.clone();
    var wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
    want.decompose(wp, wq, ws);
    // 起点:沿插入方向退出去一段(比接近位姿再远一点),飞入过程看得清
    var size = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3()).length();
    var axis0 = g ? g.axis.clone() : (tg.approach ? new THREE.Vector3().setFromMatrixPosition(tg.approach).sub(wp) : new THREE.Vector3(0, 1, 0));
    if (axis0.lengthSq() < 1e-8) axis0.set(0, 1, 0);
    axis0.normalize();
    var ap = tg.approach ? new THREE.Vector3().setFromMatrixPosition(tg.approach) : wp.clone().addScaledVector(axis0, size * .8);
    var aq = new THREE.Quaternion(); if (tg.approach) tg.approach.decompose(new THREE.Vector3(), aq, new THREE.Vector3()); else aq.copy(wq);
    var back = ap.clone().sub(wp); if (back.lengthSq() < 1e-6) back.copy(axis0).multiplyScalar(size * .8);
    var sp0 = wp.clone().add(back.clone().normalize().multiplyScalar(Math.max(size * 0.9, back.length() * 1.15, 0.25)));
    var fs = g ? featLocal(key, g.srcId) : null, fd = g ? featLocal(dkey, g.dstId) : null;
    // 背景:目标零件所在的整组(比如 X-Lock + 后板);没有配合孔时,就是装配区里已经放好的零件。
    // 真正画哪几个由 Mini 按镜头范围挑
    var ctx = [], add = function (n) { if (KB.isPart(n) && n !== node) { n.updateMatrixWorld(true); ctx.push({ key: n.userData.kbType.slice(5), M: n.matrixWorld.clone() }); } };
    if (g) { var top = g.dst; while (top.parent && top.parent !== KB.objectsRoot) top = top.parent; top.traverse(add); }
    else KB.objectsRoot.traverse(function (n) { if (KB.isPart(n) && (!window.KBWorkspace || KBWorkspace.contains(n))) add(n); });
    return { key: key, dkey: dkey, name: node.name, dname: g ? g.dst.name : '', ctx: ctx,
      want: { p: wp, q: wq }, approach: { p: ap, q: aq }, start: { p: sp0, q: aq.clone() },
      src: fs && fd ? { f: fs, end: g.srcEnd, id: g.srcId } : null, dst: fs && fd ? { f: fd, end: g.dstEnd, id: g.dstId } : null,
      mouth: g ? g.mouth.clone() : wp.clone(), axis: axis0 };
  }
  function Mini(host, data, lv) {
    var W = host.clientWidth || 244, H = Math.round(W * 0.62);
    var R = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    R.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    R.setSize(W, H); R.outputEncoding = THREE.sRGBEncoding; R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.15;
    var scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(32, W / H, .01, 200);
    scene.add(new THREE.HemisphereLight(0xe1eeff, 0x71809a, 1.1));
    var key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(3, 6, 4); scene.add(key);
    var mov = KBParts.instantiate(data.key); scene.add(mov);
    var clickPart = lv === 1 || !data.src;   // 没有孔可点:和一级一样,点零件本身
    if (clickPart) mov.traverse(function (o) { if (o.isMesh) o.material.color.lerp(TINT, .85); });
    var dA = null, dB = null;
    if (lv !== 1 && data.src && data.dst) {
      dA = discMesh(data.src.f.r, lv === 2 ? SPOT : kindColor(data.src.id)); mov.add(dA);
      var f = data.src.f, c = new THREE.Vector3().fromArray(f.c), d = new THREE.Vector3().fromArray(f.d).normalize();
      dA.position.copy(c).addScaledVector(d, (data.src.end || 0) * f.depth / 2 + (data.src.end ? 0.004 * data.src.end : 0));
      dA.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
      dB = discMesh(data.dst.f.r, lv === 2 ? SPOT : kindColor(data.dst.id)); scene.add(dB);
      dB.position.copy(data.mouth).addScaledVector(data.axis, 0.004);
      dB.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), data.axis);
    }
    // 镜头:框住起点到终点的整段轨迹,从插入方向侧上方看
    var box = new THREE.Box3();
    [data.start, data.want].forEach(function (ps) { mov.position.copy(ps.p); mov.quaternion.copy(ps.q); mov.updateMatrixWorld(true); box.expandByObject(mov); });
    box.expandByPoint(data.mouth);
    var ctr = box.getCenter(new THREE.Vector3()), rad = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.25);
    // 配合件:只画镜头范围附近的(整机都在一组时别把几十个零件全实例化)
    var near = box.clone().expandByScalar(rad * 1.5), probe = new THREE.Box3();
    data.ctx.forEach(function (c) {
      var sp = KBParts.spec(c.key);
      if (sp && sp.bbox) { probe.set(new THREE.Vector3().fromArray(sp.bbox.min), new THREE.Vector3().fromArray(sp.bbox.max)).applyMatrix4(c.M); if (!probe.intersectsBox(near)) return; }
      var n = KBParts.instantiate(c.key); n.matrixAutoUpdate = false; n.matrix.copy(c.M); scene.add(n);
    });
    var up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3().crossVectors(data.axis, up);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    // 站在零件进来的那一侧:从板子下面往上插的螺丝,镜头也到下面去,不然被板子挡住
    var below = data.axis.y < -0.3;
    var dir = side.normalize().add(up.clone().multiplyScalar(below ? -.75 : .75)).add(data.axis.clone().multiplyScalar(.35)).normalize();
    var dist = rad / Math.sin(cam.fov * Math.PI / 360) * 1.02;
    cam.position.copy(ctr).addScaledVector(dir, dist); cam.lookAt(ctr); cam.near = dist / 100; cam.far = dist * 20; cam.updateProjectionMatrix();

    host.replaceChildren(R.domElement);
    var cursor = document.createElement('span'); cursor.className = 'hp-cursor';
    cursor.innerHTML = '<svg viewBox="0 0 24 32"><path d="M2 2V25L8 19L13 29L18 26L13 17H23Z" fill="#fff" stroke="#132132" stroke-width="1.5"/></svg>';
    var ripple = document.createElement('span'); ripple.className = 'hp-ripple';
    var cap = document.createElement('span'); cap.className = 'hp-cap';
    var keys = document.createElement('span'); keys.className = 'hp-kkeys'; keys.innerHTML = '<kbd>\u2191</kbd><kbd>\u2193</kbd>';
    host.appendChild(cursor); host.appendChild(ripple); host.appendChild(cap); host.appendChild(keys);

    var DUR = clickPart ? 4200 : lv === 2 ? 5600 : 6600, t0 = performance.now(), raf = 0;
    var sm = function (x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    var tmp = new THREE.Vector3(), q = new THREE.Quaternion();
    function screen(v) { tmp.copy(v).project(cam); return [(tmp.x + 1) / 2 * W, (1 - tmp.y) / 2 * H]; }
    function place(el, xy) { el.style.left = xy[0] + 'px'; el.style.top = xy[1] + 'px'; }
    function poseAt(u) {   // u: 0 = 起点, 0.6 = 接近位姿, 1 = 装好
      if (u < .6) { var k = sm(u / .6); mov.position.lerpVectors(data.start.p, data.approach.p, k); mov.quaternion.copy(data.start.q).slerp(data.approach.q, k); }
      else { var k2 = sm((u - .6) / .4); mov.position.lerpVectors(data.approach.p, data.want.p, k2); mov.quaternion.copy(data.approach.q).slerp(data.want.q, k2); }
      mov.updateMatrixWorld(true);
    }
    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (R.getContext().isContextLost()) return;       // 上下文丢了(画布太多时浏览器会收回):别再往上画
      var t = ((now - t0) % DUR) / DUR, u = 0, clickAt = null, text = '', showKeys = false;
      var aPos = dA ? dA.getWorldPosition(new THREE.Vector3()) : null;
      if (clickPart) {
        u = t < .3 ? 0 : t < .85 ? (t - .3) / .55 : 1;
        text = t < .3 ? (lv === 1 ? 'Click ' + data.name : 'Click ' + data.name + ' \u2014 no hole to pick for this one')
          : t < .85 ? (lv === 3 ? 'Move it here, then line it up' : 'It moves into place by itself') : 'Done \u2014 the next part lights up';
        poseAt(u);
        var mc = new THREE.Box3().setFromObject(mov).getCenter(new THREE.Vector3());
        if (t < .3) { place(cursor, screen(mc)); cursor.hidden = false; if (t > .2) clickAt = screen(mc); } else cursor.hidden = true;
      } else {
        var fly0 = .42, fly1 = lv === 2 ? .86 : .7;
        u = t < fly0 ? 0 : t < fly1 ? (t - fly0) / (fly1 - fly0) * (lv === 2 ? 1 : .8) : lv === 2 ? 1 : (t < .78 ? .8 : t < .9 ? .8 + .2 * sm((t - .78) / .12) : 1);
        poseAt(u);
        if (dA) dA.material.color.set(t > .18 ? GREEN : (lv === 2 ? SPOT : kindColor(data.src.id)));
        if (dB) dB.visible = u < .99;
        var aXY = aPos ? screen(dA.getWorldPosition(new THREE.Vector3())) : screen(data.start.p), bXY = screen(data.mouth);
        if (t < .18) { place(cursor, aXY); if (t > .12) clickAt = aXY; }
        else if (t < fly0) { var k = sm((t - .18) / .16); place(cursor, [aXY[0] + (bXY[0] - aXY[0]) * k, aXY[1] + (bXY[1] - aXY[1]) * k]); if (t > .34) clickAt = bXY; }
        cursor.hidden = t >= fly0;
        text = t < .18 ? '1 \u00b7 Click the ' + (lv === 2 ? 'cyan' : 'glowing') + ' disc on ' + data.name
          : t < fly0 ? '2 \u00b7 Click the disc where it goes on ' + data.dname
          : lv === 2 ? (u < 1 ? 'It seats itself \u2014 no keyboard needed' : 'Done')
          : t < .78 ? 'It snaps onto the hole' : t < .92 ? '3 \u00b7 \u2191 / \u2193 slide it the rest of the way' : 'Done \u2014 check it is flush';
        showKeys = lv === 3 && t >= .76 && t < .94;
      }
      ripple.hidden = !clickAt;
      if (clickAt) place(ripple, clickAt);
      keys.hidden = !showKeys;
      if (cap.textContent !== text) cap.textContent = text;
      R.render(scene, cam);
    }
    raf = requestAnimationFrame(frame);
    return { seek: function (frac) { t0 = performance.now() - frac * DUR; }, stop: function () {
      cancelAnimationFrame(raf);
      scene.traverse(function (o) { if (o.isMesh) { if (!o.userData.kbShared) o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); }); } });
      R.dispose(); R.forceContextLoss(); host.replaceChildren();
    } };
  }

  /* ---------- 这一步要点什么 ---------- */
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function content() {
    var lv = level(), st = window.KBCheck && KBCheck.next();
    var lit = window.KBFocus ? KBFocus.lit() : [];
    var part = lit[0] ? lit[0].name : null, target = null, base = false;
    if (lit[0] && window.KBCheck && lv === 2) {
      var g = KBCheck.level2Guide(lit[0]);
      if (g && g.dst) target = g.dst.name;
      else base = true;                  // 这一步的底座:没有孔可点,点一下就自己进装配区
    }
    var cap = lv === 1 || base ? 'Click the yellow part once \u2014 it moves into place by itself'
      : lv === 2 ? 'Click its cyan disc, then the disc where it goes'
      : 'Click a disc, then the disc where it goes \u2014 then \u2191 / \u2193 to fine-tune';
    return {
      title: tutorialOn() ? 'Practice \u00b7 Level ' + lv : st ? 'Step ' + (st.i + 1) + ' \u00b7 ' + esc(st.name) : 'Nothing left to do',
      body: '<div class="hp-anim">' + anim(base ? 1 : lv) + '<span class="hp-cap">' + esc(cap) + '</span></div>'
    };
  }

  /* ---------- 悬浮窗 ---------- */
  var pop = document.createElement('aside');
  pop.id = 'helpPop'; pop.hidden = true;
  pop.setAttribute('aria-label', 'How to do this step');
  pop.innerHTML = '<div class="hp-head"><span class="hp-kicker">HOW TO DO THIS STEP</span><button class="hp-x" aria-label="Close help">×</button></div>' +
    '<h2 class="hp-title"></h2><div class="hp-body"></div>';
  document.body.appendChild(pop);
  function render() {
    var c = content();
    if (mini) { mini.stop(); mini = null; }
    pop.querySelector('.hp-title').innerHTML = c.title;
    pop.querySelector('.hp-body').innerHTML = c.body;
    // 有真实零件的数据就换成真实零件的动画
    var data = null;
    try { data = stepData(); } catch (e) { data = null; }
    if (data) {
      var host = pop.querySelector('.hp-anim');
      host.classList.add('real');
      try { mini = Mini(host, data, level()); } catch (e) { mini = null; host.classList.remove('real'); host.innerHTML = anim(level()); }
    }
  }
  // 和推荐视角卡片占同一个位置:打开时把卡片盖住(卡片本身也能带人去看零件),关掉再露出来
  function open() { render(); pop.hidden = false; document.body.classList.add('help-open'); btn.classList.add('on'); btn.classList.remove('nudge'); KB.emit('help', { open: true }); }
  function close() { pop.hidden = true; document.body.classList.remove('help-open'); btn.classList.remove('on'); if (mini) { mini.stop(); mini = null; } KB.emit('help', { open: false }); }
  btn.addEventListener('click', function () { if (pop.hidden) open(); else close(); });
  pop.querySelector('.hp-x').addEventListener('click', close);
  // 打开着的时候,步骤 / 难度变了就跟着换内容
  var reTimer = 0;
  function reRender() { if (pop.hidden) return; clearTimeout(reTimer); reTimer = setTimeout(render, 500); }
  KB.onChange(reRender);
  KB.on('levelChange', reRender);
  KB.on('tutorialEnd', reRender);

  /* ---------- 卡住了:这一步 45 秒没进展,Help 按钮轻轻闪一下 ---------- */
  var lastProgress = performance.now(), lastKey = '';
  setInterval(function () {
    var res = window.KBCheck && KBCheck.results();
    if (!res || !res.ready || tutorialOn()) { lastProgress = performance.now(); return; }
    var key = res.stepsSettled + '|' + res.correct;
    if (key !== lastKey) { lastKey = key; lastProgress = performance.now(); btn.classList.remove('nudge'); return; }
    if (pop.hidden && performance.now() - lastProgress > 45000 && KBCheck.next()) btn.classList.add('nudge');
  }, 1000);

  /* ---------- 逐步指引常驻:装配时一直开着,不用按 Next ---------- */
  // 开不起来(比如场上还没东西可当参照)时会弹提示 —— 场面没变就别每 1.5 秒重试一次
  var lastTry = '';
  function ensureGuide() {
    if (tutorialOn() || !window.KBAnswer || !window.KBCheck || !(window.KBParts && KBParts.ready())) return;
    if (KBAnswer.playing()) { lastTry = ''; return; }
    if (KB.interacting() || !KB.objectsRoot.children.length) return;
    var res = KBCheck.evaluate();
    if (!res || !res.ready || !KBCheck.next()) return;     // 全装完了
    var key = res.stepsSettled + '|' + res.correct + '|' + KB.objectsRoot.children.length + '|' + level();
    if (key === lastTry) return;
    lastTry = key;
    KBAnswer.showNext();
  }
  setInterval(ensureGuide, 1500);

  window.KBHelp = { open: open, close: close, isOpen: function () { return !pop.hidden; },
    seek: function (frac) { if (mini) mini.seek(frac); } };   // 调试 / 截图用
})();
