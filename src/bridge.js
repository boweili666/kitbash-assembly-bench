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
 *   仿真台 → 宿主
 *     {type:'kb:ready', protocol:1, keys:[...]}    仿真台就绪(零件库已加载)
 *     {type:'kb:grab' | 'kb:move' | 'kb:place', id, name, key, pose}
 *     {type:'kb:frame', image, t}                  JPEG data URL,默认 10 Hz
 *     {type:'kb:scene', parts:[{id, name, key, pose}]}
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
  if (window.parent === window) return;   // 不在 iframe 里,没人可通信

  var PROTOCOL = 1;
  // 装配图模型 UUID → 仿真台零件类型(assembly_graph_assets/<uuid>.glb)
  var MODEL_MAP = {
    "3989ee7c-49b0-4a91-93fa-8b5faf6ce43c": "aluminum_arm_wedge_5mm",
    "db195d0b-0de3-4ddc-8c6c-6672fee30986": "screw_m3x16_socket_cap",
    "61b9b0c7-2626-474d-af91-1e9b38c0d570": "aluminum_x_lock",
    "3afd0f37-d270-4c5b-8327-e8192f4a7b4f": "split_rear_plate",
    "87e89b9b-e727-4c7a-b125-58108842879a": "screw_m3x22_pan",
    "241d88c2-e829-4e9f-8c79-fa44329035d6": "arm_5in",
    "6e6d8d23-fdf0-440a-b675-942ffcb9c776": "split_front_plate",
    "c85bff8b-b730-495b-9a19-01150ca168a2": "screw_m3x6_pan",
    "40cd7f66-a31c-473e-a32c-bea8ed97a1c8": "screw_m3x16_pan",
    "5c8559df-bcad-4a81-a84c-6f2455461b35": "knurled_standoff",
    "fdc19e95-c2d3-4fb7-a51b-fd3babcfba21": "motor_2207",
    "846d88a9-a6d2-4db9-be31-9d312aded87c": "motor_nut_m5",
    "9c37da50-5c65-49c0-a81f-e62bf299691e": "screw_m3x8_socket_cap",
    "f3addb33-9034-48e3-8195-a51e5cb8dd74": "damper_m2",
    "94ab9f35-e676-4ce6-9fdf-a63e8e3f30ff": "esc_4in1",
    "846d88a9a6d24db9be319d312aded87c": "motor_nut_m5",
    "f3addb33903448e38195a51e5cb8dd74": "damper_m2",
    "94ab9f35e6764ce69fdfa63e8e3f30ff": "esc_4in1"
  };

  var origin = '*';            // 首条宿主消息到达后记住其 origin
  var pendingInit = null;
  var options = { frames: true, fps: 10, width: 960, quality: 0.72, moveHz: 30 };
  var frameTimer = 0, lastMove = 0;

  function post(msg) { window.parent.postMessage(msg, origin); }
  function warn(message) { post({ type: 'kb:warn', message: message }); }

  /* ---------- 位姿换算 ---------- */
  function unitsPerMm() { return KBParts.unitScale() / 1000; }

  // 零件节点 → GLB 原点的世界位姿(mm / XYZ 欧拉)
  function poseOf(node) {
    var key = node.userData.kbType.slice(5);
    var spec = KBParts.spec(key);
    var S = KBParts.unitScale(), k = S / 1000;
    node.updateMatrixWorld(true);
    var originLocal = spec
      ? new THREE.Vector3(-spec.offset[0] * S, -spec.offset[1] * S, -spec.offset[2] * S)
      : new THREE.Vector3();
    var p = node.localToWorld(originLocal);
    var q = node.getWorldQuaternion(new THREE.Quaternion());
    var e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    return { x: p.x / k, y: p.y / k, z: p.z / k, roll: e.x, pitch: e.y, yaw: e.z };
  }

  // GLB 原点位姿 → 零件节点的 position / rotation(节点直接挂在场景根下)
  function nodeTransform(key, pose) {
    var spec = KBParts.spec(key);
    var S = KBParts.unitScale(), k = S / 1000;
    var e = new THREE.Euler(pose.roll || 0, pose.pitch || 0, pose.yaw || 0, 'XYZ');
    var q = new THREE.Quaternion().setFromEuler(e);
    var offW = spec
      ? new THREE.Vector3(spec.offset[0] * S, spec.offset[1] * S, spec.offset[2] * S).applyQuaternion(q)
      : new THREE.Vector3();
    return {
      p: [(pose.x || 0) * k + offW.x, (pose.y || 0) * k + offW.y, (pose.z || 0) * k + offW.z],
      r: [e.x, e.y, e.z]
    };
  }

  // 模型 UUID 在不同数据源里有带连字符和不带两种写法,统一成 32 位裸 hex 再查
  var MODEL_KEYS = {};
  Object.keys(MODEL_MAP).forEach(function (u) { MODEL_KEYS[u.replace(/-/g, '').toLowerCase()] = MODEL_MAP[u]; });

  function keyFor(part) {
    if (part.key) return KBParts.spec(part.key) ? part.key : null;
    if (part.glb) {
      var m = /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i.exec(part.glb);
      if (m) return MODEL_KEYS[m[1].replace(/-/g, '').toLowerCase()] || null;
    }
    return null;
  }

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
      var key = keyFor(part);
      if (!key) { skipped.push(part.id || part.name || ('#' + i)); return; }
      var t = nodeTransform(key, part.pose || {});
      objects.push({ id: part.id || KB.newId(), name: part.name || KBParts.spec(key).label,
        type: 'part:' + key, p: t.p, r: t.r, s: [1, 1, 1] });
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
  });

  /* ---------- 宿主消息 ---------- */
  function applyInit(msg) {
    if (msg.options) Object.keys(msg.options).forEach(function (k) { options[k] = msg.options[k]; });
    if (msg.scene) setScene(msg.scene);
    startFrames();
  }

  window.addEventListener('message', function (ev) {
    var msg = ev.data;
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('kb:') !== 0) return;
    if (ev.source !== window.parent) return;
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
    }
  });

  // 零件库就绪后握手;宿主若已抢先发来 init,此时执行
  (function waitReady() {
    if (!(window.KBParts && KBParts.ready())) { setTimeout(waitReady, 50); return; }
    post({ type: 'kb:ready', protocol: PROTOCOL, keys: Object.keys(MODEL_MAP).map(function (k) { return MODEL_MAP[k]; }) });
    if (pendingInit) { applyInit(pendingInit); pendingInit = null; }
  })();
})();
