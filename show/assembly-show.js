/* ============================================================
 * 整机装配演示 —— 44 步,实体材质,和仿真台完全分开的一页
 *
 * 数据是同一份:零件库 manifest 的 parts(网格 + offset)和 answer(每件的
 * 接近→落位轨迹、所属步骤)。前 27 步是 ARISTOS 采的,后 17 步是
 * tools/derive_final_assembly.py 按配合关系推的,标成琥珀色。
 *
 * 参考装配是在台面上翻过来装的(电机朝下),这里整体翻 180° 立起来看。
 * ============================================================ */
(function () {
  'use strict';
  var D = window.SHOW_DATA, T = window.THREE;
  var stage = document.getElementById('stage');
  if (!T || !D) { document.getElementById('fallback').hidden = false; return; }

  var SPEC = {};
  D.parts.forEach(function (p) { SPEC[p.key] = p; });
  var S = D.unitScale, MM = S / 1000;

  /* ---------- 材质:按零件族分,别在一片灰里认不出谁是谁 ---------- */
  var MATS = {};
  function mat(key) {
    var f = key.indexOf('screw_') === 0 ? 'screw'
      : key.indexOf('split_') === 0 || key === 'top_plate' ? 'plate'
      : key.indexOf('propeller') === 0 ? 'prop'
      : key.indexOf('camera_plate') === 0 || key === 'aluminum_x_lock' || key.indexOf('aluminum_') === 0 ? 'alu'
      : key === 'esc_4in1' ? 'esc'
      : key === 'arm_5in' ? 'carbon'
      : key === 'motor_2207' ? 'motor'
      : key === 'damper_m2' ? 'rubber' : 'steel';
    if (MATS[f]) return MATS[f];
    var spec = {
      plate:  { color: 0x23272c, metalness: .35, roughness: .62 },
      carbon: { color: 0x1c1f24, metalness: .30, roughness: .55 },
      alu:    { color: 0x9aa3ad, metalness: .92, roughness: .28 },
      steel:  { color: 0xb8bfc7, metalness: .95, roughness: .24 },
      screw:  { color: 0xc6ccd4, metalness: .96, roughness: .20 },
      motor:  { color: 0xe6e9ee, metalness: .70, roughness: .32 },
      prop:   { color: 0xdfe4ea, metalness: .10, roughness: .58 },
      esc:    { color: 0x2f6b4f, metalness: .35, roughness: .55 },
      rubber: { color: 0x2b2f36, metalness: .05, roughness: .90 }
    }[f];
    MATS[f] = new T.MeshStandardMaterial(spec);
    return MATS[f];
  }

  /* ---------- 场景 ---------- */
  var renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  stage.appendChild(renderer.domElement);

  var scene = new T.Scene();
  var camera = new T.PerspectiveCamera(38, 1, 0.05, 300);
  var rig = new T.Group();                 // 参考装配是倒着的,整体翻过来
  rig.rotation.x = Math.PI;
  scene.add(rig);

  scene.add(new T.HemisphereLight(0x9fc0ff, 0x0b0e13, 0.55));
  var key = new T.DirectionalLight(0xffffff, 1.5); key.position.set(4, 7, 5); scene.add(key);
  var fill = new T.DirectionalLight(0x9ab4d8, 0.55); fill.position.set(-6, 3, -4); scene.add(fill);
  var rim = new T.DirectionalLight(0xffd9a0, 0.7); rim.position.set(0, -5, -6); scene.add(rim);

  /* ---------- 零件 ---------- */
  var loader = new T.GLTFLoader();
  var geoms = {}, items = [], stepsById = {};
  D.answer.steps.forEach(function (s) { stepsById[s.i] = s; });

  function b64(s) {
    var bin = atob(s), buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }
  function loadKey(key) {
    return new Promise(function (done) {
      if (geoms[key]) return done(geoms[key]);
      loader.parse(b64(D.files[SPEC[key].file]), '', function (g) {
        var list = [];
        g.scene.updateWorldMatrix(true, true);
        g.scene.traverse(function (n) {
          if (!n.isMesh) return;
          var geo = n.geometry.clone();
          geo.applyMatrix4(n.matrixWorld);
          // 和仿真台一样:v' = S·(v − offset),这样 offset 之后的局部坐标可比
          geo.scale(S, S, S);
          var o = SPEC[key].offset;
          geo.translate(-o[0] * S, -o[1] * S, -o[2] * S);
          geo.computeVertexNormals();
          list.push(geo);
        });
        geoms[key] = list;
        done(list);
      });
    });
  }
  function nodeTransform(key, pose) {
    var e = new T.Euler(pose.roll || 0, pose.pitch || 0, pose.yaw || 0, 'XYZ');
    var q = new T.Quaternion().setFromEuler(e);
    var o = SPEC[key].offset;
    var off = new T.Vector3(o[0] * S, o[1] * S, o[2] * S).applyQuaternion(q);
    return { p: new T.Vector3((pose.x || 0) * MM + off.x, (pose.y || 0) * MM + off.y, (pose.z || 0) * MM + off.z), q: q };
  }

  var DUR = 0.62, LAP = 0.34, STEP_GAP = 0.16;   // 每件飞行时长 / 同一步内错开 / 步与步之间
  var total = 0, center = new T.Vector3(), radius = 4;

  function build(list) {
    // 基准件:和最多零件配合的那个(这台机器是后板)。爆炸图里它不动,
    // 别的零件相对它散开 —— 否则连基准都在飞,看着就是整机散架
    var anchorId = null, most = -1;
    D.answer.parts.forEach(function (d) {
      var n = (d.mates || []).length;
      if (n > most) { most = n; anchorId = d.id; }
    });
    var byStep = {};
    D.answer.parts.forEach(function (d) { (byStep[d.step] = byStep[d.step] || []).push(d); });
    var t = 0.35;
    var box = new T.Box3();
    Object.keys(byStep).map(Number).sort(function (a, b) { return a - b; }).forEach(function (si) {
      var start = t;
      byStep[si].forEach(function (d, n) {
        var g = new T.Group();
        geoms[d.key].forEach(function (geo) { g.add(new T.Mesh(geo, mat(d.key))); });
        g.visible = false;
        rig.add(g);
        var path = d.path.map(function (pose) { return nodeTransform(d.key, pose); });
        if (path.length === 1) path.push(path[0]);
        // 拆的方向就是装的方向反过来:参考轨迹的第一个点是接近位姿,
        // 沿它退出去,一定不会穿过它刚插进去的那个零件
        var back = path[0].p.clone().sub(path[path.length - 1].p);
        if (back.lengthSq() < 1e-6) back.set(0, 1, 0);      // 原地出现的零件:朝上抬
        items.push({ g: g, step: si, name: d.name, path: path, back: back.normalize(),
                     anchor: d.id === anchorId,
                     start: start + n * LAP, derived: !!d.derived });
        box.expandByPoint(path[path.length - 1].p);
        t = Math.max(t, start + n * LAP + DUR);
      });
      t += STEP_GAP;
    });
    total = t + 1.2;
    box.getCenter(center);
    radius = Math.max(box.getSize(new T.Vector3()).length() * 0.62, 2.5);
    rig.position.set(-center.x, -center.y, -center.z);   // 把装配体挪到原点,rig 再整体翻转
  }

  /* ---------- 播放 ---------- */
  var time = 0, playing = true, speed = 1, exploded = false, last = 0;
  function ease(u) { return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }

  function draw() {
    var activeStep = 0;
    items.forEach(function (it) {
      var u = (time - it.start) / DUR;
      if (u <= 0) { it.g.visible = false; return; }
      it.g.visible = true;
      if (u >= 1) u = 1; else activeStep = Math.max(activeStep, it.step);
      if (time >= it.start) activeStep = Math.max(activeStep, it.step);
      var e = ease(u), a = it.path[0], b = it.path[it.path.length - 1];
      it.g.position.lerpVectors(a.p, b.p, e);
      it.g.quaternion.slerpQuaternions(a.q, b.q, e);
      if (exploded && !it.anchor) {
        // 每个零件沿自己的装配方向退出去;越后装的退得越远,
        // 这样同轴的一串(立柱螺丝 / 立柱 / 顶板螺丝)才会拉开而不是叠在一起
        it.g.position.addScaledVector(it.back, 0.9 + it.step * 0.05);
      }
      // 刚落位的那一下轻轻鼓一下,眼睛好跟
      var fresh = 1 - Math.min(1, Math.max(0, (time - (it.start + DUR)) / 0.6));
      it.g.scale.setScalar(1 + (u >= 1 ? 0.03 * fresh : 0));
    });
    setStep(activeStep);
  }
  /* ---------- 镜头:绕着看,遇到新步骤微微推近 ---------- */
  function camAt(tsec) {
    var a = 0.62 + tsec * 0.085;
    // 爆炸图摊得比整机大不少,镜头得往后退,不然桨飞出画面
    var dist = radius * (2.35 - 0.35 * Math.min(1, time / total)) * (exploded ? 1.75 : 1);
    camera.position.set(Math.sin(a) * dist, radius * 0.82 + Math.sin(tsec * 0.23) * radius * 0.16, Math.cos(a) * dist);
    camera.lookAt(0, 0, 0);
  }

  /* ---------- 文案 / 进度 ---------- */
  var elNo = document.getElementById('stepNo'), elTotal = document.getElementById('stepTotal');
  var elPhase = document.getElementById('phase'), elTitle = document.getElementById('title');
  var elParts = document.getElementById('parts'), elOrigin = document.getElementById('origin');
  var elOriginText = document.getElementById('originText');
  var elFill = document.getElementById('fill'), elTicks = document.getElementById('ticks');
  var elList = document.getElementById('list');
  var shown = -1;
  function setStep(i) {
    elFill.style.width = Math.min(100, time / total * 100) + '%';
    Array.prototype.forEach.call(elTicks.children, function (t, n) { t.classList.toggle('on', n === i); });
    Array.prototype.forEach.call(elList.children, function (b, n) {
      b.classList.toggle('on', n === i);
      b.classList.toggle('done', n < i);
    });
    if (i === shown) return;
    shown = i;
    var s = stepsById[i] || { name: '' };
    elNo.textContent = i + 1;
    elPhase.textContent = 'STEP ' + (i + 1);
    elTitle.textContent = s.name;
    elParts.textContent = items.filter(function (it) { return it.step === i; })
      .map(function (it) { return it.name; }).join(' · ');
    elOrigin.classList.toggle('derived', !!s.derived);
    elOriginText.textContent = s.derived ? 'derived from part features' : 'captured by ARISTOS';
    var btn = elList.children[i];
    if (btn) btn.scrollIntoView({ block: 'nearest' });
  }
  function stepStart(i) {
    var first = null;
    items.forEach(function (it) { if (it.step === i && (first === null || it.start < first)) first = it.start; });
    return first === null ? 0 : Math.max(0, first - 0.1);
  }

  function buildUI() {
    elTotal.textContent = D.answer.steps.length;
    D.answer.steps.forEach(function (s) {
      var tick = document.createElement('i');
      tick.style.left = (stepStart(s.i) / total * 100) + '%';
      if (s.derived) tick.classList.add('derived');
      elTicks.appendChild(tick);
      var b = document.createElement('button');
      b.innerHTML = '<em>' + String(s.i + 1).padStart(2, '0') + '</em>' + s.name;
      if (s.derived) b.classList.add('derived');
      b.addEventListener('click', function () { time = stepStart(s.i); draw(); });
      elList.appendChild(b);
    });
  }

  /* ---------- 控件 ---------- */
  var playBtn = document.getElementById('play');
  var icPlay = playBtn.querySelector('.ic-play'), icPause = playBtn.querySelector('.ic-pause');
  function setPlaying(on) { playing = on; icPlay.hidden = on; icPause.hidden = !on; }
  playBtn.addEventListener('click', function () { setPlaying(!playing); });
  document.getElementById('prev').addEventListener('click', function () { time = stepStart(Math.max(0, shown - 1)); draw(); });
  document.getElementById('next').addEventListener('click', function () { time = stepStart(Math.min(D.answer.steps.length - 1, shown + 1)); draw(); });
  var SPEEDS = [0.5, 1, 1.5, 2], si = 1;
  var speedBtn = document.getElementById('speed');
  speedBtn.addEventListener('click', function () {
    si = (si + 1) % SPEEDS.length; speed = SPEEDS[si]; speedBtn.textContent = speed + '×';
  });
  var explodeBtn = document.getElementById('explode');
  explodeBtn.addEventListener('click', function () {
    exploded = !exploded;
    explodeBtn.setAttribute('aria-pressed', String(exploded));
    draw();
  });
  var track = document.getElementById('track'), scrubbing = false;
  function scrub(ev) {
    var r = track.getBoundingClientRect();
    time = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * total;
    draw();
  }
  track.addEventListener('pointerdown', function (ev) { scrubbing = true; track.setPointerCapture(ev.pointerId); scrub(ev); });
  track.addEventListener('pointermove', function (ev) { if (scrubbing) scrub(ev); });
  track.addEventListener('pointerup', function () { scrubbing = false; });
  addEventListener('keydown', function (e) {
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
    if (e.code === 'ArrowRight') { time = stepStart(Math.min(D.answer.steps.length - 1, shown + 1)); draw(); }
    if (e.code === 'ArrowLeft') { time = stepStart(Math.max(0, shown - 1)); draw(); }
    if (e.code === 'KeyE') explodeBtn.click();
  });

  function resize() {
    var w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);

  function tick(now) {
    requestAnimationFrame(tick);
    var dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    if (playing && !scrubbing) {
      time += dt * speed;
      if (time > total) time = 0;
      draw();
    }
    camAt(now / 1000);
    renderer.render(scene, camera);
  }

  Promise.all(Object.keys(SPEC).map(loadKey)).then(function () {
    build();
    buildUI();
    resize();
    setPlaying(true);
    draw();
    document.body.dataset.ready = 'true';
    requestAnimationFrame(tick);
  });
})();
