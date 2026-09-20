/* ============================================================
 * 组件桥接 —— 让仿真台可以作为受控组件嵌进别的前端(ARISTOS)
 *
 * 仅在 URL 带 ?bridge=1 时启用。宿主页面通过 postMessage 传入初始场景、
 * 收取用户动作(拿起 / 移动 / 放下)和渲染帧。协议 v1:
 *
 *   宿主 → 仿真台
 *     {type:'kb:init',     scene:[ScenePart], options:{frames, fps, width, quality, moveHz}}
 *     {type:'kb:setScene', scene:[ScenePart]}
 *     {type:'kb:getScene'}                         → 回 kb:scene
 *     {type:'kb:getState'}                         → 回 kb:state
 *     {type:'kb:showNext'} / {type:'kb:showStep', step:<id|index>} / {type:'kb:hideAnswer'}
 *                                                  在用户当前结构上循环演示下一步 / 某一步的虚影
 *     {type:'kb:highlight', id, color|null}        高亮某个零件(琥珀色等),null 取消
 *     {type:'kb:fuse', parentId, childId} / {type:'kb:unfuse', childId}
 *                                                  两件从此一体移动(步骤判定完成后由宿主调用)
 *   仿真台 → 宿主
 *     {type:'kb:ready', protocol:1, keys:[...]}    仿真台就绪(零件库已加载)
 *     {type:'kb:grab' | 'kb:move' | 'kb:place', id, name, key, pose}
 *     {type:'kb:frame', image, t}                  JPEG data URL,默认 10 Hz
 *     {type:'kb:scene', parts:[{id, name, key, pose}]}
 *     {type:'kb:state', state, lastPlace?}         每次放下后的装配状态(见 check.js state()):
 *                                                  steps[{id,index,name,state:complete|available|premature|blocked,progress,requires}]
 *                                                  parts[{id,name,step,placed,ok,by}] issues[{severity,message,objectId,step}] next score
 *     {type:'kb:warn',  message}
 *
 *   ScenePart = {id, key | glb, name?, pose}
 *     id    零件实例 UUID(装配图里的 part id),回调里原样返回
 *     key   仿真台零件类型(如 'arm_5in');或给 glb 地址,按文件名里的
 *           模型 UUID 识别(assembly_graph_assets/<uuid>.glb)
 *     pose  {x, y, z, roll, pitch, yaw}
 *
 *   位姿约定与 aristos step_3d_paths.json 完全一致:毫米、Y 朝上、
 *   XYZ 欧拉角(弧度,R = Rx·Ry·Rz,roll→x pitch→y yaw→z),
 *   位置是 GLB 节点原点(不是包围盒中心)。
 * ============================================================ */
(function () {
  'use strict';
  if (!new URLSearchParams(location.search).has('bridge')) return;
  // 宿主:嵌在 iframe 里时是父页面;被 window.open 弹出时是打开者。都没有就没人可通信
  var host = window.parent !== window ? window.parent : window.opener;
  if (!host) return;

  var PROTOCOL = 1;

  var origin = '*';            // 首条宿主消息到达后记住其 origin
  var pendingInit = null;
  var options = { frames: true, fps: 10, width: 960, quality: 0.72, moveHz: 30 };
  var frameTimer = 0, lastMove = 0;

  function post(msg) { try { host.postMessage(msg, origin); } catch (e) { /* 宿主已关闭 */ } }
  function warn(message) { post({ type: 'kb:warn', message: message }); }

  /* ---------- 位姿换算与模型识别:统一在 parts.js(与 Kit 布局、答案数据同源) ---------- */
  function poseOf(node) { return KBParts.poseOf(node); }

  function describe(node) {
    return { id: node.userData.kbId, name: node.name, key: node.userData.kbType.slice(5), pose: poseOf(node) };
  }

  // 事件里收到的可能是零件,也可能是多选枢轴 → 展开成零件列表
  function partsOf(node) {
    if (KB.isPart(node)) return [node];
    var out = [];
    node.traverse(function (o) { if (o !== node && KB.isPart(o)) out.push(o); });
    return out;
  }

  /* ---------- 场景 ---------- */
  function setScene(parts) {
    var objects = [], skipped = [];
    (parts || []).forEach(function (part, i) {
      var o = KBParts.sceneObject(part);
      if (!o) { skipped.push(part.id || part.name || ('#' + i)); return; }
      if (!o.id) o.id = KB.newId();
      objects.push(o);
    });
    KB.loadSceneData({ v: 1, objects: objects }, true);
    KB.setSelection([]);
    KB.pushSnapshot();
    if (skipped.length) warn('Skipped parts with no known model: ' + skipped.join(', '));
  }

  function currentScene() {
    var out = [];
    KB.objectsRoot.traverse(function (o) { if (KB.isPart(o)) out.push(describe(o)); });
    return out;
  }

  /* ---------- 帧 ---------- */
  function startFrames() {
    stopFrames();
    if (options.frames === false) return;
    var every = Math.max(20, Math.round(1000 / (options.fps || 10)));
    frameTimer = setInterval(function () {
      var f = KB.captureFrame(options.width || 960, options.quality || 0.72);
      post({ type: 'kb:frame', image: f.canvas.toDataURL('image/jpeg', options.quality || 0.72), t: Date.now() });
    }, every);
  }
  function stopFrames() { if (frameTimer) { clearInterval(frameTimer); frameTimer = 0; } }

  /* ---------- 动作事件 ---------- */
  KB.on('grab', function (node) {
    partsOf(node).forEach(function (n) { var d = describe(n); d.type = 'kb:grab'; post(d); });
  });
  KB.on('move', function (node) {
    var now = performance.now(), minGap = 1000 / (options.moveHz || 30);
    if (now - lastMove < minGap) return;
    lastMove = now;
    partsOf(node).forEach(function (n) { var d = describe(n); d.type = 'kb:move'; post(d); });
  });
  KB.on('place', function (node) {
    partsOf(node).forEach(function (n) { var d = describe(n); d.type = 'kb:place'; post(d); });
    var st = stateMsg(partsOf(node)[0]);
    if (st) post(st);
  });

  /* ---------- 装配状态:仿真算几何,宿主据此更新任务图 ---------- */
  function stateMsg(placedNode) {
    if (!window.KBCheck) return null;
    var res = KBCheck.evaluate();
    var st = res && res.ready ? KBCheck.state() : null;
    if (!st) return null;
    var msg = { type: 'kb:state', state: st };
    if (placedNode) {
      var slot = KBCheck.slotOf(placedNode);
      msg.lastPlace = { objectId: placedNode.userData.kbId, pose: poseOf(placedNode),
        fitsStep: slot && slot.near.length ? res.steps[slot.ref.step].id : null, ok: !!(slot && slot.ok) };
    }
    return msg;
  }
  function stepIndex(ref) {
    var res = KBCheck.results();
    if (typeof ref === 'number') return ref;
    var hit = res && res.steps.filter(function (s) { return s.id === ref; })[0];
    return hit ? hit.i : -1;
  }

  /* ---------- 宿主消息 ---------- */
  function applyInit(msg) {
    if (msg.options) Object.keys(msg.options).forEach(function (k) { options[k] = msg.options[k]; });
    if (msg.scene) setScene(msg.scene);
    startFrames();
    var st = stateMsg();
    if (st) post(st);
  }

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('kb:') !== 0) return;
    if (ev.source !== host) return;
    if (ev.origin && ev.origin !== 'null') origin = ev.origin;
    switch (msg.type) {
      case 'kb:init':
        if (KBParts.ready()) applyInit(msg); else pendingInit = msg;
        break;
      case 'kb:setScene':
        if (KBParts.ready()) setScene(msg.scene); else pendingInit = { scene: msg.scene };
        break;
      case 'kb:getScene':
        post({ type: 'kb:scene', parts: currentScene() });
        break;
      case 'kb:stopFrames': stopFrames(); break;
      case 'kb:startFrames': startFrames(); break;
      case 'kb:getState': { var st = stateMsg(); if (st) post(st); break; }
      case 'kb:showNext': if (window.KBAnswer) KBAnswer.showNext(); break;
      case 'kb:showStep': if (window.KBAnswer) KBAnswer.showStep(stepIndex(msg.step)); break;
      case 'kb:hideAnswer': if (window.KBAnswer) KBAnswer.hide(); break;
      case 'kb:highlight': KB.highlight(KB.partById(msg.id), msg.color || null); break;
      case 'kb:fuse': KB.fuse(KB.partById(msg.parentId), KB.partById(msg.childId)); break;
      case 'kb:unfuse': KB.unfuse(KB.partById(msg.childId)); break;
    }
  });

  // 零件库就绪后握手;宿主若已抢先发来 init,此时执行
  (function waitReady() {
    if (!(window.KBParts && KBParts.ready())) { setTimeout(waitReady, 50); return; }
    post({ type: 'kb:ready', protocol: PROTOCOL, keys: KBParts.keys() });
    if (pendingInit) { applyInit(pendingInit); pendingInit = null; }
  })();
})();
