/* ============================================================
 * Agent 实时推流 — 把 3D 视口画面持续发送给装配 agent
 *
 * 对接 animation_new/agent_server.py(FastAPI,默认 http://localhost:8001):
 *   POST /predict  multipart {image, session}  → 第一帧作为基线,
 *                  之后返回 {stage_index, stage_name, parts_moved, message, status}
 *   POST /reset    form {session}
 *   GET  /health   {ok, model, key_loaded}
 *
 * 客户端策略:每 0.5s 抓一张小缩略图做变化检测,画面有变化(或到达心跳
 * 间隔)时才把 JPEG 帧 POST 给 agent;同一时间只有一帧在途。
 * agent 的判定结果显示在左下角 Agent 面板里。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var btn = document.getElementById('btnAgent');
  var panel = document.getElementById('agentPanel');
  if (!btn || !panel) return;

  var elEndpoint = document.getElementById('agEndpoint');
  var elSession = document.getElementById('agSession');
  var elHeartbeat = document.getElementById('agHeartbeat');
  var elStart = document.getElementById('agStart');
  var elReset = document.getElementById('agReset');
  var elClose = document.getElementById('agClose');
  var elStatus = document.getElementById('agStatus');
  var elDot = document.getElementById('agDot');
  var elStage = document.getElementById('agStage');
  var elMsg = document.getElementById('agMsg');
  var elLog = document.getElementById('agLog');

  var PREF_KEY = 'kitbash-agent-v1';
  var THUMB_W = 64, THUMB_H = 36;
  var CHANGE_THRESHOLD = 6;      // 缩略图平均灰度差(0-255)
  var MIN_SEND_GAP = 1500;       // 两次发送最小间隔 ms

  var streaming = false, inflight = false, timer = 0;
  var lastThumb = null, lastSentAt = 0, frames = 0, stagesTotal = 22;
  var thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = THUMB_W; thumbCanvas.height = THUMB_H;
  var thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });

  /* ---------- 偏好 ---------- */
  try {
    var pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (pref.endpoint) elEndpoint.value = pref.endpoint;
    if (pref.session) elSession.value = pref.session;
    if (pref.heartbeat) elHeartbeat.value = pref.heartbeat;
  } catch (e) { /* 忽略 */ }
  if (!elSession.value) elSession.value = 'kitbash-' + Math.random().toString(36).slice(2, 6);
  function savePref() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        endpoint: elEndpoint.value, session: elSession.value, heartbeat: elHeartbeat.value
      }));
    } catch (e) { /* 忽略 */ }
  }
  [elEndpoint, elSession, elHeartbeat].forEach(function (el) { el.addEventListener('change', savePref); });

  function base() { return elEndpoint.value.replace(/\/+$/, ''); }

  /* ---------- 日志 / 状态 ---------- */
  function log(text, kind) {
    var row = document.createElement('div');
    row.className = 'ag-row' + (kind ? ' ' + kind : '');
    var t = new Date();
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    row.innerHTML = '<span class="ag-time"></span><span class="ag-text"></span>';
    row.querySelector('.ag-time').textContent = pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
    row.querySelector('.ag-text').textContent = text;
    elLog.insertBefore(row, elLog.firstChild);
    while (elLog.children.length > 12) elLog.removeChild(elLog.lastChild);
  }
  function setStatus(text, state) {
    elStatus.textContent = text;
    elDot.className = 'ag-dot ' + (state || '');
  }

  /* ---------- 变化检测 ---------- */
  function thumbOf(canvas) {
    thumbCtx.drawImage(canvas, 0, 0, THUMB_W, THUMB_H);
    var d = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data;
    var out = new Uint8Array(THUMB_W * THUMB_H);
    for (var i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
    return out;
  }
  function diff(a, b) {
    if (!a || !b) return 255;
    var s = 0;
    for (var i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }
  /* 变化像素占比:对小物体移动 / 半透明动画比平均差更敏感 */
  function changedRatio(a, b, tol) {
    if (!a || !b) return 1;
    var n = 0;
    for (var i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) n++;
    return n / a.length;
  }

  /* ---------- 推流循环 ---------- */
  function tick() {
    if (!streaming || inflight) return;
    var frame = KB.captureFrame(1024, 0.82); // {canvas, blobPromise}
    var th = thumbOf(frame.canvas);
    var now = performance.now();
    var hb = parseFloat(elHeartbeat.value) * 1000;
    var changed = diff(th, lastThumb) > CHANGE_THRESHOLD || changedRatio(th, lastThumb, 10) > 0.01;
    var due = hb > 0 && (now - lastSentAt) > hb;
    if (!changed && !due) return;
    if (now - lastSentAt < MIN_SEND_GAP) return;
    lastThumb = th;
    lastSentAt = now;
    inflight = true;
    frame.blobPromise.then(send).catch(function (e) {
      inflight = false;
      log('Capture failed: ' + (e.message || e), 'err');
    });
  }

  function send(blob) {
    var fd = new FormData();
    fd.append('image', blob, 'frame-' + Date.now() + '.jpg');
    fd.append('session', elSession.value);
    var t0 = performance.now();
    fetch(base() + '/predict', { method: 'POST', body: fd }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + ' ' + t.slice(0, 120)); });
      return r.json();
    }).then(function (res) {
      frames += 1;
      var ms = Math.round(performance.now() - t0);
      setStatus('Streaming · ' + frames + ' frame' + (frames > 1 ? 's' : '') + ' · ' + ms + ' ms', 'on');
      showResult(res);
    }).catch(function (e) {
      setStatus('Error: ' + (e.message || e), 'err');
      log('predict failed: ' + (e.message || e), 'err');
    }).then(function () { inflight = false; });
  }

  function showResult(res) {
    if (res.is_first_image || res.status === 'baseline') {
      elStage.textContent = 'Baseline captured';
      elMsg.textContent = res.message || 'Now assemble — the agent will track your progress.';
      log('Baseline set', 'ok');
      return;
    }
    var moved = (res.parts_moved || res.moved || []).map(function (m) {
      return typeof m === 'string' ? m : (m.count ? m.count + '× ' : '') + (m.type || '');
    }).filter(Boolean);
    if (res.stage_index !== null && res.stage_index !== undefined) {
      elStage.textContent = 'Stage ' + (res.stage_index + 1) + '/' + stagesTotal +
        (res.stage_name ? ' · ' + res.stage_name : '');
      log('→ stage ' + (res.stage_index + 1) + (moved.length ? ': ' + moved.join(', ') : ''), 'ok');
    } else {
      elStage.textContent = res.status ? String(res.status) : 'No stage change';
      if (moved.length) log('moved: ' + moved.join(', '));
    }
    elMsg.textContent = res.message || res.note || (moved.length ? 'Moved: ' + moved.join(', ') : 'Nothing moved');
  }

  /* ---------- 控制 ---------- */
  function start() {
    savePref();
    setStatus('Connecting…', '');
    fetch(base() + '/health').then(function (r) { return r.json(); }).then(function (h) {
      stagesTotal = h.stages || 22;
      log('Connected · model ' + (h.model || '?') + (h.key_loaded === false ? ' · NO API KEY' : ''), 'ok');
      streaming = true;
      inflight = false;
      lastThumb = null;
      lastSentAt = 0;
      frames = 0;
      elStart.textContent = 'Stop';
      btn.classList.add('on');
      setStatus('Streaming · waiting for first frame', 'on');
      timer = setInterval(tick, 500);
      tick();
    }).catch(function (e) {
      setStatus('Cannot reach agent at ' + base(), 'err');
      log('Start the agent: python3 agent_server.py (port 8001)', 'err');
    });
  }

  function stop() {
    streaming = false;
    clearInterval(timer);
    elStart.textContent = 'Start';
    if (!mon.on) btn.classList.remove('on');
    setStatus('Stopped', '');
    log('Streaming stopped');
  }

  elStart.addEventListener('click', function () { streaming ? stop() : start(); });
  elReset.addEventListener('click', function () {
    var fd = new FormData();
    fd.append('session', elSession.value);
    fetch(base() + '/reset', { method: 'POST', body: fd }).then(function () {
      lastThumb = null;
      elStage.textContent = 'Session reset';
      elMsg.textContent = 'Next frame becomes the new baseline.';
      log('Session reset', 'ok');
    }).catch(function (e) { log('reset failed: ' + (e.message || e), 'err'); });
  });
  elClose.addEventListener('click', function () { panel.style.display = 'none'; });
  btn.addEventListener('click', function () {
    panel.style.display = panel.style.display === 'none' || !panel.style.display ? 'flex' : 'none';
  });

  /* ---------- Live view:把视口画面持续推给 monitor.py 中继 ---------- */
  var monEndpoint = document.getElementById('monEndpoint');
  var monStart = document.getElementById('monStart');
  var monOpen = document.getElementById('monOpen');
  var monStatus = document.getElementById('monStatus');
  var MON_KEY = 'kitbash-monitor-v1';
  var mon = { on: false, timer: 0, inflight: false, lastSent: 0, sent: 0, fails: 0 };
  var MON_INTERVAL = 100, MON_HEARTBEAT = 1000, ACTIVE_WINDOW = 3000; // 操作中 10 fps;静止 1 fps
  var lastInput = 0;
  ['pointerdown', 'pointermove', 'wheel', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, function () { lastInput = performance.now(); }, { passive: true });
  });
  function sceneActive(now) {
    if (now - lastInput < ACTIVE_WINDOW) return true;
    var a = window.KBAnswer && KBAnswer.info();
    return !!(a && a.active && a.playing);
  }

  try {
    var mp = JSON.parse(localStorage.getItem(MON_KEY) || '{}');
    if (mp.endpoint) monEndpoint.value = mp.endpoint;
  } catch (e) { /* 忽略 */ }
  function monBase() { return monEndpoint.value.replace(/\/+$/, ''); }
  function syncOpenLink() { monOpen.href = monBase() + '/'; }
  monEndpoint.addEventListener('change', function () {
    try { localStorage.setItem(MON_KEY, JSON.stringify({ endpoint: monEndpoint.value })); } catch (e) { /* 忽略 */ }
    syncOpenLink();
  });
  syncOpenLink();

  function monTick() {
    if (!mon.on || mon.inflight) return;
    var now = performance.now();
    if (!sceneActive(now) && now - mon.lastSent < MON_HEARTBEAT) return; // 静止:心跳帧
    var frame = KB.captureFrame(960, 0.72);
    mon.lastSent = now;
    mon.inflight = true;
    frame.blobPromise.then(function (blob) {
      return fetch(monBase() + '/frame', { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      mon.sent += 1;
      mon.fails = 0;
      if (mon.sent % 8 === 1) monStatus.textContent = 'Sharing \u00b7 ' + mon.sent + ' frames sent \u00b7 open the viewer on any device: ' + monBase();
    }).catch(function (e) {
      mon.fails += 1;
      monStatus.textContent = 'Relay unreachable at ' + monBase() + ' \u2014 run python3 monitor.py (' + (e.message || e) + ')';
      if (mon.fails >= 20) monStop();
    }).then(function () { mon.inflight = false; });
  }

  function monBegin() {
    mon.on = true;
    mon.sent = 0; mon.fails = 0; mon.lastSent = 0;
    monStart.textContent = 'Stop sharing';
    btn.classList.add('on');
    monStatus.textContent = 'Sharing\u2026 open ' + monBase() + ' in another tab or device';
    mon.timer = setInterval(monTick, MON_INTERVAL);
    monTick();
  }
  function monStop() {
    mon.on = false;
    clearInterval(mon.timer);
    monStart.textContent = 'Share view';
    if (!streaming) btn.classList.remove('on');
    monStatus.textContent = 'Stopped after ' + mon.sent + ' frames.';
  }
  monStart.addEventListener('click', function () { mon.on ? monStop() : monBegin(); });

  window.KBStream = {
    isStreaming: function () { return streaming; },
    frames: function () { return frames; },
    start: start, stop: stop,
    monitor: { isOn: function () { return mon.on; }, sent: function () { return mon.sent; }, start: monBegin, stop: monStop,
      debug: function () {
        var now = performance.now();
        return { inflight: mon.inflight, inputAgeMs: Math.round(now - lastInput), active: sceneActive(now) };
      } }
  };
})();
