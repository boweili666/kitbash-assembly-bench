/* ============================================================
 * Settings file - kitbash-config.json next to the page
 *
 * Every tunable in one place. The file is read at start-up (no cache); edit it and reload.
 * A missing file or a missing key keeps the built-in default below. Keys starting with "_"
 * are comments. Other sources, later ones win:
 *   built-in defaults  <  kitbash-config.json (or ?config=<url>)  <  host kb:init options.config / kb:config
 * Modules read values when they need them (KBConfig.get('level3.rotateStepDeg')) and listen to
 * KB 'config' for the ones they apply once (UI visibility, error switch, start level).
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var DEFAULTS = {
    level: {
      start: null                 // null = the level the user picked last time; 1 | 2 | 3 | "demo" = always start there
    },
    scene: {
      background: null            // CSS colour of the background; null = the built-in dark one
    },
    stage: {                      // the banner naming which part of a study this is (stage.js); null = none
      title: null, detail: null, colour: null
    },
    errors: {
      enabled: null               // null = keep the user's toolbar choice; true / false = force it on load
    },
    level3: {
      rotateStepDeg: 15,          // left / right arrow: turn around the hole axis
      rotateFineDeg: 1,           // with Shift
      yawStepDeg: 1,              // left / right arrow on a part that is not on a hole: turn about the vertical
      yawShiftDeg: 90,            // with Shift
      slideStepMm: 0.25,          // up / down arrow: slide along the hole axis
      slideFineMm: 0.05,          // with Shift
      autoSnap: true,             // snap into place when close enough
      snapPosMm: 10,              // ... within this distance
      snapAngDeg: 25              // ... and this angle
    },
    flight: {
      speed: 1                    // Level 1 / 2 "moves into place by itself" flight speed multiplier
    },
    checks: {
      posTolMm: 3.2,              // a part counts as in place within this distance
      angTolDeg: 12,              // ... and this angle
      workspaceOnly: true         // only what is built inside the workspace counts; false = anywhere
    },
    collision: {
      depthTolMm: 1.0             // interpenetration deeper than this is reported as a collision
    },
    camera: {
      autoView: true              // Level 1 / 2: the camera turns to the next part by itself
    },
    ui: {
      guideCard: true,            // step card at the top left
      celebration: true,          // the "assembled" screen at the end (text.assembled)
      levelButtons: true,         // Level 1 / 2 / 3 / Demo in the toolbar
      demoButton: true,
      tutorialButton: true,
      helpButton: true,
      viewButton: true,
      newButton: true,            // "New": all the parts back in the tray
      trayButton: true,           // jump between workspace and tray
      errorsButton: true,         // dev toolbar error switch (never shown on the public site)
      groupButtons: true,         // Group / Ungroup
      propsButton: true,          // the properties button and panel
      settingsButton: true,       // the gear and its settings form
      nameTags: 'off',            // part names in the scene: 'off' | 'selected' (the clicked part) | 'step' (tray + clicked) | 'all'
      debugButton: null,          // "Steps" jump-to-step list (stepdebug.js): null = its own default (?debugSteps=1); true / false = force
      checksButton: false,        // the old Checks shield
      hintsBar: false,            // the old bottom hints bar
      answerBar: false            // the old bottom ghost playback bar
    },
    hints: {                      // what the bench points out by itself (a host's explicit marks still show)
      nextPart: true,             // arrow + glow on the part(s) the current step needs (and in the tutorial)
      placed: true,               // installed parts tinted, the flash when one goes in right, the ring where it seats
      workspaceText: true,        // "Move the base here before connecting parts" on the workspace
      ghost: true,                // see-through copies of parts where they go (the step guide, the answer playback)
      collision: true             // parts that run into each other while moving turn red
    },
    tutorial: {
      autoStart: false            // embedded: run the tutorial first, then the host's scene (practice is not reported)
    },
    demo: {                       // see src/demo.js for what each one does
      autoplay: true, by: 'substep', speed: 1, gap: 450, substepGap: 700, stepGap: 1000,
      trajectory: 'approach', camera: 'follow', from: null, to: null, steps: null,
      fresh: true, loop: false, restore: true, hideTray: true, bar: true
    },
    text: {                       // words about the product being built (the bench itself knows only parts)
      assembled: 'Drone assembled!',          // celebration headline
      demoDone: 'The drone is assembled'      // demo bar after the last step
    }
  };
  var UI = {
    guideCard: '#nextGuide', levelButtons: '#levelSeg', demoButton: '#levelSeg button[data-demo]',
    tutorialButton: '#btnTutorial', helpButton: '#btnHelp, #helpPop', viewButton: '#btnView', newButton: '#btnDemo',
    trayButton: '#btnArea', errorsButton: '#btnErrors', checksButton: '#btnCheck, #checkNotice',
    hintsBar: '#hints', answerBar: '#answerBar', groupButtons: '#btnGroup, #btnUngroup',
    propsButton: '#btnProps, #panel', settingsButton: '#btnSettings, #kbSettingsPanel'
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function merge(dst, src) {
    Object.keys(src || {}).forEach(function (k) {
      if (k.charAt(0) === '_') return;
      var v = src[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) merge(dst[k], v);
      else dst[k] = v;
    });
    return dst;
  }
  var cfg = clone(DEFAULTS), version = 0, loaded = false, settled = false;

  function get(path) {
    var v = cfg;
    String(path).split('.').forEach(function (k) { v = v === undefined || v === null ? undefined : v[k]; });
    return v && typeof v === 'object' ? clone(v) : v;
  }
  function num(path, fallback) { var v = +get(path); return isFinite(v) ? v : fallback; }

  var style = document.createElement('style');
  style.id = 'kbConfigStyle';
  document.head.appendChild(style);
  function applyUi() {
    var off = Object.keys(UI).filter(function (k) { return cfg.ui[k] === false; }).map(function (k) { return UI[k]; });
    style.textContent = off.length ? off.join(', ') + ' { display: none !important; }' : '';
  }
  function applySteps() {           // the Steps jump list lives in stepdebug.js, which loads after this file
    var on = cfg.ui.debugButton;
    if ((on === true || on === false) && window.KBStepDebug && KBStepDebug.show) KBStepDebug.show(on);
  }
  function set(partial, source) {
    merge(cfg, partial);
    version++;
    applyUi();
    applySteps();
    KB.emit('config', { source: source || 'api', config: clone(cfg) });
    return clone(cfg);
  }
  applyUi();

  // kitbash-config.json next to the page, or ?config=<url>
  var url = new URLSearchParams(location.search).get('config') || 'kitbash-config.json';
  if (location.protocol !== 'file:' && window.fetch) {
    fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw { missing: true };
      return r.text();
    }).then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) {
        console.warn('[Kitbash] ' + url + ' is not valid JSON: ' + e.message);
        KB.toast('Settings file has an error — using the defaults');
        throw { handled: true };
      }
      loaded = true;
      settled = true;
      set(data, 'file');
    }).catch(function (e) {
      if (!e || (!e.missing && !e.handled)) console.warn('[Kitbash] could not read ' + url, e);
      settled = true;
      KB.emit('config', { source: 'defaults', config: clone(cfg) });
    });
  }

  window.KBConfig = {
    get: get, num: num, set: set,
    all: function () { return clone(cfg); },
    defaults: function () { return clone(DEFAULTS); },
    version: function () { return version; },
    loaded: function () { return loaded; },
    /* fn once the settings file has been read (or found missing / broken) */
    whenSettled: function (fn) {
      if (settled || location.protocol === 'file:' || !window.fetch) { fn(); return; }
      var done = false;
      KB.on('config', function (e) { if (!done && (e.source === 'file' || e.source === 'defaults')) { done = true; fn(); } });
    }
  };
})();
