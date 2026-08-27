/* ============================================================
 * 手势模式 — 用摄像头 + MediaPipe Hands 隔空组装
 *
 * 手势词汇:
 *   捏合(拇指+食指)对准物体   抓取;移动手 = 移动物体
 *   手靠近 / 远离摄像头         把物体拉近 / 推远
 *   抓取时另一只手也捏合       双手旋转(绕竖直轴)+ 缩放
 *   捏合空白处拖动             旋转视角
 *   松开                       落定(应用吸附,记入撤销历史)
 *
 * 依赖 vendor/mediapipe/(本地模型,首次加载约 10MB)。
 * 需要 localhost / https 环境(摄像头 + WASM 的安全上下文要求),
 * file:// 直接打开时会提示改用 `python3 serve.py`。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var btn = document.getElementById('btnGesture');
  if (!btn) return;

  /* Artifact 沙盒里既没有摄像头权限也加载不了本地模型,直接隐藏入口 */
  if (window.claude && typeof window.claude.use === 'function') {
    btn.style.display = 'none';
    return;
  }

  var MP_BASE = location.pathname.indexOf('/dist/') >= 0
    ? '../vendor/mediapipe/' : 'vendor/mediapipe/';

  var active = false, starting = false;
  var hands = null, video = null, stream = null, rafId = 0;
  var pip = document.getElementById('gesturePip');
  var pipVideo = document.getElementById('gestureVideo');
  var pipCanvas = document.getElementById('gestureLm');
  var pipStatus = document.getElementById('gestureStatus');
  var layer = document.getElementById('gestureLayer');
  var lctx = layer.getContext('2d');

  /* ---------- 每只手的追踪状态 ---------- */
  function newHandState() {
    return { seen: false, x: 0, y: 0, scale: 0, pinch: false, pinchRaw: 1 };
  }
  var H = [newHandState(), newHandState()];

  /* 交互状态机 */
  var grab = null;   // {node, dist, offset:Vector3, handScale0, hand}
  var orbitDrag = null; // {hand, lastX, lastY}
  var bimanual = null;  // {baseLen, baseAngle, baseScale:Vector3, baseRotY}

  function dist2(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

  /* ---------- 启动 / 关闭 ---------- */
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = function () { rej(new Error('无法加载 ' + src)); };
      document.head.appendChild(s);
    });
  }

  function start() {
    if (starting || active) return;
    if (location.protocol === 'file:') {
      KB.toast('Gesture mode needs a local server: run python3 serve.py, then open http://localhost:8123');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      KB.toast('This browser does not support camera access');
      return;
    }
    starting = true;
    btn.classList.add('on');
    KB.toast('Starting camera and hand-tracking model\u2026');

    var ready = window.Hands ? Promise.resolve() : loadScript(MP_BASE + 'hands.js');
    ready.then(function () {
      return navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' }
      });
    }).then(function (s) {
      stream = s;
      video = pipVideo;
      video.srcObject = stream;
      video.muted = true;
      return video.play();
    }).then(function () {
      hands = new Hands({ locateFile: function (f) { return MP_BASE + f; } });
      hands.setOptions({
        maxNumHands: 2,
        modelComplexity: 0,
        selfieMode: true,          // 镜像坐标,匹配镜像预览
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5
      });
      hands.onResults(onResults);
      active = true;
      starting = false;
      pip.style.display = 'block';
      layer.style.display = 'block';
      resizeLayer();
      loop();
      KB.toast('Gesture mode on: pinch to grab \u00b7 two hands rotate/scale \u00b7 pinch empty space to orbit');
    }).catch(function (err) {
      starting = false;
      btn.classList.remove('on');
      stop(true);
      if (err && err.name === 'NotAllowedError') KB.toast('Camera permission denied');
      else KB.toast('Gesture mode failed to start: ' + (err.message || err.name || err));
    });
  }

  var sending = false;
  function loop() {
    if (!active) return;
    rafId = requestAnimationFrame(loop);
    if (sending || !video || video.readyState < 2) return;
    sending = true;
    hands.send({ image: video }).then(function () { sending = false; })
      .catch(function () { sending = false; });
  }

  function stop(silent) {
    active = false;
    cancelAnimationFrame(rafId);
    releaseGrab(false);
    orbitDrag = null;
    bimanual = null;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (hands) { try { hands.close(); } catch (e) { /* 忽略 */ } hands = null; }
    if (pipVideo) pipVideo.srcObject = null;
    pip.style.display = 'none';
    layer.style.display = 'none';
    btn.classList.remove('on');
    if (!silent) KB.toast('Gesture mode off');
  }

  btn.addEventListener('click', function () { active ? stop() : start(); });
  window.addEventListener('resize', resizeLayer);
  function resizeLayer() {
    layer.width = window.innerWidth;
    layer.height = window.innerHeight;
  }

  /* ---------- 手势解析 ---------- */
  var PINCH_ON = 0.38, PINCH_OFF = 0.52;  // 相对手掌尺寸的捏合阈值(带迟滞)
  var SMOOTH = 0.45;

  function onResults(results) {
    var lms = results.multiHandLandmarks || [];
    for (var i = 0; i < 2; i++) {
      var st = H[i];
      if (i < lms.length) {
        var lm = lms[i];
        var size = dist2(lm[0].x, lm[0].y, lm[9].x, lm[9].y);
        var pinchRaw = dist2(lm[4].x, lm[4].y, lm[8].x, lm[8].y) / Math.max(size, 1e-4);
        var cx = (lm[4].x + lm[8].x) / 2 * window.innerWidth;
        var cy = (lm[4].y + lm[8].y) / 2 * window.innerHeight;
        if (!st.seen) { st.x = cx; st.y = cy; st.scale = size; }
        st.x += (cx - st.x) * SMOOTH;
        st.y += (cy - st.y) * SMOOTH;
        st.scale += (size - st.scale) * 0.25;
        st.pinchRaw = pinchRaw;
        if (!st.pinch && pinchRaw < PINCH_ON) { st.pinch = true; onPinchStart(i); }
        else if (st.pinch && pinchRaw > PINCH_OFF) { st.pinch = false; onPinchEnd(i); }
        st.seen = true;
      } else {
        if (st.pinch) { st.pinch = false; onPinchEnd(i); }
        st.seen = false;
      }
    }
    updateInteraction();
    drawPip(lms);
    drawLayer();
  }

  function onPinchStart(i) {
    var st = H[i];
    if (grab) {
      // 已有抓取:第二只手捏合 → 进入双手旋转缩放
      if (grab.hand !== i && !bimanual) beginBimanual();
      return;
    }
    var hit = KB.raycastTopAt(st.x, st.y);
    if (hit) {
      var node = hit.node;
      grab = { // 先建立抓取状态,setSelection 的铰链枢轴逻辑才会跳过
        node: node,
        hand: i,
        dist: KB.camera.position.distanceTo(hit.point),
        offset: node.position.clone().sub(hit.point),
        handScale0: st.scale
      };
      KB.setSelection([node]);
      if (window.KBSnap) KBSnap.begin(node); // 手势拖动也走面/轴磁性吸附
    } else {
      orbitDrag = { hand: i, lastX: st.x, lastY: st.y };
    }
  }

  function onPinchEnd(i) {
    if (grab && bimanual) {
      // 任一只手松开都结束双手旋转缩放
      bimanual = null;
      if (i === grab.hand) {
        var other = grab.hand === 0 ? 1 : 0;
        if (H[other].pinch) regrabWith(other); // 主手先松:抓取转移到副手
        else releaseGrab(true);
      } else {
        // 副手松开:主手继续抓取,重新锚定深度基准
        grab.dist = KB.camera.position.distanceTo(
          grab.node.position.clone().sub(grab.offset));
        grab.handScale0 = H[grab.hand].scale;
      }
      return;
    }
    if (grab && i === grab.hand) { releaseGrab(true); return; }
    if (orbitDrag && i === orbitDrag.hand) {
      orbitDrag = null;
      KB.rebuildAttachment(); // 恢复因拾取临时收回的枢轴 / gizmo
    }
  }

  function regrabWith(handIdx) {
    var st = H[handIdx];
    var node = grab.node;
    var world = node.position.clone();
    grab = {
      node: node,
      hand: handIdx,
      dist: KB.camera.position.distanceTo(world),
      offset: new THREE.Vector3(0, 0, 0),
      handScale0: st.scale
    };
  }

  function beginBimanual() {
    // 进入双手模式时获取一次当前约束,旋转期间只维持不换孔
    if (window.KBSnap && grab) {
      KBSnap.solve(grab.node, grab.node.position.clone());
    }
    var a = H[0], b = H[1];
    bimanual = {
      mode: null,   // null=待判定 | 'scale' | 'rotate'(先触发哪个锁定哪个)
      baseLen: dist2(a.x, a.y, b.x, b.y),
      baseAngle: Math.atan2(-(b.y - a.y), b.x - a.x),
      baseScale: grab.node.scale.clone(),
      baseRotY: grab.node.rotation.y
    };
  }

  function normAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  function releaseGrab(commit) {
    if (!grab) return;
    var node = grab.node;
    grab = null;
    bimanual = null;
    var snapped = window.KBSnap ? KBSnap.end() : null;
    if (commit) {
      if (!snapped && KB.isSnap()) {
        node.position.x = Math.round(node.position.x / 0.25) * 0.25;
        node.position.y = Math.round(node.position.y / 0.25) * 0.25;
        node.position.z = Math.round(node.position.z / 0.25) * 0.25;
        var step = Math.PI / 12; // 15°
        node.rotation.y = Math.round(node.rotation.y / step) * step;
      }
      KB.pushSnapshot();
    }
  }

  function updateInteraction() {
    if (grab) {
      var st = H[grab.hand];
      if (st.seen) {
        // 手掌尺寸变化 → 深度:靠近摄像头 = 拉近物体
        var f = Math.pow(grab.handScale0 / Math.max(st.scale, 1e-4), 1.5);
        var d = Math.max(1.0, Math.min(50, grab.dist * f));
        var desired = KB.unprojectAt(st.x, st.y, d).add(grab.offset);
        if (desired.y < 0.05) desired.y = 0.05;
        // 双手模式下缩放会改变特征,暂停吸附求解
        if (window.KBSnap && !bimanual) KBSnap.solve(grab.node, desired);
        else grab.node.position.copy(desired);
      }
      if (bimanual && H[0].seen && H[1].seen) {
        var len = dist2(H[0].x, H[0].y, H[1].x, H[1].y);
        var ang = Math.atan2(-(H[1].y - H[0].y), H[1].x - H[0].x);
        var dAng = normAngle(ang - bimanual.baseAngle);
        if (!bimanual.mode) {
          // 死区内待判定;先越过哪个阈值就锁定哪种操作,并重新锚定避免跳变
          if (Math.abs(Math.log(len / Math.max(bimanual.baseLen, 1))) > 0.166) { // ±18%
            bimanual.mode = 'scale';
            bimanual.baseLen = len;
            bimanual.baseScale = grab.node.scale.clone();
          } else if (Math.abs(dAng) > 0.21) { // ~12°
            bimanual.mode = 'rotate';
            bimanual.baseAngle = ang;
            bimanual.baseRotY = grab.node.rotation.y;
          }
        } else if (bimanual.mode === 'scale') {
          var ratio = Math.max(0.2, Math.min(5, len / Math.max(bimanual.baseLen, 1)));
          grab.node.scale.copy(bimanual.baseScale).multiplyScalar(ratio);
        } else {
          // 1.6 倍增益:手转 ±45° 就能覆盖 ±72°
          grab.node.rotation.y = bimanual.baseRotY + normAngle(ang - bimanual.baseAngle) * 1.6;
          // 吸附在孔上时,旋转保持轴对齐 → 等效绕孔转(不获取新吸附,防跳孔)
          if (window.KBSnap) {
            KBSnap.solve(grab.node, grab.node.position.clone(), { noAcquire: true });
          }
        }
      }
      KB.syncInspector(); // 属性面板数值跟随手势实时刷新
    } else if (orbitDrag) {
      var oh = H[orbitDrag.hand];
      if (oh.seen) {
        var dx = oh.x - orbitDrag.lastX, dy = oh.y - orbitDrag.lastY;
        orbitDrag.lastX = oh.x;
        orbitDrag.lastY = oh.y;
        var cam = KB.camera, target = KB.orbit.target;
        var offset = cam.position.clone().sub(target);
        var sph = new THREE.Spherical().setFromVector3(offset);
        sph.theta -= dx * 0.005;
        sph.phi -= dy * 0.005;
        sph.phi = Math.max(0.08, Math.min(Math.PI * 0.49, sph.phi));
        cam.position.copy(target).add(new THREE.Vector3().setFromSpherical(sph));
        cam.lookAt(target);
      }
    }
  }

  /* ---------- 叠加层绘制 ---------- */
  function drawLayer() {
    lctx.clearRect(0, 0, layer.width, layer.height);
    if (bimanual && H[0].seen && H[1].seen) {
      lctx.strokeStyle = 'rgba(232,163,61,0.45)';
      lctx.lineWidth = 1.5;
      lctx.setLineDash([6, 6]);
      lctx.beginPath();
      lctx.moveTo(H[0].x, H[0].y);
      lctx.lineTo(H[1].x, H[1].y);
      lctx.stroke();
      lctx.setLineDash([]);
      var label = bimanual.mode === 'scale' ? 'Scale'
        : bimanual.mode === 'rotate' ? 'Rotate'
          : 'spread = scale \u00b7 turn = rotate';
      var mx = (H[0].x + H[1].x) / 2, my = (H[0].y + H[1].y) / 2 - 14;
      lctx.font = '12px "IBM Plex Sans", "Noto Sans SC", sans-serif';
      lctx.textAlign = 'center';
      lctx.lineWidth = 4;
      lctx.strokeStyle = 'rgba(20, 24, 30, 0.85)';
      lctx.strokeText(label, mx, my);
      lctx.fillStyle = 'rgba(232,163,61,0.95)';
      lctx.fillText(label, mx, my);
    }
    for (var i = 0; i < 2; i++) {
      var st = H[i];
      if (!st.seen) continue;
      lctx.beginPath();
      lctx.arc(st.x, st.y, st.pinch ? 8 : 12, 0, Math.PI * 2);
      if (st.pinch) {
        lctx.fillStyle = 'rgba(232,163,61,0.85)';
        lctx.fill();
      } else {
        lctx.strokeStyle = 'rgba(232,163,61,0.8)';
        lctx.lineWidth = 2;
        lctx.stroke();
      }
    }
  }

  var LM_EDGES = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
  ];

  function drawPip(lms) {
    var w = pipCanvas.width, h = pipCanvas.height;
    var ctx = pipCanvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(232,163,61,0.7)';
    ctx.fillStyle = 'rgba(231,236,242,0.9)';
    ctx.lineWidth = 1;
    lms.forEach(function (lm) {
      LM_EDGES.forEach(function (e) {
        ctx.beginPath();
        ctx.moveTo(lm[e[0]].x * w, lm[e[0]].y * h);
        ctx.lineTo(lm[e[1]].x * w, lm[e[1]].y * h);
        ctx.stroke();
      });
      lm.forEach(function (p) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 1.6, 0, Math.PI * 2);
        ctx.fill();
      });
    });
    var suffix = '';
    if (grab && bimanual) {
      suffix = bimanual.mode === 'scale' ? ' \u00b7 two-hand scale'
        : bimanual.mode === 'rotate' ? ' \u00b7 two-hand rotate' : ' \u00b7 two-hand\u2026';
    } else if (grab) {
      suffix = ' \u00b7 grabbing';
    }
    pipStatus.textContent = lms.length
      ? lms.length + ' hand' + (lms.length > 1 ? 's' : '') + suffix
      : 'Show your hand to the camera';
  }

  /* 调试入口:可直接喂合成 landmark 数据驱动手势状态机(测试用) */
  window.KBGesture = {
    feed: onResults,
    state: function () {
      return { grabbing: !!grab, bimanual: !!bimanual, orbiting: !!orbitDrag };
    }
  };
})();
