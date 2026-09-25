/* ============================================================
 * Demo mode - a fourth button next to Level 1 / 2 / 3
 *
 * Workspace only: the tray and every part not yet used are hidden, panels are put away.
 * Parts fly into place one by one in step order (the Level 1 "click and it moves into
 * place" flight: approach pose, then seat, camera following).
 * A bar at the bottom: step progress, pause / play, replay, exit.
 * The scene from before the demo is kept and restored on exit (or on switching back to
 * 1 / 2 / 3), so the demo leaves no trace.
 * Entry points: toolbar Demo, URL ?level=demo, host kb:setLevel {level:'demo'}.
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var GAP_MS = 450;          // pause after each part lands so it can be seen
  var STEP_GAP_MS = 900;     // a longer pause between steps

  var on = false, paused = false, finished = false;
  var saved = null, prevLevel = 3, timer = 0, stuck = 0, lastStep = -1;
  var hidden = [];           // top-level nodes hidden because they are still in the tray

  /* ---------- Playback bar ---------- */
  var bar = document.createElement('div');
  bar.id = 'demoBar'; bar.className = 'float'; bar.hidden = true;
  bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Demo playback');
  bar.innerHTML = '<span class="db-tag">DEMO</span>' +
    '<span class="db-step"><b class="db-count"></b><span class="db-name"></span></span>' +
    '<span class="db-prog"><i></i></span>' +
    '<button class="db-pause" title="Pause (Space)">Pause</button>' +
    '<button class="db-replay" title="Play the whole build again">Replay</button>' +
    '<button class="db-exit" title="Leave the demo and go back to your build (Esc)">Exit</button>';
  document.body.appendChild(bar);
  var elCount = bar.querySelector('.db-count'), elName = bar.querySelector('.db-name');
  var elProg = bar.querySelector('.db-prog i'), elPause = bar.querySelector('.db-pause');

  var seg = document.getElementById('levelSeg');
  var btn = document.createElement('button');
  btn.dataset.demo = '1';
  btn.textContent = 'Demo';
  btn.title = 'Demo — watch the whole build play itself, step by step';
  btn.setAttribute('aria-pressed', 'false');
  if (seg) seg.appendChild(btn);

  function paint() {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    // while the demo runs none of 1 / 2 / 3 is selected
    if (seg) Array.prototype.forEach.call(seg.querySelectorAll('button[data-level]'), function (b) {
      if (on) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }
      else { var o = +b.dataset.level === KBLevel.get(); b.classList.toggle('on', o); b.setAttribute('aria-pressed', String(o)); }
    });
    document.body.classList.toggle('demo-mode', on);
    bar.hidden = !on;
    elPause.textContent = finished ? 'Done' : paused ? 'Play' : 'Pause';
    elPause.disabled = finished;
  }
  function progress(st) {
    var res = KBCheck.results(), total = res && res.steps ? res.steps.length : 0;
    var doneN = res ? res.stepsSettled : 0;
    if (finished) { elCount.textContent = 'All ' + total + ' steps'; elName.textContent = 'The drone is assembled'; }
    else if (st) {
      elCount.textContent = 'Step ' + (st.i + 1) + ' / ' + total;
      elName.textContent = st.name || '';
    }
    elProg.style.width = total ? Math.round(100 * (finished ? 1 : doneN / total)) + '%' : '0';
  }

  /* ---------- Workspace only ---------- */
  // the tray zones and the floor grid (mostly under the tray); the workspace keeps its own outline
  function trayScenery() { return KB.scene.children.filter(function (o) { return o.name === 'Parts tray' || o.type === 'GridHelper'; }); }
  function scenery(show) { trayScenery().forEach(function (o) { o.visible = show; }); }
  function hideTray() {
    hidden = [];
    KB.objectsRoot.children.forEach(function (n) {
      if (n.visible && window.KBWorkspace && !KBWorkspace.contains(n)) { n.visible = false; hidden.push(n); }
    });
    scenery(false);
  }
  function reveal(node) {
    var top = KB.topOf ? KB.topOf(node) : node;
    top.visible = true;
    var i = hidden.indexOf(top); if (i >= 0) hidden.splice(i, 1);
  }
  function showAll() {
    hidden.forEach(function (n) { n.visible = true; });
    hidden = [];
    scenery(true);
  }
  function frameWorkspace(spin) {
    var box = new THREE.Box3();
    KB.objectsRoot.traverse(function (n) { if (KB.isPart(n) && n.visible && (!window.KBWorkspace || KBWorkspace.contains(n))) box.expandByObject(n); });
    if (box.isEmpty()) { if (window.KBWorkspace) KBWorkspace.look('work'); }
    else {
      var c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.9, 2);
      KB.flyCamera([c.x + r * 0.9, c.y + r * 0.7, c.z + r * 0.9], [c.x, c.y, c.z]);
    }
    if (KB.orbit) { KB.orbit.autoRotate = !!spin; KB.orbit.autoRotateSpeed = 0.8; }
  }

  /* ---------- One part after another ---------- */
  function later(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }
  function tick() {
    timer = 0;
    if (!on || paused || finished) return;
    if (KB.interacting() || (KB.tweening && KB.tweening()) || KBLevel.busy()) { later(250); return; }
    KBCheck.evaluate();
    var st = KBCheck.next();
    if (!st) { finish(); return; }
    if (st.i !== lastStep && lastStep >= 0 && stuck === 0) {   // new step: pause first
      lastStep = st.i; progress(st); later(STEP_GAP_MS); return;
    }
    lastStep = st.i;
    progress(st);
    var nodes = window.KBFocus ? KBFocus.partsToMove(st) : [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      reveal(n);
      if (KBLevel.place(n, true, function () { stuck = 0; later(GAP_MS); })) return;
    }
    // nothing in this step can be placed: wait a little (grouping / checks catching up), then give up instead of spinning
    if (++stuck > 8) {
      finished = true; paint(); progress(st);
      elName.textContent = 'Stopped at step ' + (st.i + 1) + ' — ' + (st.name || '');
      return;
    }
    later(500);
  }
  function finish() {
    finished = true;
    // spare parts the build does not use stay hidden
    paint(); progress(null);
    frameWorkspace(true);
  }

  /* ---------- Enter / leave ---------- */
  function start() {
    if (on) return;
    if (!(window.KBCheck && window.KBLevel && window.KBParts && KBParts.ready())) { KB.toast('Parts are still loading'); return; }
    if (window.KBTutorial && KBTutorial.active()) { KB.toast('Finish or close the tutorial first'); return; }
    saved = JSON.stringify(KB.serializeScene());
    prevLevel = KBLevel.get();
    on = true; paused = false; finished = false; stuck = 0; lastStep = -1;
    if (window.KBHelp) KBHelp.close();
    if (window.KBCelebrate) KBCelebrate.hide();
    if (window.KBAnswer) KBAnswer.hide();
    if (window.KBMate && KBMate.cancel) KBMate.cancel();
    KB.setSelection([]);
    KBLevel.set(1, true);           // borrow the Level 1 flight; the saved level is put back on exit
    paint();
    hideTray();
    frameWorkspace(false);
    KB.emit('demo', { on: true });
    later(1200);
  }
  function stop(restore) {
    if (!on) return;
    clearTimeout(timer); timer = 0;
    on = false; paused = false; finished = false;
    if (KB.finishTween) KB.finishTween();
    if (KB.orbit) KB.orbit.autoRotate = false;
    showAll();
    if (restore !== false && saved) {
      KB.loadSceneData(JSON.parse(saved), true);
      KB.pushSnapshot(true);
    }
    saved = null;
    KBLevel.set(prevLevel, true);
    paint();
    if (window.KBCelebrate) KBCelebrate.reset();
    if (window.KBFocus) KBFocus.refresh();
    if (window.KBWorkspace) KBWorkspace.look('work');
    KB.emit('demo', { on: false });
  }
  function replay() {
    if (!on || !saved) return;
    clearTimeout(timer);
    if (KB.finishTween) KB.finishTween();
    if (KB.orbit) KB.orbit.autoRotate = false;
    showAll();
    KB.loadSceneData(JSON.parse(saved), true);
    KB.pushSnapshot(true);
    paused = false; finished = false; stuck = 0; lastStep = -1;
    paint();
    hideTray();
    frameWorkspace(false);
    later(900);
  }
  function togglePause() {
    if (!on || finished) return;
    paused = !paused;
    paint();
    if (!paused) later(0);
  }

  btn.addEventListener('click', function () { if (on) stop(); else start(); });
  // clicking 1 / 2 / 3 during the demo leaves it first (scene restored), then switches level
  if (seg) seg.addEventListener('click', function (e) {
    if (on && e.target.closest('button[data-level]')) stop();
  }, true);
  elPause.addEventListener('click', togglePause);
  bar.querySelector('.db-replay').addEventListener('click', replay);
  bar.querySelector('.db-exit').addEventListener('click', function () { stop(); });
  window.addEventListener('keydown', function (e) {
    if (!on || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); stop(); }
    else if (e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); togglePause(); }
    else if (/^(Arrow|Key[WERQGSVBP]|Delete|Backspace)/.test(e.code) || e.ctrlKey || e.metaKey) e.stopImmediatePropagation();  // no moving parts during the demo
  }, true);
  // watch only: clicking a part does not select it (hidden parts are still hit by the raycaster)
  KB.onSelection(function (sel) { if (on && sel.length) setTimeout(function () { KB.setSelection([]); }, 0); });
  // any camera move stops the end-of-demo auto rotation
  ['pointerdown', 'wheel'].forEach(function (ev) {
    window.addEventListener(ev, function () { if (on && finished && KB.orbit) KB.orbit.autoRotate = false; }, true);
  });

  window.KBDemo = { active: function () { return on; }, start: start, stop: stop, replay: replay,
                    pause: function (p) { if (on && !finished && !!p !== paused) togglePause(); return paused; },
                    finished: function () { return finished; } };

  // ?level=demo: start once the parts are loaded
  if (new URLSearchParams(location.search).get('level') === 'demo') {
    (function wait() { if (window.KBParts && KBParts.ready() && window.KBCheck && KBCheck.results()) setTimeout(start, 800); else setTimeout(wait, 200); })();
  }
})();
