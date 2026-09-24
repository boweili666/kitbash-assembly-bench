/* Live Next feedback. Assembly checks remain the source of truth. */
(function () {
  'use strict';
  var KB = window.KB, step = null, phase = '', signature = '', attempt = null;
  var card = document.createElement('section'); card.id = 'nextGuide'; card.hidden = true;
  card.setAttribute('aria-label', 'Assembly guidance');
  card.innerHTML = '<button class="ng-pill" aria-label="Show assembly guide" title="Show assembly guide"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg><b class="ng-pstep"></b><span class="ng-pbar"><i></i></span><em class="ng-pdot"></em></button>'
    + '<div class="ng-body"><div class="ng-top"><span class="ng-kicker">ASSEMBLY GUIDE</span><span><button class="ng-min" aria-label="Collapse guidance" title="Collapse">–</button><button class="ng-close" aria-label="Close guidance">×</button></span></div><div class="ng-status" role="status" aria-live="polite"></div><h2></h2><div class="ng-progress"><i></i></div><p class="ng-count"></p><ul class="ng-parts"></ul><div class="ng-feedback" role="status" aria-live="polite"></div><ul class="ng-issues" aria-live="polite"></ul></div>';
  document.body.appendChild(card);
  function el(s) { return card.querySelector(s); }
  el('.ng-close').onclick = function () { if (window.KBAnswer) KBAnswer.hide(); hide(); };
  // 默认收成一个小胶囊,点开才看完整内容;展开与否记在本机
  var open = false;
  try { open = localStorage.getItem('kb.guideOpen') === '1'; } catch (e) {}
  function setOpen(v) { open = v; card.classList.toggle('collapsed', !v); try { localStorage.setItem('kb.guideOpen', v ? '1' : '0'); } catch (e) {} KB.emit('guideOpen', v); }
  setOpen(open);
  el('.ng-pill').onclick = function () { setOpen(true); };
  el('.ng-min').onclick = function () { setOpen(false); };
  function hide() { card.hidden = true; step = null; attempt = null; signature = ''; KB.emit('guide', null); }
  /* 检查结果也挂在这张卡片上(原来右上角的通知条不要了),三种颜色:
     红 = 错误(拿错零件 / 孔不对 / 装反);蓝 = 提示(三级"还没对齐"、放进装配区……);
     绿 = 刚装对的那一件(几秒后消失)。有新错误时卡片收着也会自己展开 */
  var lastGood = null, goodTimer = 0, lastArgs = null, seenErr = '', demoing = false;
  function issueRows(res, message) {
    var rows = [];
    if (lastGood && performance.now() < lastGood.until) rows.push({ c: 'green', msg: lastGood.msg });
    if (!res || demoing) return rows;
    res.issues.forEach(function (i) {
      if (!i.msg || (message && message.indexOf(i.msg) >= 0)) return;      // 上面的反馈框已经说了这条
      rows.push({ c: i.severity === 'error' ? 'red' : 'blue', msg: i.msg });
    });
    return rows.slice(0, 5);
  }
  function draw(st, state, message) {
    lastArgs = [st, state, message];
    var res = window.KBCheck && KBCheck.results();
    if (res && !res.ready) res = null;                      // 教程期间不判,没有步骤数
    var rows = issueRows(res, message);
    // 单独放好的基座也算"放好了"(判定上它没有配合件可对照,永远不会 ok)
    var seated = function (t) { return !!(t.ok || (window.KBCheck && KBCheck.baseSeated && KBCheck.baseSeated(t))); };
    var okN = st.slots.filter(seated).length;
    var key = JSON.stringify([st.i, st.name, state, message, st.slots.map(function (t) { return [t.ref.name, seated(t), !!t.part, t.near.length, t.statusText, t.now]; }), res && res.stepsSettled, rows]);
    if (key === signature) return;
    signature = key; card.hidden = false; card.dataset.state = state;
    el('.ng-status').textContent = { workspace: '01 · Move into workspace', progress: '02 · Assembly in progress', error: '! · Needs attention', warn: '~ · Not aligned yet', success: '✓ · Step complete', waiting: 'Next step ready' }[state];
    el('h2').textContent = st.name;
    el('.ng-progress i').style.width = (st.total ? okN / st.total * 100 : 0) + '%';
    el('.ng-count').textContent = okN + ' / ' + st.total + ' parts in place' + (res ? ' · ' + res.stepsSettled + ' / ' + res.steps.length + ' steps complete' : '');
    var list = el('.ng-parts'); list.replaceChildren();
    st.slots.forEach(function (t) {
      var li = document.createElement('li'), name = document.createElement('span'), status = document.createElement('span');
      name.textContent = t.ref.name;
      var ready = seated(t);
      status.textContent = t.statusText || (ready ? '✓ In place' : t.part && t.near.length ? 'Align' : 'To place');
      li.dataset.ready = !!ready; if (t.now) li.dataset.now = 'true';
      li.append(name, status); list.appendChild(li);
    });
    el('.ng-feedback').textContent = message;
    var il = el('.ng-issues'); il.replaceChildren();
    rows.forEach(function (r) { var li = document.createElement('li'); li.className = r.c; li.textContent = (r.c === 'green' ? '\u2713 ' : r.c === 'red' ? '! ' : '') + r.msg; il.appendChild(li); });
    // 新错误:卡片收着就自己打开,别让人看不到
    var errKey = rows.filter(function (r) { return r.c === 'red'; }).map(function (r) { return r.msg; }).join('|') || (state === 'error' ? message : '');
    if (errKey && errKey !== seenErr && !open && !demoing) setOpen(true);
    seenErr = errKey;
    card.dataset.tone = state === 'error' || rows.some(function (r) { return r.c === 'red'; }) ? 'red'
      : state === 'success' || rows.some(function (r) { return r.c === 'green'; }) ? 'green' : 'blue';
    var done = res ? res.stepsSettled : 0, all = res ? res.steps.length : 0;
    el('.ng-pstep').textContent = all ? 'Step ' + Math.min(done + 1, all) + ' / ' + all : st.name;
    el('.ng-pbar i').style.width = (all ? done / all * 100 : 0) + '%';
    el('.ng-pill').title = st.name + ' \u2014 ' + okN + ' / ' + st.total + ' parts in place. Click to expand.';
    // 把这张卡片说的话原样播出去:桥接转成 kb:guide,调试页面拿它对照动画
    KB.emit('guide', {
      step: st.i, name: st.name, state: state, message: message || '',
      ok: okN, total: st.total,
      settled: res ? res.stepsSettled : null, steps: res ? res.steps.length : null,
      status: el('.ng-status').textContent,
      parts: st.slots.map(function (t) {
        return { name: t.ref.name, key: t.ref.key, ok: !!t.ok,
                 state: seated(t) ? 'in-place' : t.part && t.near.length ? 'align' : 'to-place' };
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
    var lv = window.KBLevel ? KBLevel.get() : 3;
    var how = lv === 1 ? 'Click the part the ghost shows \u2014 it moves into place by itself.'
      : lv === 2 ? 'Follow the ghost. Click the hole or peg on the part, then the hole it goes into \u2014 the part seats itself.'
      : 'Follow the ghost. Select a source hole or peg, then the receiving hole.';
    var message = mode === 'workspace' ? hint : how + ' Parts turn green in this list when correctly placed.';
    if (issue && mode !== 'workspace') {
      state = issue.hint ? 'progress' : issue.severity === 'warn' ? 'warn' : 'error'; message = issue.msg + ' ' + (st.assembly ? 'Keep the wedge and screw together. Move the whole assembly onto the indicated side of the fixed X-Lock.' : /backwards/.test(issue.msg) ? 'Turn the part around and use the other hole entrance.' : /order/.test(issue.msg) ? 'Finish the required earlier step first.' : /workspace/.test(issue.msg) ? 'Move the whole part inside the marked area.' : 'Select the part and adjust its position or angle. Ungroup first if you need to adjust one part.');
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
  KB.on('place', function (node) {
    setTimeout(function () {
      if (!window.KBCheck || demoing || (window.KBTutorial && KBTutorial.active())) return;
      var res = KBCheck.evaluate(), t = KBCheck.slotOf(node);
      if (!res || !res.ready || !t || !t.ok) return;
      lastGood = { msg: t.ref.name + ' is in place', until: performance.now() + 4000 };
      if (lastArgs) { signature = ''; draw.apply(null, lastArgs); }
      clearTimeout(goodTimer);
      goodTimer = setTimeout(function () { if (lastArgs && !card.hidden) { signature = ''; draw.apply(null, lastArgs); } }, 4100);
    }, 450);
  });
  window.KBGuide = { update: update, hide: hide,
    setOpen: setOpen,
    /* 教程演示:摆一张示范步骤卡(两件零件,一件已放好),教人认得左上角这个悬浮窗 */
    /* 教程演示:摆一张"这一步"的卡片,由教程按用户的操作改状态 ——
       d = { name, parts: [{ name, ok }], state: 'progress'|'error'|'success', message };null 收起 */
    demo: function (d) {
      demoing = !!d;
      if (!d) { hide(); return; }
      var slots = d.parts.map(function (p) { return { ref: { name: p.name }, ok: !!p.ok, part: p.ok ? {} : null, near: p.ok ? [1] : [],
        statusText: p.status || null, now: !!p.now }; });
      var fake = { i: 0, name: d.name, total: slots.length, ok: slots.filter(function (t) { return t.ok; }).length, slots: slots };
      draw(fake, d.state || 'progress', d.message || '');
      KB.emit('guide', null);                                   // 演示卡不是真的指引,别报给宿主
    },
    complete: function (st, message) { step = st; attempt = null; draw(st, 'success', message || 'All parts are in place. Moving to the next step…'); },
    waiting: function (st) { step = st; draw(st, 'waiting', 'Add the parts for this step to the scene. Stuck? Press Help at the top.'); }
  };
})();
