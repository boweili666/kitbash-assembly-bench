/* 装完整机:庆祝页 —— 纸屑、用时 / 步数 / 零件 / 难度 / 出错次数,镜头绕着成品慢慢转。
   一台只弹一次;教程练习里不弹。公开网站多两个按钮(再来一台 / 回封面),嵌在 ARISTOS 里只留"看看" */
(function () {
  'use strict';
  var KB = window.KB;
  function tutorialOn() { return !!(window.KBTutorial && KBTutorial.active()); }
  var embedded = document.body.classList.contains('embed');
  var publicSite = /\/sim\.html$/.test(location.pathname) && !embedded;

  /* ---------- 这一台的记录 ---------- */
  var startedAt = 0, mistakes = 0, shown = false;
  function reset() { startedAt = 0; mistakes = 0; shown = false; }
  KB.on('place', function () { if (!tutorialOn() && !startedAt) startedAt = performance.now(); });
  KB.on('handleMatch', function (m) { if (m && !m.success) mistakes++; });
  KB.on('pickWarn', function () { if (!tutorialOn()) mistakes++; });
  KB.on('tutorialEnd', reset);
  var newKit = document.getElementById('btnDemo');       // 工具栏 New:摆一套新零件,重新算
  if (newKit) newKit.addEventListener('click', function () { setTimeout(reset, 0); });

  /* ---------- 页面 ---------- */
  var el = document.createElement('section');
  el.id = 'celebrate'; el.hidden = true;
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Drone assembled');
  el.innerHTML = '<canvas class="cb-confetti" aria-hidden="true"></canvas>' +
    '<div class="cb-card">' +
    '<p class="cb-kicker">ASSEMBLY COMPLETE</p>' +
    '<h2>Drone assembled!</h2>' +
    '<p class="cb-lede">Every part is in place. Nice work.</p>' +
    '<div class="cb-stats"></div>' +
    '<div class="cb-btns"><button class="cb-look">Look around</button>' +
    (publicSite ? '<button class="cb-again">Build again</button><button class="cb-home">Home</button>' : '') +
    '</div></div>';
  document.body.appendChild(el);

  function stat(label, value) { return '<div><b>' + value + '</b><span>' + label + '</span></div>'; }
  function fmtTime(ms) {
    var s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60);
    return m ? m + ' min ' + (s % 60) + ' s' : s + ' s';
  }

  /* ---------- 纸屑 ---------- */
  var cv = el.querySelector('.cb-confetti'), ctx = cv.getContext('2d'), bits = [], raf = 0;
  var COLORS = ['#e8ba78', '#ffc81e', '#67d8b0', '#8fd3f5', '#ff6b9d', '#b69cff'];
  function confetti() {
    var W = cv.width = innerWidth, H = cv.height = innerHeight;
    bits = [];
    for (var i = 0; i < 160; i++) bits.push({ x: Math.random() * W, y: -Math.random() * H * 0.8, vx: (Math.random() - 0.5) * 1.6,
      vy: 1.5 + Math.random() * 2.5, r: 4 + Math.random() * 5, a: Math.random() * 6.28, va: (Math.random() - 0.5) * 0.25,
      c: COLORS[i % COLORS.length] });
    var t0 = performance.now();
    cancelAnimationFrame(raf);
    (function frame(now) {
      ctx.clearRect(0, 0, W, H);
      var alive = false;
      bits.forEach(function (b) {
        b.x += b.vx; b.y += b.vy; b.a += b.va; b.vy += 0.015;
        if (b.y < H + 20) alive = true;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.a);
        ctx.fillStyle = b.c; ctx.fillRect(-b.r / 2, -b.r / 4, b.r, b.r / 2); ctx.restore();
      });
      if (alive && now - t0 < 9000 && !el.hidden) raf = requestAnimationFrame(frame);
    })(t0);
  }

  /* ---------- 弹出 / 收起 ---------- */
  function orbit(on) { if (KB.orbit) { KB.orbit.autoRotate = on; KB.orbit.autoRotateSpeed = 0.8; } }
  function celebrate() {
    shown = true;
    var res = KBCheck.results();
    var lv = window.KBLevel ? KBLevel.get() : 3;
    el.querySelector('.cb-stats').innerHTML =
      stat('time', startedAt ? fmtTime(performance.now() - startedAt) : '—') +
      stat('steps', res.stepsSettled + ' / ' + res.steps.length) +
      stat('parts', res.correct + ' / ' + res.total) +
      stat('level', 'Level ' + lv) +
      stat(mistakes === 1 ? 'mistake' : 'mistakes', mistakes);
    if (window.KBAnswer) KBAnswer.hide();                 // 不用再放下一步的虚影
    if (window.KBHelp) KBHelp.close();
    KB.setSelection([]);
    // 镜头退到能看全整机的地方,再慢慢转
    var box = new THREE.Box3();
    KB.objectsRoot.traverse(function (n) { if (KB.isPart(n) && (!window.KBWorkspace || KBWorkspace.contains(n))) box.expandByObject(n); });
    if (!box.isEmpty()) {
      var c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.9, 2);
      KB.flyCamera([c.x + r * 0.9, c.y + r * 0.7, c.z + r * 0.9], [c.x, c.y, c.z]);
    }
    orbit(true);
    el.hidden = false;
    confetti();
    KB.emit('celebrate', { level: lv, mistakes: mistakes, ms: startedAt ? performance.now() - startedAt : null });
  }
  function close() { el.hidden = true; cancelAnimationFrame(raf); orbit(false); }
  el.querySelector('.cb-look').addEventListener('click', close);
  var again = el.querySelector('.cb-again'), home = el.querySelector('.cb-home');
  if (again) again.addEventListener('click', function () {
    location.href = 'sim.html?start=assembly&level=' + (window.KBLevel ? KBLevel.get() : 3);
  });
  if (home) home.addEventListener('click', function () { location.href = './'; });
  // 用户一动鼠标 / 键盘就停掉自动旋转(关着页面时)
  ['pointerdown', 'wheel', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, function () { if (el.hidden) orbit(false); }, true);
  });

  /* ---------- 什么时候弹:所有步骤都判定完成 ---------- */
  var timer = 0;
  KB.onChange(function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      if (shown || tutorialOn() || !window.KBCheck || KB.interacting() || (KB.tweening && KB.tweening())) return;
      var res = KBCheck.evaluate();
      if (res && res.ready && res.steps.length && res.stepsSettled === res.steps.length) celebrate();
    }, 900);
  });

  window.KBCelebrate = { show: celebrate, hide: close, reset: reset };
})();
