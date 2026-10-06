/* ============================================================
 * Debug: jump to any step
 *
 * Toolbar "Steps" opens the list of all steps (done / current / to do). Clicking one starts
 * from a fresh kit (the host's kit when embedded), assembles every step before it in one go
 * and leaves that step ready to do, at the current level. One undo snapshot, so Ctrl+Z goes back.
 * Shown on the dev page and the public site; inside a host page (embed) only with ?debug=1, or
 * when kitbash-config.json sets ui.debugButton to true (false hides it everywhere).
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var urlDebug = new URLSearchParams(location.search).get('debug');
  function wanted() {
    var c = window.KBConfig ? KBConfig.get('ui.debugButton') : null;
    if (c === true || c === false) return c;
    if (urlDebug !== null) return !/^(0|false|off)$/i.test(urlDebug);
    return !document.body.classList.contains('embed');
  }

  /* ---------- Button + panel ---------- */
  var btn = document.createElement('button');
  btn.id = 'btnDebug'; btn.className = 'tool'; btn.type = 'button';
  btn.title = 'Debug: jump to any step (the steps before it are assembled for you)';
  btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 5h12M4 10h8M4 15h5"/><path d="M14 12l3 3-3 3"/></svg><span class="lbl">Steps</span>';
  var anchor = document.getElementById('btnErrors') || document.getElementById('btnHelp');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);

  var panel = document.createElement('section');
  panel.id = 'debugSteps'; panel.className = 'float'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Jump to a step');
  panel.innerHTML = '<div class="ds-head"><span class="ds-kicker">DEBUG &middot; JUMP TO STEP</span><button class="ds-x" aria-label="Close">×</button></div>' +
    '<input class="ds-find" type="search" placeholder="Filter steps…" aria-label="Filter steps">' +
    '<ol class="ds-list"></ol>' +
    '<div class="ds-foot"><span>Steps before the one you pick are assembled for you.</span>' +
    '<button class="ds-back" type="button" hidden>\u21a9 Back to before the jump</button></div>';
  document.body.appendChild(panel);
  var list = panel.querySelector('.ds-list'), find = panel.querySelector('.ds-find'), back = panel.querySelector('.ds-back');
  var before = null;          // the scene from before the first jump of this series
  back.addEventListener('click', function () {
    if (!before) return;
    if (window.KBDemo && KBDemo.active()) KBDemo.stop(false);
    KB.loadSceneData(JSON.parse(before), true);
    KB.pushSnapshot(true);
    before = null; back.hidden = true; close();
    if (window.KBFocus) setTimeout(function () { KBFocus.refresh(); }, 300);
    KB.toast('Back to where you were');
  });

  function applyVisibility() {
    var on = wanted();
    btn.style.display = on ? '' : 'none';
    if (!on) panel.hidden = true;
  }
  applyVisibility();
  KB.on('config', applyVisibility);

  function render() {
    var res = window.KBCheck && KBCheck.evaluate();
    if (!res || !res.ready) { list.innerHTML = '<li class="ds-empty">Parts are still loading…</li>'; return; }
    var nx = KBCheck.next(), q = find.value.trim().toLowerCase();
    list.innerHTML = '';
    res.steps.forEach(function (st) {
      var label = (st.i + 1) + ' · ' + st.name;
      if (q && label.toLowerCase().indexOf(q) < 0) return;
      var li = document.createElement('li');
      var b = document.createElement('button'); b.type = 'button'; b.dataset.step = st.i;
      var state = st.state === 'complete' ? 'done' : nx && nx.i === st.i ? 'now' : 'todo';
      b.className = 'ds-step ' + state;
      b.innerHTML = '<span class="ds-n">' + (st.i + 1) + '</span><span class="ds-name"></span><span class="ds-st">' +
        (state === 'done' ? '✓' : state === 'now' ? 'Now' : '') + '</span>';
      b.querySelector('.ds-name').textContent = st.name;
      li.appendChild(b); list.appendChild(li);
    });
    var cur = list.querySelector('.ds-step.now');
    if (cur && !q) cur.scrollIntoView({ block: 'center' });
  }
  function open() { panel.hidden = false; find.value = ''; render(); }
  function close() { panel.hidden = true; }
  btn.addEventListener('click', function () { if (panel.hidden) open(); else close(); });
  panel.querySelector('.ds-x').addEventListener('click', close);
  find.addEventListener('input', render);
  list.addEventListener('click', function (e) {
    var b = e.target.closest('.ds-step');
    if (b) jump(+b.dataset.step);
  });
  window.addEventListener('keydown', function (e) { if (e.code === 'Escape' && !panel.hidden) { e.stopPropagation(); close(); } }, true);

  /* ---------- Jump ---------- */
  function jump(target) {
    if (!(window.KBCheck && window.KBLevel && window.KBFocus)) return;
    if (window.KBTutorial && KBTutorial.active()) { KB.toast('Close the tutorial first'); return; }
    if (window.KBDemo && KBDemo.active()) KBDemo.stop(false);
    if (!before) before = JSON.stringify(KB.serializeScene());
    back.hidden = false;
    if (window.KBCelebrate) KBCelebrate.hide();
    if (KB.finishTween) KB.finishTween();
    KB.setSelection([]);
    if (window.KBDemo && KBDemo.freshKit) KBDemo.freshKit(); else KB.loadKit();
    var level = KBLevel.get(), placed = 0;
    KBLevel.set(1, true);                 // the Level 1 placement does the assembling; the level is put back after
    for (var guard = 0, lastStep = -1; guard < 400; guard++) {
      var res = KBCheck.evaluate();
      if (!res || !res.ready) break;
      var st = KBCheck.next();
      if (!st || st.i >= target) break;
      // a finished step becomes one group, so a later step moves it as a whole (wedge + screw onto the X-Lock)
      if (st.i !== lastStep) { if (lastStep >= 0) KBCheck.groupReadySteps(); lastStep = st.i; }
      var nodes = KBFocus.partsToMove(st), ok = false;
      for (var i = 0; i < nodes.length && !ok; i++) ok = KBLevel.place(nodes[i], false, null, { instant: true, quiet: true });
      if (!ok) break;
      placed++;
    }
    KBLevel.set(level, true);
    KB.pushSnapshot();
    if (window.KBCelebrate) KBCelebrate.reset();
    var now = KBCheck.next();
    close();
    if (window.KBWorkspace) KBWorkspace.look('work');
    if (window.KBFocus) setTimeout(function () { KBFocus.refresh(); }, 300);
    KB.toast(now ? 'Step ' + (now.i + 1) + ' · ' + now.name + (now.i !== target ? ' (step ' + (target + 1) + ' needs this one first)' : '') : 'All steps assembled');
    KB.emit('debugJump', { step: target + 1, at: now ? now.i + 1 : null, placed: placed });
  }

  window.KBDebug = { jump: function (n) { jump(n - 1); }, open: open, close: close };
})();
