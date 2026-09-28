/* ============================================================
 * mini core — 只有渲染 + 场景树, 没有编辑器
 *
 * 这是 bowei 台子 src/app.js 的替身。app.js 是 1538 行的编辑器主体
 * (工具栏 / 属性面板 / 拾取 / gizmo / 撤销 / 自动存档 / 树视图), mini 一样
 * 都不要。这里只搬过来它真正的"内核"部分, 函数体逐字复制自 ca69f1e 的
 * src/app.js, 行号见每段注释:
 *
 *   渲染器 / 灯光 / 地面 / objectsRoot   app.js:26-75
 *   isPartNode                           app.js:141-143
 *   buildNode / clearSceneObjects /
 *   loadSceneData                        app.js:184-257 (去掉基础几何体分支和 refreshTree)
 *   newId                                app.js:438-443
 *   highlight / partById                 app.js:711-726
 *   flyCamera + animate 的镜头补间        app.js:1386-1410
 *
 * 去掉的: TransformControls、Raycaster 拾取、selection、undo/redo、
 * serializeScene、autosave、inspector、tree、toast、modal、tweens、
 * pivot/group/fuse。零件不能被选中也不能被拖动 —— 这是 mini 的硬要求。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------- 渲染器 / 场景 (app.js:26-75) ---------- */
  var canvas = document.getElementById('viewport');
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1e24);
  scene.fog = new THREE.Fog(0x1a1e24, 24, 60);

  var camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(5.2, 3.8, 6.6);

  var hemi = new THREE.HemisphereLight(0xdfe8f2, 0x232a33, 0.85);
  scene.add(hemi);
  var sun = new THREE.DirectionalLight(0xfff4e0, 1.35);
  sun.position.set(5, 9, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -12; sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12; sun.shadow.camera.bottom = -12;
  sun.shadow.camera.far = 40;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  var fill = new THREE.DirectionalLight(0xb8c6d8, 0.28);
  fill.position.set(-5, 4, -5);
  scene.add(fill);

  var shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.ShadowMaterial({ opacity: 0.28, depthWrite: false, side: THREE.FrontSide })
  );
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);

  var objectsRoot = new THREE.Group();
  objectsRoot.name = 'objectsRoot';
  scene.add(objectsRoot);

  /* ---------- 相机控制:只有转和缩放 ----------
   * enablePan = false:平移会把取景推走, 而取景是 mini 的一条硬要求。
   * 没有 TransformControls, 也没有任何 pointerdown 拾取 —— 零件动不了。 */
  var orbit = new THREE.OrbitControls(camera, canvas);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.enablePan = false;
  orbit.target.set(0, 1.4, 0);
  orbit.maxPolarAngle = Math.PI * 0.97;
  orbit.minDistance = 0.4;
  orbit.maxDistance = 60;

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* ---------- 场景树 (app.js:141, 184-257) ---------- */
  function isPartNode(n) {
    return !!(n.userData.kbType && n.userData.kbType.lastIndexOf('part:', 0) === 0);
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }

  // app.js 的 buildNode 去掉 group / 基础几何体分支:mini 的场景里只有零件
  function buildNode(data) {
    if (!data.type || data.type.lastIndexOf('part:', 0) !== 0) return null;
    var node;
    if (window.KBParts) {
      node = KBParts.instantiate(data.type.slice(5), data.tint || null);
    } else {
      node = new THREE.Group();
      node.userData.kbType = data.type;
      node.userData.kbPending = { tint: data.tint || null };
    }
    node.userData.kbId = data.id || newId();
    node.name = data.name;
    node.position.fromArray(data.p);
    node.rotation.set(data.r[0], data.r[1], data.r[2]);
    node.scale.fromArray(data.s);
    return node;
  }

  function disposeNode(node) {
    node.traverse(function (o) {
      if (o.isMesh) {
        if (!o.userData.kbShared) o.geometry.dispose();
        o.material.dispose();
      }
    });
  }

  function clearSceneObjects() {
    objectsRoot.children.slice().forEach(function (c) {
      disposeNode(c);
      objectsRoot.remove(c);
    });
  }

  function loadSceneData(data) {
    clearSceneObjects();
    (data.objects || []).forEach(function (d) {
      var n = buildNode(d);
      if (n) objectsRoot.add(n);
    });
  }

  /* ---------- 查询 / 高亮 (app.js:711-726) ---------- */
  function highlight(node, color) {
    if (!node) return;
    node.traverse(function (o) {
      if (!o.isMesh || !o.material || !o.material.emissive) return;
      if (color) { o.material.emissive.set(color); o.material.emissiveIntensity = 0.55; }
      else { o.material.emissive.set(0x000000); o.material.emissiveIntensity = 1; }
    });
  }

  function partById(id) {
    var found = null;
    objectsRoot.traverse(function (o) { if (!found && isPartNode(o) && o.userData.kbId === id) found = o; });
    return found;
  }

  /* ---------- 镜头补间 (app.js:1386-1410) ---------- */
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var focusAnim = null;
  var FLY = 0.9;

  function flyCamera(pos, target) {
    if (reducedMotion) {
      camera.position.fromArray(pos); orbit.target.fromArray(target); focusAnim = null; return;
    }
    focusAnim = {
      t: 0,
      fromT: orbit.target.clone(), toT: new THREE.Vector3().fromArray(target),
      fromP: camera.position.clone(), toP: new THREE.Vector3().fromArray(pos)
    };
  }

  var frameHooks = [];

  var clock = new THREE.Clock();
  (function animate() {
    requestAnimationFrame(animate);
    var dt = clock.getDelta();
    if (focusAnim) {
      focusAnim.t = Math.min(1, focusAnim.t + dt / FLY);
      var k = 1 - Math.pow(1 - focusAnim.t, 3);
      orbit.target.lerpVectors(focusAnim.fromT, focusAnim.toT, k);
      camera.position.lerpVectors(focusAnim.fromP, focusAnim.toP, k);
      if (focusAnim.t >= 1) focusAnim = null;
    }
    for (var i = 0; i < frameHooks.length; i++) frameHooks[i](dt);
    orbit.update();
    renderer.render(scene, camera);
  })();

  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /* ---------- 对外 ----------
   * parts.js / bridge.js 按名字用这些:名字与 app.js 一致, 这样从 bowei
   * 新版重新派生时不用改调用点。做不了的事(选中 / 快照 / 提示)留空实现。 */
  window.KB = {
    camera: camera,
    orbit: orbit,
    scene: scene,
    renderer: renderer,
    objectsRoot: objectsRoot,
    isPart: isPartNode,
    newId: newId,
    partById: partById,
    highlight: highlight,
    loadSceneData: loadSceneData,
    flyCamera: flyCamera,
    flying: function () { return !!focusAnim; },
    onFrame: function (fn) { frameHooks.push(fn); },
    // 丢掉上一帧以来攒下的时间。给 mini.js showStep 里同步跑的 frameStep() 用:
    // 它花的时间会被 clock.getDelta() 全部记到下一帧的 dt 上, 而一次飞行只有
    // DUR=1.1 s —— 一旦它比 1.1 s 还久, t 一步跨过 maxT, 零件直接出现在终点,
    // 一帧中间姿态都不画。遮挡判定换成包围盒代理之后 frameStep 只要 1-4 ms
    // (以前第 22-25 步 2.6-2.7 s / 第 42-45 步 1.4 s), 已经不会再跨完整段,
    // 但清一次 delta 仍然是对的:飞行该从"取景算完"起算, 不该白吃这几毫秒。
    resetDelta: function () { clock.getDelta(); },
    // 编辑器里的动作, mini 没有:留空壳, 免得 parts.js / bridge.js 崩
    setSelection: function () {},
    onSelection: function () {},
    pushSnapshot: function () {},
    resetHistory: function () {},
    toast: function () {},
    expert: function () { return false; },
    on: function () {},
    emit: function () {}
  };
})();
