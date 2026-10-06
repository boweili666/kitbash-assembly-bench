/* ============================================================
 * Settings 面板 —— 把十一个开关从控制台搬到界面上
 *
 * 这十一个开关以前只有控制台入口, 等于"做了等于没做": 每试一种行为都得有人
 * 去敲一行 KBFocus.pointAtL3(true)。搬上来之后任何一档都能自己调成想要的样子。
 *
 * 面板是**一张待提交的表单**, 不是一排实时开关。三种状态必须分清:
 *   live     台子现在生效的值 —— 读各模块自己的 getter, 这里不另存一份
 *   pending  面板里的待选值 —— 点开关只改这个, 台子一点不动
 *   stored   localStorage 里存的那一份 —— 下次打开台子照它来
 * Save 是唯一让 pending 盖过 live 和 stored 的动作, 也是唯一的退出口:
 * 不点 Save, 台子就保持打开面板之前的样子。
 * Default 只把 pending 拨回出厂值 —— 既不应用也不保存, 想要它生效还得点 Save。
 * 出厂值那一份不写进 localStorage: 全是出厂值时把整个键删掉, 免得存一份
 * 和"没存过"意思相同、却会把以后改出厂默认值这件事挡住的死数据。
 *
 * 齿轮**默认就在**工具栏上。原先它藏在 ?settings=1 后面, 而宿主加载台子的 URL 不带
 * 这个参数 —— 于是这个面板等于不存在, 要用它只能手敲控制台。藏它是错的决定:
 * 这十一个开关正是用来现场调行为的, 看不见就等于没做。
 * ?settings=0 或 KB.settings(false) 可以把它收掉。
 *
 * 样式全部写在这里(内联), 不碰 app.css: 那个文件没有别的 patch 动,
 * 加进来只会让 patch 之间多一个互相踩的文件。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var STORE_KEY = 'kb.settings';

  /* ---------- 十一个开关: 分组、出厂值、影响哪些档(三级点孔怎么落座不在这里, 在 levelrules.js 的表里) ----------
   * get / set 一律直接走模块自己的口, 这里不缓存 —— live 只有一个来源。
   * 有的模块 getter 和 setter 不是同一个函数(KBErrors.shown / KBErrors.set,
   * KBStepDebug.shown / KBStepDebug.show), 所以两个都写出来。 */
  var GROUPS = [
    { name: 'Guidance', rows: [
      { key: 'pointAtL3', type: 'bool', factory: true, levels: 'level 3',
        label: 'Level 3 points at the next part by itself',
        get: function () { return KBFocus.pointAtL3(); },
        set: function (v) { KBFocus.pointAtL3(v); } },
      { key: 'autoUpTo', type: 'choice', choices: [1, 2, 3], factory: 1, levels: 'levels 1 / 2',
        label: 'Fly the camera by itself up to level',
        get: function () { return KBFocus.autoUpTo(); },
        set: function (v) { KBFocus.autoUpTo(v); } },
      { key: 'cards', type: 'bool', factory: false, levels: 'every level',
        label: 'Suggested-view card, top right',
        get: function () { return KBFocus.cards(); },
        set: function (v) { KBFocus.cards(v); } },
      { key: 'stickyFollow', type: 'bool', factory: false, levels: 'every level',
        label: 'Follow the camera for good once a view is used',
        get: function () { return KBFocus.stickyFollow(); },
        set: function (v) { KBFocus.stickyFollow(v); } } ] },
    { name: 'Words', rows: [
      { key: 'guideMute', type: 'bool', factory: true, levels: 'every level',
        label: "Mute the guide card's messages (keep the step progress)",
        get: function () { return KBGuide.mute(); },
        set: function (v) { KBGuide.mute(v); } },
      { key: 'muteToasts', type: 'bool', factory: true, levels: 'every level',
        label: 'Mute the floating toasts',
        get: function () { return KB.muteToasts(); },
        set: function (v) { KB.muteToasts(v); } },
      { key: 'showErrors', type: 'bool', factory: false, levels: 'every level',
        label: 'Error notices in the corner',
        get: function () { return KBErrors.shown(); },
        set: function (v) { KBErrors.set(v); } } ] },
    { name: 'Controls', rows: [
      { key: 'showBar', type: 'bool', factory: false, levels: 'every level',
        label: 'The yellow play bar',
        get: function () { return KBAnswer.showBar(); },
        set: function (v) { KBAnswer.showBar(v); } } ] },
    { name: 'Parts tray', rows: [
      { key: 'trayByStep', type: 'bool', factory: true, levels: 'every level',
        label: 'Order the tray by the step that first needs a part',
        get: function () { return KBTray.byStep(); },
        set: function (v) { KBTray.byStep(v); } } ] },
    { name: 'Colouring', rows: [
      { key: 'marksAuto', type: 'bool', factory: true, levels: 'every level',
        label: 'Pale yellow on installed parts, pale green on a finished one',
        get: function () { return KBMarks.auto(); },
        set: function (v) { KBMarks.auto(v); } } ] },
    { name: 'Debug', rows: [
      { key: 'stepDebug', type: 'bool', factory: false, levels: 'every level',
        label: 'The 46-step panel',
        get: function () { return KBStepDebug.shown(); },
        set: function (v) { KBStepDebug.show(v); } } ] }
  ];

  var ROWS = [];
  GROUPS.forEach(function (g) { g.rows.forEach(function (r) { ROWS.push(r); }); });

  function rowFor(key) {
    for (var i = 0; i < ROWS.length; i++) if (ROWS[i].key === key) return ROWS[i];
    throw new Error('settings: no switch named ' + key);
  }

  /* ---------- live / stored ---------- */
  function readLive() {
    var out = {};
    ROWS.forEach(function (r) { out[r.key] = r.get(); });
    return out;
  }
  function factoryValues() {
    var out = {};
    ROWS.forEach(function (r) { out[r.key] = r.factory; });
    return out;
  }
  function readStored() {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return null; }   // 隐私模式
    if (raw === null) return null;
    var got = JSON.parse(raw);           // 存坏了就让它抛: 静默当没存过会让人以为开关失效
    if (!got || typeof got !== 'object') throw new Error('settings: stored value is not an object');
    Object.keys(got).forEach(function (k) { rowFor(k); });
    return got;
  }
  /* 只存和出厂值不同的那几个; 一个都不差时把键删掉 */
  function writeStored(vals) {
    var diff = {};
    ROWS.forEach(function (r) { if (vals[r.key] !== r.factory) diff[r.key] = vals[r.key]; });
    try {
      if (Object.keys(diff).length) localStorage.setItem(STORE_KEY, JSON.stringify(diff));
      else localStorage.removeItem(STORE_KEY);
    } catch (e) { /* 隐私模式: 存不下就只应用这一次 */ }
    return diff;
  }
  function applyAll(vals) {
    ROWS.forEach(function (r) { if (vals[r.key] !== undefined) r.set(vals[r.key]); });
  }

  /* ---------- 开机: 把存过的那一份应用上去 ---------- */
  (function boot() {
    if (!(window.KBFocus && window.KBGuide && window.KBErrors && window.KBAnswer &&
          window.KBLevel && window.KBTray && window.KBMarks && window.KBStepDebug)) {
      setTimeout(boot, 100);
      return;
    }
    var stored = readStored();
    if (stored) applyAll(stored);
  })();

  /* ---------- 面板 ---------- */
  var pending = null, panel = null, btn = null;

  var CSS = {
    panel: 'position:fixed;top:44px;right:12px;z-index:60;width:330px;max-height:calc(100vh - 70px);' +
           'overflow:auto;background:#1b1f27;color:#e6e9ef;border:1px solid #39404d;border-radius:8px;' +
           'box-shadow:0 10px 30px rgba(0,0,0,.45);font:12px/1.45 system-ui,sans-serif;padding:10px 12px',
    group: 'margin:8px 0 2px;font-weight:600;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8d97a8',
    row: 'display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-top:1px solid #272d38',
    text: 'flex:1;min-width:0',
    levels: 'color:#8d97a8;font-size:11px',
    ctrl: 'flex:0 0 auto;background:#2a313c;color:#e6e9ef;border:1px solid #454e5d;border-radius:4px;' +
          'padding:2px 8px;cursor:pointer;font:inherit;min-width:54px;text-align:center',
    foot: 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px;padding-top:9px;border-top:1px solid #272d38',
    note: 'color:#8d97a8;font-size:11px;margin:0 0 6px'
  };

  function render() {
    panel.textContent = '';
    var note = document.createElement('p');
    note.style.cssText = CSS.note;
    note.textContent = 'Nothing changes on the bench until you press Save. Save is also the way out.';
    panel.appendChild(note);

    GROUPS.forEach(function (g) {
      var h = document.createElement('div');
      h.style.cssText = CSS.group;
      h.textContent = g.name;
      panel.appendChild(h);
      g.rows.forEach(function (r) {
        var row = document.createElement('div');
        row.style.cssText = CSS.row;
        row.setAttribute('data-kb-setting', r.key);
        var text = document.createElement('div');
        text.style.cssText = CSS.text;
        var lbl = document.createElement('div');
        lbl.textContent = r.label;
        var lv = document.createElement('div');
        lv.style.cssText = CSS.levels;
        lv.textContent = r.levels;
        text.appendChild(lbl); text.appendChild(lv);
        var ctrl = document.createElement('button');
        ctrl.type = 'button';
        ctrl.style.cssText = CSS.ctrl;
        ctrl.setAttribute('data-kb-toggle', r.key);
        ctrl.textContent = r.type === 'bool' ? (pending[r.key] ? 'on' : 'off') : String(pending[r.key]);
        ctrl.addEventListener('click', function () {
          // 只改待选值。台子这一刻一点不动 —— 这是这个面板的全部意思
          if (r.type === 'bool') pending[r.key] = !pending[r.key];
          else {
            var i = r.choices.indexOf(pending[r.key]);
            pending[r.key] = r.choices[(i + 1) % r.choices.length];
          }
          render();
        });
        row.appendChild(text); row.appendChild(ctrl);
        panel.appendChild(row);
      });
    });

    var foot = document.createElement('div');
    foot.style.cssText = CSS.foot;
    var def = document.createElement('button');
    def.type = 'button';
    def.style.cssText = CSS.ctrl;
    def.id = 'kbSettingsDefault';
    def.textContent = 'Default';
    def.title = 'Put the factory values in this form. Nothing is applied or saved until Save.';
    def.addEventListener('click', function () { pending = factoryValues(); render(); });
    var save = document.createElement('button');
    save.type = 'button';
    save.style.cssText = CSS.ctrl;
    save.id = 'kbSettingsSave';
    save.textContent = 'Save';
    save.addEventListener('click', save_);
    foot.appendChild(def); foot.appendChild(save);
    panel.appendChild(foot);
  }

  function open() {
    if (panel) return;
    pending = readLive();
    panel = document.createElement('div');
    panel.id = 'kbSettingsPanel';
    panel.style.cssText = CSS.panel;
    document.body.appendChild(panel);
    render();
  }
  function save_() {
    if (!panel) throw new Error('settings: save with no panel open');
    applyAll(pending);
    writeStored(pending);
    close();
  }
  function close() {
    if (panel) { panel.remove(); panel = null; }
    pending = null;
  }

  /* ---------- 齿轮 ---------- */
  function makeButton() {
    var host = document.querySelector('header');
    if (!host) throw new Error('settings: no toolbar to put the gear in');
    var b = document.createElement('button');
    b.id = 'btnSettings';
    b.className = 'tool';
    b.type = 'button';
    b.title = 'Settings: the eleven switches, as a form you Save';
    b.innerHTML = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" ' +
                  'stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="10" r="2.6"/>' +
                  '<path d="M10 2.6v2M10 15.4v2M2.6 10h2M15.4 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4' +
                  'M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/></svg><span class="lbl">Settings</span>';
    // 只负责打开。面板开着时再点齿轮什么也不做 —— Save 是唯一的退出口,
    // 一个"点齿轮关掉"的第二出口等于悄悄丢掉待选值
    b.addEventListener('click', function () { if (!panel) open(); });
    host.appendChild(b);
    return b;
  }
  function gear(on) {
    if (on && !btn) btn = makeButton();
    else if (!on && btn) { close(); btn.remove(); btn = null; }
    return !!btn;
  }
  if (new URLSearchParams(location.search).get('settings') !== '0') {
    if (document.querySelector('header')) gear(true);
    else document.addEventListener('DOMContentLoaded', function () { gear(true); });
  }

  /* 齿轮的开关挂在 KB 上(宿主 / 控制台一句话):KB.settings(true) */
  KB.settings = function (on) { if (on !== undefined) gear(!!on); return !!btn; };

  window.KBSettings = {
    /* 三种状态各自读一份 —— 验收就是靠它们分得开 */
    live: readLive,
    pending: function () { return pending ? JSON.parse(JSON.stringify(pending)) : null; },
    stored: readStored,
    factory: factoryValues,
    keys: function () { return ROWS.map(function (r) { return r.key; }); },
    groups: function () { return GROUPS.map(function (g) {
      return { name: g.name, keys: g.rows.map(function (r) { return r.key; }) }; }); },
    open: open, save: save_, isOpen: function () { return !!panel; },
    gear: gear, storeKey: STORE_KEY
  };
})();
