/* Live Next feedback. Assembly checks remain the source of truth. */
(function () {
  'use strict';
  var KB = window.KB, step = null, phase = '', signature = '', attempt = null;
  var card = document.createElement('section'); card.id = 'nextGuide'; card.hidden = true;
  card.setAttribute('aria-label', 'Assembly guidance');
  card.innerHTML = '<div class="ng-top"><span class="ng-kicker">ASSEMBLY GUIDE</span><button class="ng-close" aria-label="Close guidance">×</button></div><div class="ng-status" role="status" aria-live="polite"></div><h2></h2><div class="ng-progress"><i></i></div><p class="ng-count"></p><ul class="ng-parts"></ul><div class="ng-feedback" role="status" aria-live="polite"></div>';
  document.body.appendChild(card);
  function el(s) { return card.querySelector(s); }
  el('.ng-close').onclick = function () { if (window.KBAnswer) KBAnswer.hide(); hide(); };
  function hide() { card.hidden = true; step = null; attempt = null; signature = ''; KB.emit('guide', null); }
  function draw(st, state, message) {
    var res = window.KBCheck && KBCheck.results();
    var key = JSON.stringify([st.i, state, message, st.slots.map(function (t) { return [t.ref.name, t.ok, !!t.part, t.near.length]; }), res && res.stepsSettled]);
    if (key === signature) return;
    signature = key; card.hidden = false; card.dataset.state = state;
    el('.ng-status').textContent = { workspace: '01 · Move into workspace', progress: '02 · Assembly in progress', error: '! · Needs attention', success: '✓ · Step complete', waiting: 'Next step ready' }[state];
    el('h2').textContent = st.name;
    el('.ng-progress i').style.width = (st.total ? st.ok / st.total * 100 : 0) + '%';
    el('.ng-count').textContent = st.ok + ' / ' + st.total + ' parts in place' + (res ? ' · ' + res.stepsSettled + ' / ' + res.steps.length + ' steps complete' : '');
    var list = el('.ng-parts'); list.replaceChildren();
    st.slots.forEach(function (t) {
      var li = document.createElement('li'), name = document.createElement('span'), status = document.createElement('span');
      name.textContent = t.ref.name;
      status.textContent = t.ok ? '✓ In place' : t.part && t.near.length ? 'Align' : 'To place';
      li.dataset.ready = t.ok; li.append(name, status); list.appendChild(li);
    });
    el('.ng-feedback').textContent = message;
    // 把这张卡片说的话原样播出去:桥接转成 kb:guide,调试页面拿它对照动画
    KB.emit('guide', {
      step: st.i, name: st.name, state: state, message: message || '',
      ok: st.ok, total: st.total,
      settled: res ? res.stepsSettled : null, steps: res ? res.steps.length : null,
      status: el('.ng-status').textContent,
      parts: st.slots.map(function (t) {
        return { name: t.ref.name, key: t.ref.key, ok: !!t.ok,
                 state: t.ok ? 'in-place' : t.part && t.near.length ? 'align' : 'to-place' };
      })
    });
  }
  function update(st, mode, hint) {
    if (!st) return;
    if (KB.interacting()) {
      step = st; phase = mode;
      draw(st, 'progress', 'Rotating… Release the key or handle to check alignment and group the assembly.');
      return;
    }
    if (!step || step.i !== st.i) attempt = null;
    step = st; phase = mode;
    var res = KBCheck.results();
    var issue = res && res.issues.find(function (i) { return (i.step && i.step.i === st.i) || (!i.step && i.slot && i.slot.step === st.i); });
    var state = mode === 'workspace' ? 'workspace' : 'progress';
    var message = mode === 'workspace' ? hint : 'Follow the ghost. Select a source hole or peg, then the receiving hole. Parts turn green in this list when correctly placed.';
    if (issue && mode !== 'workspace') {
      state = issue.hint ? 'progress' : 'error'; message = issue.msg + ' ' + (st.assembly ? 'Keep the wedge and screw together. Move the whole assembly onto the indicated side of the fixed X-Lock.' : /backwards/.test(issue.msg) ? 'Turn the part around and use the other hole entrance.' : /order/.test(issue.msg) ? 'Finish the required earlier step first.' : /workspace/.test(issue.msg) ? 'Move the whole part inside the marked area.' : 'Select the part and adjust its position or angle. Ungroup first if you need to adjust one part.');
    }
    if (attempt) { state = attempt.error ? 'error' : state; message = attempt.message; }
    draw(st, state, message);
  }
  var failures = {
    'peg-on-peg': 'Two pegs cannot connect. Select a hole as the receiving feature.',
    'peg wider than hole': 'This peg is wider than the hole. Check the screw size and choose a matching hole.',
    'receiving part outside workspace': 'Move the receiving part fully into the workspace, then try again.',
    'assembly would cross workspace boundary': 'Move the receiving part further inside the workspace so the whole assembly fits.'
  };
  KB.on('grab', function () { if (step) { attempt = null; update(step, phase, 'Move the highlighted base fully inside the workspace.'); } });
  KB.on('move', function () { if (step && KB.interacting()) update(step, phase, ''); });
  KB.on('snapAttempt', function (a) {
    if (!step) return;
    attempt = { error: !a.success, message: a.success ? 'Connection made. Checking position and step completion…' : failures[a.reason] || 'Connection failed. Check the selected features and their alignment.' };
    update(step, phase, 'Move the base into the workspace.');
  });
  KB.onChange(function () { attempt = null; });
  window.KBGuide = { update: update, hide: hide,
    complete: function (st, message) { step = st; attempt = null; draw(st, 'success', message || 'All parts are in place. Moving to the next step…'); },
    waiting: function (st) { step = st; draw(st, 'waiting', 'Add the parts for this step to the scene, then press Next to continue.'); }
  };
})();
