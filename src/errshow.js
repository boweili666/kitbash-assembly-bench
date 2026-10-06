/* ============================================================
 * 错误文字显示开关 —— 默认关
 *
 * 嵌在 ARISTOS 里时,错误由 tutor 在 chat box 里说,模拟器自己再说一遍就是重复。
 * 所以默认不显示,留一个开关给"单独 debug 模拟器"用。
 *
 * 关掉的只是**文字**。KB.emit 照常发,宿主照常收得到 —— 不然 chat box 那边
 * 也就没了。红闪、点亮这些视觉反馈也照常,它们不是文字。
 *
 * 开:工具栏的 Errors 按钮,或 URL ?showErrors=1。
 * 不记 localStorage:debug 开关默认关更安全,免得某次 debug 完忘了关。
 * ============================================================ */
(function () {
  'use strict';

  var on = new URLSearchParams(location.search).get('showErrors') === '1';

  function paint() {
    var b = document.getElementById('btnShowErrors');
    if (!b) return;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    var lbl = b.querySelector('.lbl');
    if (lbl) lbl.textContent = on ? 'Errors on' : 'Errors off';
  }

  function set(v) {
    on = !!v;
    paint();
    // 通知条是按当前问题列表重画的,开关一变要立刻重算一次,否则要等下一次放下
    if (window.KBCheck && KBCheck.results && KBCheck.results()) KBCheck.evaluate();
    if (window.KB && KB.emit) KB.emit('showErrorsChange', on);
  }

  var btn = document.getElementById('btnShowErrors');
  if (btn) btn.addEventListener('click', function () { set(!on); });
  paint();

  window.KBErrors = {
    shown: function () { return on; },
    set: set,
    /* 错误类的 toast 走这里;'Undone' / 'Added X' / 级别提示那些照常用 KB.toast */
    toast: function (msg) { if (on && window.KB && KB.toast) KB.toast(msg); }
  };
})();
