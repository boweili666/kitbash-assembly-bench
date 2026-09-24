/* ============================================================
 * 组件桥接 —— 让仿真台可以作为受控组件嵌进别的前端(ARISTOS)
 *
 * 仅在 URL 带 ?bridge=1 时启用。宿主页面通过 postMessage 传入初始场景、
 * 收取用户动作(拿起 / 移动 / 放下)和渲染帧。协议 v1:
 *
 *   宿主 → 仿真台
 *     {type:'kb:init',     scene:[ScenePart], options:{frames, fps, width, quality, moveHz, guide, level, tray}}
 *                                                  tray:false = 料盘里的零件也按传入坐标摆(默认按类型分格重排)
 *                                                  level:1 点零件就到位 / 2 点对孔就摆正 / 3 手动(现在的做法)
 *                                                  guide:true 装完场景就打开逐步指引(第一次装的人)
 *     {type:'kb:setScene', scene:[ScenePart]}
 *     {type:'kb:setLevel', level:1|2|3}            切换难度级别
 *     {type:'kb:getScene'}                         → 回 kb:scene
 *     {type:'kb:getAnswer'}                        → 回 kb:answer{steps,parts}(参考装配的最终位姿)
 *     {type:'kb:getState'}                         → 回 kb:state
 *     {type:'kb:showNext'} / {type:'kb:showStep', step:<id|index>} / {type:'kb:hideAnswer'}
 *     {type:'kb:look', where:'work'|'tray'|'ghost'} 镜头飞到装配区 / 物料区 / 当前虚影
 *                                                  在用户当前结构上循环演示下一步 / 某一步的虚影
 *     {type:'kb:highlight', id, color|null}        高亮某个零件(琥珀色等),null 取消
 *     {type:'kb:fuse', parentId, childId} / {type:'kb:unfuse', childId}
 *                                                  两件从此一体移动(步骤判定完成后由宿主调用)
 *   仿真台 → 宿主
 *     {type:'kb:ready', protocol:1, keys:[...]}    仿真台就绪(零件库已加载)
 *     {type:'kb:grab' | 'kb:move' | 'kb:place', id, name, key, pose}
 *     Automatic frame capture is disabled; no kb:frame events are emitted.
 *     {type:'kb:scene', parts:[{id, name, key, pose}]}
 *     {type:'kb:state', state, lastPlace?}         每次放下后的装配状态(见 check.js state()):
 *                                                  steps[{id,index,name,state:complete|available|premature|blocked,progress,requires}]
 *                                                  parts[{id,name,step,placed,ok,by}] issues[{severity,message,objectId,step}] next score
 *     {type:'kb:guide', guide|null}                Next 引导卡片的内容:{step,name,state,status,
 *                                                  message,ok,total,settled,steps,parts[{name,key,ok,state}]}
 *     {type:'kb:pickWarn', pick}                  拿了这一步用不到的零件:{objectId,name,key,step,stepName,belongsToStep,message}
 *     {type:'kb:handleClick', objectId, handleId, end}
 *                                                  点了某个零件上的孔 / 销(handle):选源、点目标都算。
 *                                                  handleId 是 H1 / P1 这类特征号;end:孔的哪个孔口(1 / -1),销是 0
 *     {type:'kb:handleMatch', object1, handle1, object2, handle2, success, error}
 *                                                  点完目标后的结论:object1/handle1 是先点的(要动的),object2/handle2 是后点的。
 *                                                  success=false 时 error 是原因;三级配合后被判错撤销的,会再补一条 success=false
 *     {type:'kb:warn',  message}
 *     {type:'kb:tutorialEnd', reason:'completed'|'skipped', experience:'first'|'again'|null, level:1|2|3|null}
 *                                                  experience 是最后一屏问出来的:第一次装 / 装过
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

  var tutorialSession = false;
  var origin = '*';            // 首条宿主消息到达后记住其 origin
  var pendingInit = null;
  var options = { frames: false, fps: 10, width: 960, quality: 0.72, moveHz: 30 };
  var lastMove = 0;

  function post(msg) {
    // Practice must never become training frames, actions, or scored progress.
    if (tutorialSession && /^kb:(frame|grab|move|place|state|snapAttempt|collision|handleClick|handleMatch)$/.test(msg.type)) return;
    try { host.postMessage(msg, origin); } catch (e) { /* 宿主已关闭 */ } }
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
    // 料盘里的零件按类型 / 螺丝长度分格摆(和独立网页"摆整套零件"一样,带格子和标签);
    // 已经在装配区里的(比如恢复进度)保持宿主给的位置。options.tray === false 时全按宿主坐标
    if (window.KBTray && options.tray !== false) {
      var ws = window.KBWorkspace && KBWorkspace.bounds;
      var loose = objects.filter(function (o) {
        var p = o.p || [0, 0, 0];
        return !(ws && p[0] >= ws.minX && p[0] <= ws.maxX && p[2] >= ws.minZ && p[2] <= ws.maxZ);
      });
      if (loose.length) KBTray.arrange(loose);
    }
    KB.loadSceneData({ v: 1, objects: objects }, true);
    KB.setSelection([]);
    KB.pushSnapshot();
    KB.resetHistory();
    if (window.KBWorkspace) KBWorkspace.overview();
    if (skipped.length) warn('Skipped parts with no known model: ' + skipped.join(', '));
  }

  function currentScene() {
    var out = [];
    KB.objectsRoot.traverse(function (o) { if (KB.isPart(o)) out.push(describe(o)); });
    return out;
  }

  /* Automatic image capture is disabled. Legacy frame commands remain no-ops
   * so older ARISTOS hosts cannot restart JPEG encoding in this build. */
  function startFrames() {}
  function stopFrames() {}

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
  // 零件自己飞(一二级自动到位、配合吸附)时也按 move 报,和拖动一样节流
  KB.on('tweenMove', function (node) {
    if (!node || !(KB.isPart(node) || node.parent === KB.objectsRoot)) return;
    var now = performance.now(), minGap = 1000 / (options.moveHz || 30);
    if (now - lastMove < minGap) return;
    lastMove = now;
    partsOf(node).forEach(function (n) { var d = describe(n); d.type = 'kb:move'; post(d); });
  });
  KB.on('handleClick', function (h) {
    if (!h || !h.node) return;
    post({ type: 'kb:handleClick', objectId: h.node.userData.kbId || null, handleId: h.id, end: h.end || 0 });
  });
  KB.on('handleMatch', function (m) {
    if (!m || !m.a || !m.b) return;
    post({ type: 'kb:handleMatch', object1: m.a.node.userData.kbId || null, handle1: m.a.id,
      object2: m.b.node.userData.kbId || null, handle2: m.b.id, success: !!m.success, error: m.success ? null : (m.error || null) });
  });
  KB.on('snapAttempt', function (a) {
    post({ type: 'kb:snapAttempt', object1: a.object1.userData.kbId, object2: a.object2.userData.kbId,
      snapPoint1: a.snapPoint1, snapPoint2: a.snapPoint2, success: a.success, reason: a.reason });
  });
  KB.on('collision', function (c) {
    post({ type: 'kb:collision', object1: c.object1.userData.kbId, object2: c.object2.userData.kbId,
      kind: c.kind, depthMm: c.depthMm, snapPoint1: c.snapPoint1, snapPoint2: c.snapPoint2 });
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
  // 引导卡片的文字(Next 给出的那几句)原样转给宿主 —— 调试页面和 ARISTOS 都能用
  KB.on('guide', function (g) { post({ type: 'kb:guide', guide: g || null }); });
  // 学员拿了这一步用不到的零件 —— 只是提醒,没拦着
  KB.on('pickWarn', function (w) { post({ type: 'kb:pickWarn', pick: w }); });

  KB.on('tutorialEnd', function (result) {
    if (tutorialSession) post({ type: 'kb:tutorialEnd', reason: result.reason, experience: result.experience || null, level: result.level || null });
    // Keep practice isolated until the host mounts the actual task scene.
  });

  function applyInit(msg) {
    if (msg.options) Object.keys(msg.options).forEach(function (k) { options[k] = msg.options[k]; });
    tutorialSession = !!options.tutorial;
    if (options.level && window.KBLevel) KBLevel.set(options.level, true);   // 宿主给的难度级别
    if (tutorialSession) {
      stopFrames();
      if (window.KBTutorial) KBTutorial.start({ onboarding: true, level: options.level });
      else warn('This simulator build does not include the tutorial.');
      return;
    }
    if (msg.scene) setScene(msg.scene);
    startFrames();
    var st = stateMsg();
    if (st) post(st);
    // options.guide:第一次装的人,宿主换到任务场景后直接把逐步指引打开,不用再点 Next
    if (options.guide && window.KBAnswer) setTimeout(function () { KBAnswer.showNext(); }, 400);
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
      case 'kb:setLevel': if (window.KBLevel) KBLevel.set(msg.level); break;
      case 'kb:getAnswer': {
        // 参考装配(含推导补的那部分)原样给出去,调试页面拿它拼"装到第 N 步"的场景
        var a = window.KBParts && KBParts.answer && KBParts.answer();
        // 顺带把装配区的位置(毫米)给出去:参考位姿是绕原点的,而原点现在是物料区,
        // 宿主 / 调试页面要把整套位姿平移到装配区里,判定才会认
        var mm = 1000 / KBParts.unitScale();
        var w = window.KBWorkspace;
        post({ type: 'kb:answer',
               workspace: w ? { center: { x: w.center.x * mm, y: w.center.y * mm, z: w.center.z * mm },
                                bounds: { minX: w.bounds.minX * mm, maxX: w.bounds.maxX * mm,
                                          minZ: w.bounds.minZ * mm, maxZ: w.bounds.maxZ * mm } } : null,
               steps: a ? a.steps.map(function (st) {
                 return { i: st.i, name: st.name, derived: !!st.derived, requires: st.requires || [] }; }) : [],
               parts: a ? a.parts.map(function (d) {
                 return { id: d.id, key: d.key, name: d.name, step: d.step, derived: !!d.derived,
                          pose: d.path[d.path.length - 1] }; }) : [] });
        break;
      }
      case 'kb:getScene':
        post({ type: 'kb:scene', parts: currentScene() });
        break;
      case 'kb:stopFrames': stopFrames(); break;
      case 'kb:startFrames': startFrames(); break;
      case 'kb:getState': { var st = stateMsg(); if (st) post(st); break; }
      case 'kb:showNext': if (window.KBAnswer) KBAnswer.showNext(); break;
      case 'kb:showStep': if (window.KBAnswer) KBAnswer.showStep(stepIndex(msg.step)); break;
      case 'kb:hideAnswer': if (window.KBAnswer) KBAnswer.hide(); break;
      case 'kb:look':
        if (msg.where === 'ghost') { if (window.KBAnswer) KBAnswer.frameGhost(); }
        else if (window.KBWorkspace) KBWorkspace.look(msg.where === 'tray' ? 'tray' : 'work');
        break;
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
