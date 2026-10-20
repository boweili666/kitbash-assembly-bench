/* ============================================================
 * Stage banner -- which part of a study the trainee is in
 *
 * A host running the bench more than once (a practice run, a test, the real task) names the part it is
 * in through the settings: stage.title, stage.detail, stage.colour. While the bench's own tutorial runs
 * the banner says TUTORIAL instead. Nothing is shown when neither applies.
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var el = document.createElement('div');
  el.id = 'stageBanner';
  el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:60;display:none;' +
    'align-items:baseline;gap:12px;padding:7px 20px;border-radius:10px;color:#fff;white-space:nowrap;' +
    'font:600 15px/1.2 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25);pointer-events:none';
  el.innerHTML = '<b style="font-size:19px;letter-spacing:.08em;text-transform:uppercase"></b><span style="opacity:.92"></span>';
  document.body.appendChild(el);

  var TUTORIAL_COLOUR = '#1f5fae', STAGE_COLOUR = '#b26a00';
  var shown = null;
  function paint() {
    var cfg = window.KBConfig ? KBConfig.get('stage') || {} : {};
    var tutorial = !!(window.KBTutorial && KBTutorial.active());
    var title = tutorial ? 'Tutorial' : cfg.title;
    var detail = tutorial ? (cfg.title ? 'Practice before the ' + cfg.title : 'Practice') : cfg.detail;
    var colour = tutorial ? TUTORIAL_COLOUR : (cfg.colour || STAGE_COLOUR);
    var key = [title, detail, colour].join('|');
    if (key === shown) return;
    shown = key;
    el.style.display = title ? 'flex' : 'none';
    el.style.background = colour;
    el.firstChild.textContent = title || '';
    el.lastChild.textContent = detail || '';
  }
  KB.on('config', paint);
  KB.on('tutorialEnd', paint);
  setInterval(paint, 500);          // the tutorial starts from several places; a cheap look covers them all
  paint();
})();
