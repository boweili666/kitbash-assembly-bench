/* ============================================================
 * Demo mode - a fourth button next to Level 1 / 2 / 3
 *
 * Workspace only: the tray and every part not yet used are hidden, panels are put away.
 * Parts fly into place in step order, substep by substep (a substep is a run of the same
 * kind of part inside a step, e.g. the 4 motor screws, then the motor, then the nut - the
 * same order the highlight uses). Uses the Level 1 flight: approach pose, then seat.
 * A bar at the bottom: step / substep, progress, play / pause or Next, speed, replay, exit.
 * The scene from before the demo is kept and restored on exit, so the demo leaves no trace.
 *
 * Everything is set by options (KBDemo.start(options) / KBDemo.set(options), URL demo.*,
 * host kb:init options.demo, kb:demo {action, options}, kb:setLevel {level:'demo', demo}):
 *   autoplay    true = plays by itself; false = waits for Next at every unit (see by)
 *   by          'part' | 'substep' | 'step' - the unit Next plays (manual mode)
 *   speed       flight and pause speed multiplier (1 = normal, 2 = twice as fast)
 *   gap, substepGap, stepGap   pauses in ms after a part / before a new substep / before a new step
 *   trajectory  'approach' (approach pose then seat) | 'direct' (straight in) | 'answer' (recorded path)
 *   camera      'follow' (follows each part) | 'fixed' (stays where it is; the user can orbit)
 *   from, to    first / last step to play (1-based number or step id); earlier steps are
 *               assembled instantly, the demo ends after `to`
 *   steps       only these steps (numbers or ids); others before them are assembled instantly
 *   fresh       start from a full kit with everything in the tray (default true); false = go on from
 *               the current scene. The kit is the host's scene when embedded (KBDemo.setKit), else the local kit
 *   loop        start over when done
 *   restore     put the scene from before the demo back on exit (default true)
 *   hideTray    hide the tray and the parts still in it (default true)
 *   bar         show the playback bar (default true)
 * Events: KB 'demoProgress' {step, steps, stepId, stepName, substep, substeps, substepName, partId, partName},
 *         'demoEnd' {reason: 'done' | 'stopped' | 'stuck', step}, 'demo' {on}.
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var DEFAULTS = { autoplay: true, by: 'substep', speed: 1, gap: 450, substepGap: 700, stepGap: 1000,
                   trajectory: 'approach', camera: 'follow', from: null, to: null, steps: null,
                   fresh: true, loop: false, restore: true, hideTray: true, bar: true };
  var SPEEDS = [0.5, 1, 2, 4];
  var opt = Object.assign({}, DEFAULTS);
  var urlOpt = null;         // demo.* URL parameters
  // defaults < kitbash-config.json "demo" < URL demo.* < options passed to start()
  function base() { return Object.assign({}, DEFAULTS, window.KBConfig ? KBConfig.get('demo') : null, urlOpt); }

  var on = false, paused = false, finished = false, holding = false, passBoundary = false;
  var saved = null, prevLevel = 3, timer = 0, stuck = 0, loopTimer = 0;
  var cur = null;            // {step, plan:[substeps], sub} of the step being played
  var lastPlayed = null;     // {step, sub} of the last part that flew
  var hidden = [];           // top-level nodes hidden because they are still in the tray
  var kitLoader = null;      // the host's kit (bridge.js); null = the local kit
  function loadStart() {
    if (opt.fresh) { if (kitLoader) kitLoader(); else KB.loadKit(); }
    else if (saved) { KB.loadSceneData(JSON.parse(saved), true); KB.pushSnapshot(true); }
  }

  /* ---------- Options ---------- */
  function norm(o) {
    var out = Object.assign({}, opt);
    Object.keys(o || {}).forEach(function (k) { if (k in DEFAULTS) out[k] = o[k]; });
    out.speed = +out.speed > 0 ? +out.speed : 1;
    ['gap', 'substepGap', 'stepGap'].forEach(function (k) { out[k] = Math.max(0, +out[k] || 0); });
    if (['part', 'substep', 'step'].indexOf(out.by) < 0) out.by = 'substep';
    if (['approach', 'direct', 'answer'].indexOf(out.trajectory) < 0) out.trajectory = 'approach';
    if (['follow', 'fixed'].indexOf(out.camera) < 0) out.camera = 'follow';
    if (typeof out.steps === 'string') out.steps = out.steps.split(',');
    if (out.steps && !out.steps.length) out.steps = null;
    return out;
  }
  function stepList() { var r = KBCheck.results(); return (r && r.steps) || []; }
  // 1-based step number or step id -> 0-based index (null when unknown)
  function stepIndex(x) {
    if (x === null || x === undefined || x === '') return null;
    var list = stepList();
    if (/^\d+$/.test(String(x))) { var n = +x - 1; return n >= 0 && n < list.length ? n : null; }
    for (var i = 0; i < list.length; i++) if (list[i].id === x || list[i].name === x) return list[i].i;
    return null;
  }
  function inPlay(i) {
    var f = stepIndex(opt.from), t = stepIndex(opt.to);
    if (f !== null && i < f) return false;
    if (t !== null && i > t) return false;
    if (opt.steps) return opt.steps.some(function (x) { return stepIndex(x) === i; });
    return true;
  }
  function lastInPlay() {
    var list = stepList(), last = -1;
    list.forEach(function (s) { if (inPlay(s.i)) last = s.i; });
    return last;
  }

  /* ---------- Substeps ---------- */
  function kindOf(node) { return KBCheck.canon(node.userData.kbType ? node.userData.kbType.slice(5) : ''); }
  function baseName(name) { return String(name || '').replace(/\s*#[\d-]+$/, '').replace(/\s*\([A-Z]\)$/, ''); }
  // same order as the highlight (focus.js partsToMove): comesFirst parts first, then runs of one kind
  function planOf(st) {
    // joining pre-built assemblies (the X-Lock step): the base, then each assembly moves as one piece
    if (st.assembly && st.assembly.groups) {
      var plan = [];
      if (st.base && !st.base.ok) plan.push({ kind: null, count: 1, left: 1, label: baseName(st.base.ref.name) });
      st.assembly.groups.forEach(function () { plan.push({ kind: null, count: 1, left: 1, label: null }); });
      return plan;
    }
    var slots = st.slots.slice();
    if (st.base && !st.base.ok && slots.indexOf(st.base) < 0) slots.unshift(st.base);
    slots.sort(function (a, b) { return Number(KBCheck.comesFirst(b.ref)) - Number(KBCheck.comesFirst(a.ref)); });
    var subs = [];
    slots.forEach(function (t) {
      if (t.ok) return;
      var last = subs[subs.length - 1];
      if (last && last.kind === t.ref.ckey) { last.count++; last.left++; }
      else subs.push({ kind: t.ref.ckey, count: 1, left: 1, name: baseName(t.ref.name) });
    });
    subs.forEach(function (s) { s.label = s.name + (s.count > 1 ? ' ×' + s.count : ''); });
    return subs;
  }
  function subFor(node) {
    if (cur.plan.length && cur.plan[0].kind === null) {           // assembly step: in order, named by what moves
      for (var j = 0; j < cur.plan.length; j++) if (cur.plan[j].left > 0) {
        if (!cur.plan[j].label) cur.plan[j].label = baseName(node.name) + ' assembly';
        return j;
      }
    }
    var k = kindOf(node);
    for (var i = 0; i < cur.plan.length; i++) if (cur.plan[i].left > 0 && cur.plan[i].kind === k) return i;
    cur.plan.push({ kind: k, count: 1, left: 1, name: baseName(node.name), label: baseName(node.name) });
    return cur.plan.length - 1;
  }

  /* ---------- Playback bar ---------- */
  var bar = document.createElement('div');
  bar.id = 'demoBar'; bar.className = 'float'; bar.hidden = true;
  bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Demo playback');
  bar.innerHTML = '<span class="db-tag">DEMO</span>' +
    '<span class="db-step"><b class="db-count"></b><span class="db-name"></span><span class="db-sub"></span></span>' +
    '<span class="db-prog"><i></i></span>' +
    '<button class="db-main" title="Pause / play (Space)">Pause</button>' +
    '<button class="db-mode" title="Plays by itself, or waits for Next">Auto</button>' +
    '<button class="db-speed" title="Speed">1×</button>' +
    '<button class="db-replay" title="Play it again from the start">Replay</button>' +
    '<button class="db-exit" title="Leave the demo and go back to your build (Esc)">Exit</button>';
  document.body.appendChild(bar);
  var elCount = bar.querySelector('.db-count'), elName = bar.querySelector('.db-name'), elSub = bar.querySelector('.db-sub');
  var elProg = bar.querySelector('.db-prog i'), elMain = bar.querySelector('.db-main');
  var elMode = bar.querySelector('.db-mode'), elSpeed = bar.querySelector('.db-speed');

  var seg = document.getElementById('levelSeg');
  var btn = document.createElement('button');
  btn.dataset.demo = '1';
  btn.textContent = 'Demo';
  btn.title = 'Demo — watch the whole build play itself, step by step';
  btn.setAttribute('aria-pressed', 'false');
  if (seg) seg.appendChild(btn);

  var UNIT = { part: 'part', substep: 'substep', step: 'step' };
  function paint() {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    // while the demo runs none of 1 / 2 / 3 is selected
    if (seg) Array.prototype.forEach.call(seg.querySelectorAll('button[data-level]'), function (b) {
      if (on) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }
      else { var o = +b.dataset.level === KBLevel.get(); b.classList.toggle('on', o); b.setAttribute('aria-pressed', String(o)); }
    });
    document.body.classList.toggle('demo-mode', on);
    bar.hidden = !on || !opt.bar;
    elMain.textContent = finished ? 'Done' : !opt.autoplay ? 'Next ' + UNIT[opt.by] : paused ? 'Play' : 'Pause';
    elMain.title = opt.autoplay ? 'Pause / play (Space)' : 'Play the next ' + UNIT[opt.by] + ' (Space)';
    elMain.disabled = finished || (!opt.autoplay && !holding);
    elMode.textContent = opt.autoplay ? 'Auto' : 'By ' + UNIT[opt.by];
    elSpeed.textContent = opt.speed + '×';
  }
  function progress(st, sub) {
    var list = stepList(), total = list.length, res = KBCheck.results();
    if (finished) {
      elCount.textContent = lastInPlay() === total - 1 || total === 0 ? 'All ' + total + ' steps' : 'Done';
      elName.textContent = lastInPlay() === total - 1 ? 'The drone is assembled' : 'End of the selected steps';
      elSub.textContent = '';
    } else if (st) {
      var n = cur && cur.step === st.i ? cur.plan.length : 0;
      elCount.textContent = 'Step ' + (st.i + 1) + ' / ' + total + (n > 1 && sub !== undefined ? ' · ' + (sub + 1) + ' / ' + n : '');
      elName.textContent = st.name || '';
      elSub.textContent = cur && sub !== undefined && cur.plan[sub] ? cur.plan[sub].label : '';
    }
    elProg.style.width = total ? Math.round(100 * (finished ? 1 : (res ? res.stepsSettled : 0) / total)) + '%' : '0';
  }

  /* ---------- Workspace only ---------- */
  // the tray zones and the floor grid (mostly under the tray); the workspace keeps its own outline
  function scenery(show) {
    KB.scene.children.forEach(function (o) { if (o.name === 'Parts tray' || o.type === 'GridHelper') o.visible = show; });
  }
  function hideTray() {
    hidden = [];
    if (!opt.hideTray) return;
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
  function wait(ms) { return ms / opt.speed; }
  function tick() {
    timer = 0;
    if (!on || paused || finished || holding) return;
    if (KB.interacting() || (KB.tweening && KB.tweening()) || KBLevel.busy()) { later(200); return; }
    KBCheck.evaluate();
    var st = KBCheck.next();
    if (!st) { finish('done'); return; }
    var nodes = window.KBFocus ? KBFocus.partsToMove(st) : [];

    // steps outside the selection: assembled instantly (before it), or the demo ends (after it)
    if (!inPlay(st.i)) {
      if (st.i > lastInPlay()) { finish('done'); return; }
      if (skipAhead()) { later(0); return; }
      return giveUp(st);
    }

    if (!cur || cur.step !== st.i) cur = { step: st.i, plan: planOf(st) };
    if (!nodes.length) return giveUp(st);
    var n = nodes[0], sub = subFor(n);
    var boundary = !lastPlayed ? 'first' : lastPlayed.step !== st.i ? 'step' : lastPlayed.sub !== sub ? 'substep' : 'part';
    progress(st, sub);
    if (!passBoundary) {
      // manual: stop before every new unit and wait for Next
      if (!opt.autoplay && (boundary === 'first' || boundary === 'step' ||
          (boundary === 'substep' && opt.by !== 'step') || (boundary === 'part' && opt.by === 'part'))) {
        holding = true; paint(); return;
      }
      // auto: a longer breath before a new substep / step
      var extra = boundary === 'step' ? opt.stepGap - opt.gap : boundary === 'substep' ? opt.substepGap - opt.gap : 0;
      if (opt.autoplay && extra > 0) { passBoundary = true; later(wait(extra)); return; }
    }
    passBoundary = false;
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (i > 0) { sub = subFor(node); }
      reveal(node);
      var ok = KBLevel.place(node, opt.camera === 'follow', (function (s, nd) {
        return function () {
          stuck = 0;
          cur.plan[s].left = Math.max(0, cur.plan[s].left - 1);
          later(wait(opt.gap));
        };
      })(sub, node), { speed: opt.speed, trajectory: opt.trajectory });
      if (ok) {
        lastPlayed = { step: st.i, sub: sub };
        KB.emit('demoProgress', { step: st.i + 1, steps: stepList().length, stepId: st.id, stepName: st.name,
          substep: sub + 1, substeps: cur.plan.length, substepName: cur.plan[sub].label,
          partId: node.userData.kbId || null, partName: node.name });
        return;
      }
    }
    giveUp(st);
  }
  /* Steps before the selection (from / steps): assembled in one go, in a single frame, so the
     demo opens right on the first selected step. Returns how many parts were placed. */
  function skipAhead() {
    var n = 0, lastStep = -1;
    for (var guard = 0; guard < 400; guard++) {
      KBCheck.evaluate();
      var st = KBCheck.next();
      if (!st || inPlay(st.i) || st.i > lastInPlay()) break;
      if (st.i !== lastStep) { if (lastStep >= 0) KBCheck.groupReadySteps(); lastStep = st.i; }   // finished steps move as one later
      var nodes = window.KBFocus ? KBFocus.partsToMove(st) : [], placed = false;
      for (var j = 0; j < nodes.length && !placed; j++) {
        reveal(nodes[j]);
        placed = KBLevel.place(nodes[j], false, null, { instant: true, quiet: true });
      }
      if (!placed) break;
      n++;
    }
    if (n) { KB.pushSnapshot(); stuck = 0; }
    return n;
  }
  // nothing in this step can be placed: wait a little (grouping / checks catching up), then stop instead of spinning
  function giveUp(st) {
    if (++stuck > 8) { finish('stuck', st); return; }
    later(400);
  }
  function finish(reason, st) {
    finished = true; holding = false;
    paint(); progress(null);
    if (reason === 'stuck' && st) elName.textContent = 'Stopped at step ' + (st.i + 1) + ' — ' + (st.name || '');
    frameWorkspace(true);
    KB.emit('demoEnd', { reason: reason, step: st ? st.i + 1 : null });
    clearTimeout(loopTimer);
    if (opt.loop && reason === 'done') loopTimer = setTimeout(function () { if (on && finished) replay(); }, 2500);
  }

  // skip to the first selected step at once, then frame what is built and show where it starts
  function jumpToStart() {
    if (opt.from !== null && opt.from !== undefined && opt.from !== '' || opt.steps) skipAhead();
    frameWorkspace(false);
    KBCheck.evaluate();
    var st = KBCheck.next();
    if (st) { cur = { step: st.i, plan: planOf(st) }; progress(st, 0); }
  }

  /* ---------- Enter / leave ---------- */
  function reset() {
    paused = false; finished = false; holding = false; passBoundary = false;
    stuck = 0; cur = null; lastPlayed = null;
  }
  function start(o) {
    if (on) { if (o) set(o); return; }
    if (!(window.KBCheck && window.KBLevel && window.KBParts && KBParts.ready())) { KB.toast('Parts are still loading'); return; }
    if (window.KBTutorial && KBTutorial.active()) { KB.toast('Finish or close the tutorial first'); return; }
    opt = Object.assign({}, base());
    opt = norm(o);
    saved = JSON.stringify(KB.serializeScene());
    prevLevel = KBLevel.get();
    on = true; reset();
    if (window.KBHelp) KBHelp.close();
    if (window.KBCelebrate) KBCelebrate.hide();
    if (window.KBAnswer) KBAnswer.hide();
    if (window.KBMate && KBMate.cancel) KBMate.cancel();
    KB.setSelection([]);
    KBLevel.set(1, true);           // borrow the Level 1 flight; the saved level is put back on exit
    if (opt.fresh) loadStart();
    paint();
    hideTray();
    jumpToStart();
    KB.emit('demo', { on: true, options: Object.assign({}, opt) });
    later(1000);
  }
  function stop(restore) {
    if (!on) return;
    clearTimeout(timer); timer = 0; clearTimeout(loopTimer);
    var wasDone = finished;
    on = false; reset();
    if (KB.finishTween) KB.finishTween();
    if (KB.orbit) KB.orbit.autoRotate = false;
    showAll();
    if ((restore === undefined ? opt.restore : restore) && saved) {
      KB.loadSceneData(JSON.parse(saved), true);
      KB.pushSnapshot(true);
    }
    saved = null;
    KBLevel.set(prevLevel, true);
    paint();
    if (window.KBCelebrate) KBCelebrate.reset();
    if (window.KBFocus) KBFocus.refresh();
    if (window.KBWorkspace) KBWorkspace.look('work');
    if (!wasDone) KB.emit('demoEnd', { reason: 'stopped', step: null });
    KB.emit('demo', { on: false });
  }
  function replay() {
    if (!on || !saved) return;
    clearTimeout(timer); clearTimeout(loopTimer);
    if (KB.finishTween) KB.finishTween();
    if (KB.orbit) KB.orbit.autoRotate = false;
    showAll();
    loadStart();
    reset();
    paint();
    hideTray();
    jumpToStart();
    later(800);
  }
  // change options while running; a new range (from / to / steps) starts over
  function set(o) {
    var before = opt;
    opt = norm(o);
    if (!on) return Object.assign({}, opt);
    if (opt.hideTray !== before.hideTray) { if (opt.hideTray) hideTray(); else showAll(); }
    if (String([opt.from, opt.to, opt.steps]) !== String([before.from, before.to, before.steps])) replay();
    else {
      if (opt.autoplay && holding) { holding = false; passBoundary = true; later(0); }
      paint();
    }
    return Object.assign({}, opt);
  }
  function togglePause() {
    if (!on || finished || !opt.autoplay) return;
    paused = !paused;
    paint();
    if (!paused) later(0);
  }
  function next() {
    if (!on || finished) return;
    if (opt.autoplay) { togglePause(); return; }
    if (!holding) return;
    holding = false; passBoundary = true; paint();
    later(0);
  }

  btn.addEventListener('click', function () { if (on) stop(); else start(); });
  // clicking 1 / 2 / 3 during the demo leaves it first (scene restored), then switches level
  if (seg) seg.addEventListener('click', function (e) {
    if (on && e.target.closest('button[data-level]')) stop();
  }, true);
  elMain.addEventListener('click', next);
  elMode.addEventListener('click', function () {
    // Auto -> By substep -> By step -> By part -> Auto
    var seq = [[true, opt.by], [false, 'substep'], [false, 'step'], [false, 'part']];
    var k = opt.autoplay ? 0 : ['substep', 'step', 'part'].indexOf(opt.by) + 1;
    var nx = seq[(k + 1) % seq.length];
    set({ autoplay: nx[0], by: nx[0] ? opt.by : nx[1] });   // switching to manual: the part in flight lands, then it waits
  });
  elSpeed.addEventListener('click', function () {
    var i = SPEEDS.indexOf(opt.speed);
    set({ speed: SPEEDS[(i + 1) % SPEEDS.length] });
  });
  bar.querySelector('.db-replay').addEventListener('click', replay);
  bar.querySelector('.db-exit').addEventListener('click', function () { stop(); });
  window.addEventListener('keydown', function (e) {
    if (!on || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); stop(); }
    else if (e.code === 'Space' || (e.code === 'ArrowRight' && !opt.autoplay)) { e.preventDefault(); e.stopImmediatePropagation(); next(); }
    else if (/^(Arrow|Key[WERQGSVBP]|Delete|Backspace)/.test(e.code) || e.ctrlKey || e.metaKey) e.stopImmediatePropagation();  // no moving parts during the demo
  }, true);
  // watch only: clicking a part does not select it (hidden parts are still hit by the raycaster)
  KB.onSelection(function (sel) { if (on && sel.length) setTimeout(function () { KB.setSelection([]); }, 0); });
  // any camera move stops the end-of-demo auto rotation
  ['pointerdown', 'wheel'].forEach(function (ev) {
    window.addEventListener(ev, function () { if (on && finished && KB.orbit) KB.orbit.autoRotate = false; }, true);
  });

  window.KBDemo = {
    active: function () { return on; },
    start: start, stop: stop, replay: replay, set: set, next: next,
    pause: function (p) { if (on && !finished && opt.autoplay && !!p !== paused) togglePause(); return paused; },
    finished: function () { return finished; },
    setKit: function (fn) { kitLoader = typeof fn === 'function' ? fn : null; },
    options: function () { return Object.assign({}, opt); },
    defaults: function () { return Object.assign({}, DEFAULTS); },
    state: function () {
      return { on: on, paused: paused, waiting: holding, finished: finished,
               step: cur ? cur.step + 1 : null, substep: lastPlayed ? lastPlayed.sub + 1 : null,
               substeps: cur ? cur.plan.length : null };
    }
  };

  // URL: ?level=demo&demo.speed=2&demo.by=step&demo.autoplay=0&demo.from=5&demo.to=12&demo.trajectory=answer ...
  (function fromUrl() {
    var q = new URLSearchParams(location.search), o = {}, any = false;
    q.forEach(function (v, k) {
      if (k.indexOf('demo.') !== 0) return;
      var name = k.slice(5);
      o[name] = /^(true|1|yes)$/i.test(v) && name !== 'from' && name !== 'to' && name !== 'steps' ? true
        : /^(false|0|no)$/i.test(v) && name !== 'from' && name !== 'to' && name !== 'steps' ? false
        : /^\d+(\.\d+)?$/.test(v) && name !== 'steps' ? +v : v;
      any = true;
    });
    if (any) urlOpt = o;
    if (q.get('level') === 'demo') {
      (function waitReady() { if (window.KBParts && KBParts.ready() && window.KBCheck && KBCheck.results()) setTimeout(function () { start(); }, 800); else setTimeout(waitReady, 200); })();
    }
  })();
})();
