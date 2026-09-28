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
 *   | 点一行 | playFrom(i): 摆好前 i 步, 停下 | KBMini.showStep(i): 演第 i 步 |
 *   | 在演哪步 | KBAnswer.focus().step         | KBMini.status().step    |
 *
 * **两个产物点一行的含义不同, 这是有意的**: mini 是演示窗格, 它的合约就是
 * "铺到 i-1 再演 i"; 主台子是给人装的台子, 调试时要的是"把场面切到第 i 步开始
 * 之前", 所以它 seatBefore 之后**停下**, 第 i 步留给人自己做, 并不调
 * KBAnswer.showStep —— 不播, 也不摆第 i 步的虚影(playFrom 见下)。
 * 两边都**不新开播放/摆件通道**: 位姿取的是台子自己的参考装配, 虚影走的是
 * answer.js 自己的那套, 面板不拦、不补、不改。
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
    // 一个小按钮 + 点开才出来的下拉。原先是一条 232px 常驻长条, 占掉右半边,
    // 而这是调试用的东西, 不该一直杵在装配画面上
    // header 在最上面一条(实测 y 12..58, 齿轮在它右端), 所以按钮和列表都从
    // 它下面开始 —— 压住齿轮就等于把 settings 锁死, 关都关不掉
    '#' + PANEL_ID + '-btn{position:fixed;top:66px;right:10px;z-index:9001;',
    '  padding:5px 10px;background:rgba(20,24,30,.94);color:#dfe4ea;',
    '  border:1px solid #3b424c;border-radius:6px;cursor:pointer;',
    '  font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '#' + PANEL_ID + '-btn:hover{background:#2a313b}',
    '#' + PANEL_ID + '-btn.on{background:#e8a33d;color:#1a1e24;border-color:#e8a33d}',
    '#' + PANEL_ID + '{position:fixed;top:98px;right:10px;z-index:9000;',
    '  width:232px;max-height:calc(100vh - 112px);display:flex;flex-direction:column;',
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

  /* ---------- 点一行 = 先把前面那些步骤瞬间装好, 再演这一步 ----------
   * 原先点一行只调 showStep(i): 画面跳到第 i 步的虚影, 而台面上前 i-1 步一件
   * 都没装 —— 看得到、装不了。要核对"第 i 步长什么样", 场面就得是"前 i-1 步
   * 都做完"的那个场面, 这也正是 mini 的合约。
   *
   * 位姿取台子自己的参考装配(KBCheck.results().slots[].ref.M 经 refToWorld),
   * 不另找数据源; 摆好的件按 markLevelPlaced 记账, 判定才认。
   */
  function seatBefore(i) {
    if (!(window.KBCheck && KBCheck.results && KBCheck.refToWorld)) return 0;
    var res = KBCheck.evaluate();
    if (!res || !res.ready) return 0;
    var W = KBCheck.refToWorld(), moved = 0;
    var free = [];
    KB.objectsRoot.traverse(function (o) { if (KB.isPart(o)) free.push(o); });
    var taken = {};
    res.slots.forEach(function (t) { if (t.part) taken[t.part.node.uuid] = true; });

    res.slots.forEach(function (t) {
      if (t.ref.step >= i) return;                    // 这一步及以后的不动
      var node = t.part && t.part.node;
      if (!node) {                                    // 还没有件占这个槽: 挑一个同型号的
        // 先认零件型号本身, 认不到才退到 canon 的"可以顶替"(见 check.js 的 SAME):
        // 顶替只在两种零件位姿一致时才成立, 挑错了就是摆到别的零件的矩阵上。
        for (var pass = 0; pass < 2 && !node; pass++) {
          for (var k = 0; k < free.length; k++) {
            var n = free[k];
            if (taken[n.uuid]) continue;
            var nk = n.userData.kbType.slice(5);
            if (pass === 0 ? nk !== t.ref.key : KBCheck.canon(nk) !== t.ref.ckey) continue;
            node = n; taken[n.uuid] = true; break;
          }
        }
      }
      if (!node) return;                              // 场上没有这个零件, 跳过, 不编造
      var want = new THREE.Matrix4().multiplyMatrices(W, t.ref.M);
      var pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      want.decompose(pos, q, sc);
      if (node.parent !== KB.objectsRoot) KB.objectsRoot.attach(node);
      node.position.copy(pos);
      node.quaternion.copy(q);
      node.updateMatrixWorld(true);
      KBCheck.markLevelPlaced(node, t.ref);
      moved += 1;
    });
    if (moved) { KB.pushSnapshot(); KBCheck.evaluate(); }
    return moved;
  }

  /* 主台子: 点一行 = 把台面切到"前 i 步都做完"的状态, **停在第 i 步**, 让人自己做它。
   * 这是调试 / 演示用的跳步, 不是看演示 —— 所以不播第 i 步, 也不摆它的虚影。
   * mini 是演示窗格, 它的合约本来就是"铺到 i-1 再演 i", 照旧调它自己的 showStep。 */
  function playFrom(i) {
    if (api.name !== 'bench') { api.play(i); mark(api.current()); return; }
    var moved = seatBefore(i);
    // 把上一次跳步留下的虚影收走, 否则台面上还挂着别的步骤的半透明零件
    if (window.KBAnswer && KBAnswer.hide) KBAnswer.hide();
    // 跳步是**把场面改了**, 而宿主只从 kb:state 知道场面变成什么样 —— 而 kb:state
    // 至今只在 'place' 时发出去。seatBefore 是直接写 node.position / quaternion
    // 摆件的, 一个 'place' 都不发, 于是台子这边 42 步都记成 complete、next 已经
    // 走到第 43 步, 宿主的 SimulatorBridge.on_state 却一次没跑, self.current 和
    // 任务图还停在跳之前 —— 学员跳到 43 步再问"下一步做什么", tutor 照旧答第 2 /
    // 第 6 步, 连演示窗格都播那一步。
    // 不伪造 'place': 那会顺带发一条 kb:place 和一份 lastPlace{fitsStep, ok},
    // 宿主会把一次没发生过的放件当真。只报"场面被摆过了", 让 bridge 去取状态。
    if (moved) KB.emit('sceneSeated', null);
    mark(i);
  }

  function makeToggle() {
    var b = document.createElement('button');
    b.type = 'button';
    b.id = PANEL_ID + '-btn';
    b.textContent = 'Steps';
    b.title = 'Show the step list';
    b.addEventListener('click', function () {
      if (panel) { closeList(); } else { build(); }
      b.classList.toggle('on', !!panel);
    });
    return b;
  }

  function closeList() {
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    rows = [];
    lastMark = -2;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function build() {
    if (panel) return;
    ensureStyle();
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
      b.addEventListener('click', function () { playFrom(i); });
      list.appendChild(b);
      return b;
    });
    panel.appendChild(head);
    panel.appendChild(list);
    document.body.appendChild(panel);
    lastMark = -2;
    mark(api.current());
  }

  var toggle = null;
  function ensureToggle() {
    ensureStyle();
    if (toggle && toggle.parentNode) return toggle;
    toggle = makeToggle();
    document.body.appendChild(toggle);
    return toggle;
  }

  function destroy() {
    if (toggle && toggle.parentNode) toggle.parentNode.removeChild(toggle);
    toggle = null;
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
    // 开关打开 = 工具栏下多一个 Steps 按钮; 列表要点了才出来
    if (names) { ensureToggle(); if (panel) mark(api.current()); }
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
    shown: function () { return !!toggle; },
    /* 列表开着没有:面板是点 Steps 才出来的下拉 */
    listOpen: function () { return !!panel; },
    show: show,
    build: function () { return api ? api.name : null; },
    /* 自测用: 面板上现在列的是什么 */
    steps: function () { return names ? names.slice() : []; },
    current: function () { return api ? api.current() : -1; },
    /* 自测用: 不经过点击也能走同一条路 —— 和点一行同一个函数(playFrom),
       所以主台子上它也是"摆好前 i 步再停下", 不是 KBAnswer.showStep */
    play: function (i) { return api ? playFrom(i) : false; }
  };
})();
