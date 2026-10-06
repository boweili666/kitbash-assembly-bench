/* ============================================================
 * 46 步 debug 面板 —— 默认关, 两个产物共用这一份代码
 *
 * 计划书 doc/0924/plan-mini-simulator-standalone.md §4.2。
 *
 * 干什么: 右上角列出参考装配的全部步骤, 点一行就演那一步。用来不经过
 * workflow / instructions 把 46 步逐个点过去, 核对每一步演得对不对; 主台子和
 * mini 并排开着还能比"同一步两边各演了什么"。
 *
 * 开: URL `?debugSteps=1`, 或 `KBStepDebug.show(true)`。
 * 不记 localStorage —— 和 errshow.js 同一个口径, debug 开关默认关更安全。
 *
 * 两个产物, 一份代码: 启动时探测本页有哪套 API, 选一个 adapter。
 *
 *   | | 主台子 (handle-callbacks) | mini (feature-mini-simulator) |
 *   |---|---|---|
 *   | 步骤名 | KBCheck.results().steps[i].name | KBMini.steps()[i].name |
 *   | 播放   | KBAnswer.showStep(i)            | KBMini.showStep(i)      |
 *   | 在演哪步 | KBAnswer.focus().step         | KBMini.status().step    |
 *
 * **不新开播放通道**: 点一行走的就是这个产物平时播一步用的那个函数, 所以面板
 * 里看到的和宿主发 kb:showStep 看到的是同一个东西。主台子的 KBAnswer.showStep
 * 会自己判场面(这一步已经装完 / 桌上没有可锚定的零件 → 返回 false 并 toast),
 * 面板不拦、不补、不改 —— 那是台子的行为, 不是面板的。
 *
 * 高亮跟的是**产物自己的状态**(每 250ms 读一次 focus()/status()), 不是记住了
 * 谁被点过: 宿主发来的 kb:showStep、主台子自己的引导也会换步, 面板得跟着走。
 * ============================================================ */
(function () {
  'use strict';

  var PANEL_ID = 'kbStepDebug';
  var STYLE_ID = 'kbStepDebugStyle';
  var POLL_MS = 250;

  /* ---------- adapter: 这个产物是哪一个 ---------- */
  var MINI = {
    name: 'mini',
    present: function () { return !!window.KBMini; },
    steps: function () {
      var s = window.KBMini.steps();
      return (s && s.length) ? s.map(function (st) { return st.name; }) : null;
    },
    play: function (i) { return window.KBMini.showStep(i); },
    current: function () {
      var st = window.KBMini.status();
      return st ? st.step : -1;
    }
  };

  var BENCH = {
    name: 'bench',
    present: function () { return !!(window.KBAnswer && window.KBCheck); },
    steps: function () {
      // results() 在 evaluate() 跑过之前是 null; evaluate() 自己在零件还在飞时
      // 会推迟, 所以这里只是"问一次", 问不到就等下一轮 poll。
      KBCheck.evaluate();
      var r = KBCheck.results();
      if (!r || !r.ready || !r.steps || !r.steps.length) return null;
      return r.steps.map(function (st) { return st.name; });
    },
    play: function (i) { return KBAnswer.showStep(i); },
    current: function () {
      var f = KBAnswer.focus();
      return f ? f.step : -1;
    }
  };

  var api = MINI.present() ? MINI : (BENCH.present() ? BENCH : null);

  /* ---------- 状态 ---------- */
  var on = new URLSearchParams(location.search).get('debugSteps') === '1';
  var names = null;       // 步骤名, 拿到一次就不再变(manifest 里的静态数据)
  var rows = [];
  var panel = null;
  var timer = 0;
  var lastMark = -2;

  var CSS = [
    '#' + PANEL_ID + '{position:fixed;top:8px;right:8px;z-index:9000;',
    '  width:232px;max-height:calc(100vh - 16px);display:flex;flex-direction:column;',
    '  background:rgba(20,24,30,.94);color:#dfe4ea;border:1px solid #3b424c;border-radius:6px;',
    '  font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
    '  box-shadow:0 6px 24px rgba(0,0,0,.45);overflow:hidden}',
    '#' + PANEL_ID + ' .kbsd-head{flex:0 0 auto;padding:6px 8px;border-bottom:1px solid #3b424c;',
    '  color:#9aa4b2;letter-spacing:.04em;text-transform:uppercase;font-size:10px}',
    // 46 行放不进一屏, 面板自己滚, 不把装配挤走
    '#' + PANEL_ID + ' .kbsd-list{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain}',
    '#' + PANEL_ID + ' .kbsd-row{display:flex;gap:6px;align-items:baseline;padding:3px 8px;',
    '  cursor:pointer;border:0;width:100%;background:none;color:inherit;font:inherit;text-align:left}',
    '#' + PANEL_ID + ' .kbsd-row:hover{background:#2a313b}',
    '#' + PANEL_ID + ' .kbsd-row.on{background:#e8a33d;color:#1a1e24}',
    '#' + PANEL_ID + ' .kbsd-n{flex:0 0 22px;text-align:right;opacity:.6}',
    '#' + PANEL_ID + ' .kbsd-row.on .kbsd-n{opacity:.85}',
    '#' + PANEL_ID + ' .kbsd-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
  ].join('\n');

  function build() {
    if (panel) return;
    if (!document.getElementById(STYLE_ID)) {
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    var head = document.createElement('div');
    head.className = 'kbsd-head';
    head.textContent = names.length + ' steps · ' + api.name;
    var list = document.createElement('div');
    list.className = 'kbsd-list';
    rows = names.map(function (nm, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'kbsd-row';
      b.setAttribute('data-step', String(i));     // 0 基:和 showStep(i) 的下标一致
      var n = document.createElement('span');
      n.className = 'kbsd-n';
      n.textContent = String(i + 1);              // 显示 1 基:和 stepLabel 的 'Step N' 对齐
      var t = document.createElement('span');
      t.className = 'kbsd-name';
      t.textContent = nm;
      t.title = nm;
      b.appendChild(n);
      b.appendChild(t);
      // 高亮跟产物自己的状态走: 主台子的 showStep 可能拒演(这一步已装完 / 没有
      // 可锚定的零件), 那时 focus() 不动, 面板也就不该亮这一行
      b.addEventListener('click', function () { api.play(i); mark(api.current()); });
      list.appendChild(b);
      return b;
    });
    panel.appendChild(head);
    panel.appendChild(list);
    document.body.appendChild(panel);
    lastMark = -2;
    mark(api.current());
  }

  function destroy() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    var st = document.getElementById(STYLE_ID);
    if (st && st.parentNode) st.parentNode.removeChild(st);
    panel = null;
    rows = [];
    lastMark = -2;
  }

  function mark(i) {
    if (!panel || i === lastMark) return;
    lastMark = i;
    rows.forEach(function (b, k) { b.classList.toggle('on', k === i); });
    var cur = rows[i];
    // 点到看不见的行(宿主发来的步骤)时把它滚进视野
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  /* 步骤名要等数据: mini 等 KBParts 解析完 GLB, 主台子等 evaluate() 出结果。
     bridge.js 的 waitReady 是同一个写法。 */
  function poll() {
    timer = 0;
    if (!on || !api) return;
    if (!names) {
      var got = null;
      try { got = api.steps(); } catch (e) { got = null; }
      if (got && got.length) names = got;
    }
    if (names) { build(); mark(api.current()); }
    timer = setTimeout(poll, POLL_MS);
  }

  function show(v) {
    on = !!v;
    if (!api) return false;
    if (!on) {
      destroy();
      if (timer) { clearTimeout(timer); timer = 0; }
      return false;
    }
    if (!timer) poll();
    return !!panel;
  }

  if (on) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poll);
    else poll();
  }

  window.KBStepDebug = {
    shown: function () { return !!panel; },
    show: show,
    build: function () { return api ? api.name : null; },
    /* 自测用: 面板上现在列的是什么 */
    steps: function () { return names ? names.slice() : []; },
    current: function () { return api ? api.current() : -1; },
    /* 自测用: 不经过点击也能走同一条路 */
    play: function (i) { return api ? api.play(i) : false; }
  };
})();
