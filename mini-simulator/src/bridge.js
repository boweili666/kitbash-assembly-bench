/* ============================================================
 * mini 的宿主桥 —— 只有四条消息
 *
 * 派生自 ca69f1e 的 src/bridge.js, 砍到只剩演示窗格用得上的部分。协议 v1
 * 的其余命令(setScene / setLevel / getScene / getAnswer / getState /
 * showNext / hideAnswer / look / highlight / fuse / unfuse)和其余回报
 * (grab / move / place / state / guide / pickWarn / handleClick /
 * handleMatch / snapAttempt / collision / frame / tutorialEnd)全部不在:
 * mini 里没人动零件, 也没有判定和抓帧。
 *
 *   宿主 → mini
 *     {type:'kb:init',  scene:[ScenePart], stepNames?:{id:name}, options?:{tray}}
 *     {type:'kb:showStep', step:<任务图 step id | 序号>}
 *   mini → 宿主
 *     {type:'kb:ready', protocol:1, keys:[...]}
 *     {type:'kb:warn',  message}
 *
 * ScenePart = {id, key | glb, name?, pose}, 与主台子同义(mm · Y 朝上 ·
 * XYZ 欧拉 · GLB 节点原点)。零件按宿主给的坐标摆(等价于原版的
 * options.tray === false):mini 不重排料盘。
 * ============================================================ */
(function () {
  'use strict';
  if (!new URLSearchParams(location.search).has('bridge')) return;
  var host = window.parent !== window ? window.parent : window.opener;
  if (!host) return;

  var PROTOCOL = 1;
  var origin = '*';
  var pendingInit = null;
  var pendingStep = null;      // init 还没落地就来的 showStep, 等装完再补播
  var stepNames = null;

  function post(msg) {
    try { host.postMessage(msg, origin); } catch (e) { /* 宿主已关闭 */ }
  }
  function warn(message) { post({ type: 'kb:warn', message: message }); }

  function setScene(parts) {
    var objects = [], skipped = [];
    (parts || []).forEach(function (part, i) {
      var o = KBParts.sceneObject(part);
      if (!o) { skipped.push(part.id || part.name || ('#' + i)); return; }
      if (!o.id) o.id = KB.newId();
      objects.push(o);
    });
    KB.loadSceneData({ v: 1, objects: objects });
    if (skipped.length) warn('Skipped parts with no known model: ' + skipped.join(', '));
  }

  function applyInit(msg) {
    if (msg.stepNames) stepNames = msg.stepNames;
    if (msg.scene) setScene(msg.scene);
    var r = window.KBMini.init();
    if (!r.ok) warn('No reference assembly in the part library');
    else if (r.missing.length) warn('Scene is missing ' + r.missing.length + ' part(s) of the reference assembly: ' + r.missing.slice(0, 5).join(', '));
  }

  function applyStep(ref) {
    var i = window.KBMini.stepIndex(ref, stepNames);
    if (i < 0) { warn('Unknown step: ' + ref); return; }
    if (!window.KBMini.showStep(i)) warn('Cannot play step ' + ref + ' (no parts bound)');
  }

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('kb:') !== 0) return;
    if (ev.source !== host) return;      // 只听父窗口, 页面内自己 postMessage 无效
    if (ev.origin && ev.origin !== 'null') origin = ev.origin;
    switch (msg.type) {
      case 'kb:init':
        if (KBParts.ready()) { applyInit(msg); if (pendingStep !== null) { applyStep(pendingStep); pendingStep = null; } }
        else pendingInit = msg;
        break;
      case 'kb:showStep':
        if (window.KBMini.ready()) applyStep(msg.step);
        else pendingStep = msg.step;     // 20 个 GLB 还在解析, 装完再补播
        break;
    }
  });

  (function waitReady() {
    if (!(window.KBParts && KBParts.ready())) { setTimeout(waitReady, 50); return; }
    post({ type: 'kb:ready', protocol: PROTOCOL, keys: KBParts.keys() });
    if (pendingInit) { applyInit(pendingInit); pendingInit = null; }
    if (pendingStep !== null && window.KBMini.ready()) { applyStep(pendingStep); pendingStep = null; }
  })();
})();
