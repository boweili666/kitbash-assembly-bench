/* ============================================================
 * 三维组装台 (Kitbash) — 三维交互组合物体的界面
 * 依赖:three r147 (UMD) + OrbitControls + TransformControls + GLTFExporter
 * ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'kitbash-scene-v1';
  var SPAWN_COLORS = ['#c8cfd6', '#c05b4d', '#4a81a5', '#5b9279', '#c99846', '#7a6fa0', '#4e8e8a'];
  var TYPE_LABELS = {
    box: 'Box', sphere: 'Sphere', cylinder: 'Cylinder', cone: 'Cone',
    torus: 'Torus', capsule: 'Capsule', slab: 'Slab', group: 'Group'
  };

  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 渲染器 / 场景 ---------- */
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

  var grid = new THREE.GridHelper(24, 24, 0x39424e, 0x252c35);
  grid.position.y = 0.001;
  scene.add(grid);
  var shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.ShadowMaterial({ opacity: 0.28 })
  );
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);

  /* 用户物体的根节点 —— 场景树 / 序列化 / 拾取都只看它 */
  var objectsRoot = new THREE.Group();
  objectsRoot.name = 'objectsRoot';
  scene.add(objectsRoot);

  /* ---------- 控制器 ---------- */
  var orbit = new THREE.OrbitControls(camera, canvas);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.target.set(0, 1.4, 0);
  orbit.maxPolarAngle = Math.PI * 0.495;
  orbit.minDistance = 1.2;
  orbit.maxDistance = 60;

  var gizmo = new THREE.TransformControls(camera, canvas);
  gizmo.setSize(0.9);
  scene.add(gizmo);
  gizmo.addEventListener('dragging-changed', function (e) {
    orbit.enabled = !e.value;
  });
  gizmo.addEventListener('objectChange', function () { syncInspectorFromSelection(); });
  gizmo.addEventListener('mouseUp', function () { pushSnapshot(); });

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* ---------- 状态 ---------- */
  var selection = [];          // 选中的节点(objectsRoot 树内的 Mesh 或 Group)
  var pivot = null;            // 多选时的临时变换枢轴
  var helpers = [];            // 选中包围盒
  var undoStack = [], redoStack = [];
  var nameCounter = 0;
  var focusAnim = null;

  /* ---------- 几何工厂 ---------- */
  function makeGeometry(type) {
    switch (type) {
      case 'box': return new THREE.BoxGeometry(1, 1, 1);
      case 'sphere': return new THREE.SphereGeometry(0.5, 32, 20);
      case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
      case 'cone': return new THREE.ConeGeometry(0.5, 1, 32);
      case 'torus': return new THREE.TorusGeometry(0.4, 0.15, 18, 40);
      case 'capsule': return new THREE.CapsuleGeometry(0.32, 0.55, 8, 20);
      case 'slab': return new THREE.BoxGeometry(1.5, 0.12, 1.5);
      default: return new THREE.BoxGeometry(1, 1, 1);
    }
  }

  function createMesh(type, color) {
    var mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color || SPAWN_COLORS[nameCounter % SPAWN_COLORS.length]),
      metalness: 0.08,
      roughness: 0.6
    });
    var mesh = new THREE.Mesh(makeGeometry(type), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.kbType = type;
    nameCounter += 1;
    mesh.name = TYPE_LABELS[type] + ' ' + nameCounter;
    return mesh;
  }

  function isPartNode(n) {
    return !!(n.userData.kbType && n.userData.kbType.lastIndexOf('part:', 0) === 0);
  }

  /* ---------- 序列化 / 反序列化 ---------- */
  function serializeNode(node) {
    var out = {
      name: node.name,
      type: node.userData.kbType || 'group',
      p: node.position.toArray(),
      r: [node.rotation.x, node.rotation.y, node.rotation.z],
      s: node.scale.toArray()
    };
    if (isPartNode(node)) {
      var tint = window.KBParts ? KBParts.getTint(node)
        : (node.userData.kbPending ? node.userData.kbPending.tint : null);
      if (tint) out.tint = tint;
      return out;
    }
    if (node.isMesh) {
      out.m = {
        c: '#' + node.material.color.getHexString(),
        me: node.material.metalness,
        ro: node.material.roughness,
        op: node.material.opacity
      };
    } else {
      out.children = node.children.map(serializeNode);
    }
    return out;
  }

  function serializeScene() {
    bakePivot();
    return {
      v: 1,
      counter: nameCounter,
      camera: { p: camera.position.toArray(), t: orbit.target.toArray() },
      objects: objectsRoot.children.map(serializeNode)
    };
  }

  function buildNode(data) {
    var node;
    // 基础几何体已从产品中移除:读旧存档时静默丢弃
    if (data.type && data.type !== 'group' && data.type.lastIndexOf('part:', 0) !== 0) {
      return null;
    }
    if (data.type && data.type.lastIndexOf('part:', 0) === 0) {
      if (window.KBParts) {
        node = KBParts.instantiate(data.type.slice(5), data.tint || null);
      } else { // 零件模块尚未加载:占位,稍后由 KBParts.resolve 补全
        node = new THREE.Group();
        node.userData.kbType = data.type;
        node.userData.kbPending = { tint: data.tint || null };
      }
    } else if (data.type === 'group') {
      node = new THREE.Group();
      (data.children || []).forEach(function (c) {
        var child = buildNode(c);
        if (child) node.add(child);
      });
      if (!node.children.length) return null; // 组员全被过滤则组也不保留
    } else {
      var mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(data.m.c),
        metalness: data.m.me,
        roughness: data.m.ro,
        opacity: data.m.op !== undefined ? data.m.op : 1,
        transparent: (data.m.op !== undefined && data.m.op < 1)
      });
      node = new THREE.Mesh(makeGeometry(data.type), mat);
      node.castShadow = true;
      node.receiveShadow = true;
      node.userData.kbType = data.type;
    }
    node.name = data.name;
    node.position.fromArray(data.p);
    node.rotation.set(data.r[0], data.r[1], data.r[2]);
    node.scale.fromArray(data.s);
    return node;
  }

  function disposeNode(node) {
    node.traverse(function (o) {
      if (o.isMesh) {
        if (!o.userData.kbShared) o.geometry.dispose(); // 零件几何体跨实例共享
        o.material.dispose();
      }
    });
  }

  function clearSceneObjects() {
    setSelection([]);
    objectsRoot.children.slice().forEach(function (c) {
      disposeNode(c);
      objectsRoot.remove(c);
    });
  }

  function loadSceneData(data, keepCamera) {
    clearSceneObjects();
    (data.objects || []).forEach(function (d) {
      var n = buildNode(d);
      if (n) objectsRoot.add(n);
    });
    nameCounter = Math.max(nameCounter, data.counter || 0);
    if (!keepCamera && data.camera) {
      camera.position.fromArray(data.camera.p);
      orbit.target.fromArray(data.camera.t);
    }
    refreshTree();
  }

  /* ---------- 撤销 / 重做 ---------- */
  function pushSnapshot() {
    var json = JSON.stringify(serializeScene()); // serialize 会临时收回多选枢轴
    if (undoStack.length && undoStack[undoStack.length - 1] !== json) {
      undoStack.push(json);
      if (undoStack.length > 60) undoStack.shift();
      redoStack.length = 0;
      autosave(json);
    }
    updateToolStates();
    refreshTree();
    syncInspectorFromSelection();
    rebuildAttachment(); // 恢复多选枢轴 / gizmo
  }

  function undo() {
    if (undoStack.length < 2) return;
    redoStack.push(undoStack.pop());
    var json = undoStack[undoStack.length - 1];
    loadSceneData(JSON.parse(json), true);
    autosave(json);
    updateToolStates();
    toast('Undone');
  }

  function redo() {
    if (!redoStack.length) return;
    var json = redoStack.pop();
    undoStack.push(json);
    loadSceneData(JSON.parse(json), true);
    autosave(json);
    updateToolStates();
    toast('Redone');
  }

  function autosave(json) {
    try { localStorage.setItem(STORAGE_KEY, json); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 选择 ---------- */
  var featureSpacePrev = null; // 特征枢轴激活期间临时强制局部空间,收回时还原

  function bakePivot() {
    if (!pivot) return;
    gizmo.detach();
    if (featureSpacePrev !== null) {
      if (gizmo.space === 'local') gizmo.setSpace(featureSpacePrev); // 用户没手动切过才还原
      featureSpacePrev = null;
      syncSpaceLabel();
    }
    pivot.children.slice().forEach(function (child) {
      var parent = child.userData._prevParent || objectsRoot;
      delete child.userData._prevParent;
      parent.attach(child);   // attach 保持世界变换
    });
    scene.remove(pivot);
    pivot = null;
  }

  function rebuildAttachment() {
    bakePivot();
    gizmo.detach();
    if (selection.length === 1) {
      var n0 = selection[0];
      // 零件吸在孔上时,把变换枢轴放到孔位:gizmo 显示在洞上,旋转即绕洞转。
      // 拖拽/手势抓取进行中不建枢轴(它们直接操纵节点本身)
      var busy = window.KBSnap && KBSnap.isMouseDragging && KBSnap.isMouseDragging();
      // 仅在按住 Ctrl(吸附模式)且与其他零件孔轴同轴时,枢轴才跳到孔位
      // 并沿孔轴取向(局部空间:Y箭头=插拔,Y环=绕孔转);平时留在零件原点
      var spec = null;
      if (!busy && window.KBSnap && KBSnap.snapKeyActive && KBSnap.snapKeyActive()) {
        spec = KBSnap.hingeFor(n0);
      }
      if (spec) {
        pivot = new THREE.Group();
        pivot.position.copy(spec.point);
        pivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), spec.dir);
        scene.add(pivot);
        pivot.updateMatrixWorld(true);
        n0.userData._prevParent = n0.parent;
        pivot.attach(n0);
        gizmo.attach(pivot);
        if (featureSpacePrev === null) featureSpacePrev = gizmo.space;
        gizmo.setSpace('local');
        syncSpaceLabel();
      } else {
        gizmo.attach(n0);
      }
    } else if (selection.length > 1) {
      var center = new THREE.Vector3();
      var box = new THREE.Box3();
      selection.forEach(function (n) { box.expandByObject(n); });
      box.getCenter(center);
      pivot = new THREE.Group();
      pivot.position.copy(center);
      scene.add(pivot);
      selection.forEach(function (n) {
        n.userData._prevParent = n.parent;
        pivot.attach(n);
      });
      gizmo.attach(pivot);
    }
    refreshHelpers();
  }

  function refreshHelpers() {
    helpers.forEach(function (h) {
      scene.remove(h);
      h.geometry.dispose();
      h.material.dispose();
    });
    helpers = selection.map(function (n) {
      var h = new THREE.BoxHelper(n, 0xe8a33d);
      h.material.transparent = true;
      h.material.opacity = 0.9;
      h.material.depthTest = false;
      scene.add(h);
      return h;
    });
  }

  var selectionHooks = [];
  function setSelection(nodes) {
    bakePivot();
    selection = nodes.slice();
    rebuildAttachment();
    refreshTree();
    syncInspectorFromSelection();
    updateToolStates();
    selectionHooks.forEach(function (fn) { fn(selection); });
  }

  function toggleSelect(node) {
    var i = selection.indexOf(node);
    var next = selection.slice();
    if (i >= 0) next.splice(i, 1); else next.push(node);
    setSelection(next);
  }

  /* 视口拾取:向上追溯到 objectsRoot 的直接子节点(组合作为整体被选中) */
  var raycaster = new THREE.Raycaster();
  var pointer = new THREE.Vector2();
  var downPos = null, downOnGizmo = false;

  canvas.addEventListener('pointerdown', function (e) {
    downPos = [e.clientX, e.clientY];
    downOnGizmo = gizmo.dragging || !!gizmo.axis;
  });

  canvas.addEventListener('pointerup', function (e) {
    if (!downPos || downOnGizmo) { downPos = null; return; }
    var dx = e.clientX - downPos[0], dy = e.clientY - downPos[1];
    downPos = null;
    if (Math.hypot(dx, dy) > 5 || e.button !== 0) {
      rebuildAttachment(); // 视角拖动等操作会临时收回枢轴,这里恢复 gizmo
      return;
    }

    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    bakePivot(); // 保证物体都在 objectsRoot 树内
    var hits = raycaster.intersectObjects(objectsRoot.children, true);
    if (!hits.length) { setSelection([]); return; }
    var node = hits[0].object;
    while (node.parent && node.parent !== objectsRoot) node = node.parent;
    if (e.shiftKey) toggleSelect(node);
    else setSelection([node]);
  });

  canvas.addEventListener('dblclick', function () {
    if (selection.length) focusOn(selection);
  });

  /* ---------- 相机聚焦 ---------- */
  function focusOn(nodes) {
    bakePivot();
    var box = new THREE.Box3();
    var list = nodes && nodes.length ? nodes : objectsRoot.children;
    if (!list.length) return;
    list.forEach(function (n) { box.expandByObject(n); });
    var center = box.getCenter(new THREE.Vector3());
    var radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.6);
    var dir = camera.position.clone().sub(orbit.target).normalize();
    var dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15;
    var endPos = center.clone().add(dir.multiplyScalar(dist));
    if (reducedMotion) {
      orbit.target.copy(center);
      camera.position.copy(endPos);
    } else {
      focusAnim = {
        t: 0,
        fromT: orbit.target.clone(), toT: center,
        fromP: camera.position.clone(), toP: endPos
      };
    }
    rebuildAttachment();
  }

  /* ---------- 编辑操作 ---------- */
  function addPart(type) {
    var mesh = createMesh(type);
    var geoH = { box: 0.5, sphere: 0.5, cylinder: 0.5, cone: 0.5, torus: 0.15, capsule: 0.6, slab: 0.06 };
    var spread = objectsRoot.children.length * 0.4;
    mesh.position.set(
      Math.cos(spread) * 1.2 * (objectsRoot.children.length % 3),
      geoH[type] || 0.5,
      Math.sin(spread) * 1.2
    );
    if (snapOn) {
      mesh.position.x = Math.round(mesh.position.x * 4) / 4;
      mesh.position.z = Math.round(mesh.position.z * 4) / 4;
    }
    objectsRoot.add(mesh);
    setSelection([mesh]);
    pushSnapshot();
    toast('Added ' + TYPE_LABELS[type]);
  }

  function deleteSelection() {
    if (!selection.length) return;
    bakePivot();
    var n = selection.length;
    selection.forEach(function (node) {
      var parent = node.parent;
      disposeNode(node);
      if (parent) parent.remove(node);
      // 空组合顺带清掉
      while (parent && parent !== objectsRoot && parent.children.length === 0) {
        var gp = parent.parent;
        gp.remove(parent);
        parent = gp;
      }
    });
    setSelection([]);
    pushSnapshot();
    toast('Deleted ' + n + ' object' + (n > 1 ? 's' : ''));
  }

  function duplicateSelection() {
    if (!selection.length) return;
    bakePivot();
    var clones = selection.map(function (node) {
      var data = serializeNode(node);
      renameForCopy(data);
      var clone = buildNode(data);
      clone.position.x += 0.75;
      clone.position.z += 0.75;
      (node.parent || objectsRoot).add(clone);
      return clone;
    });
    setSelection(clones);
    pushSnapshot();
    toast('Duplicated ' + clones.length + ' object' + (clones.length > 1 ? 's' : ''));
  }

  function renameForCopy(data) {
    data.name = data.name.replace(/ copy( \d+)?$/, '') + ' copy';
    (data.children || []).forEach(renameForCopy);
  }

  function groupSelection() {
    if (selection.length < 2) { toast('Shift+click to select at least 2 objects first'); return; }
    bakePivot();
    var group = new THREE.Group();
    nameCounter += 1;
    group.name = 'Group ' + nameCounter;
    // 枢轴放在包围盒中心底部,便于后续整体摆放
    var box = new THREE.Box3();
    selection.forEach(function (n) { box.expandByObject(n); });
    var center = box.getCenter(new THREE.Vector3());
    group.position.set(center.x, box.min.y, center.z);
    objectsRoot.add(group);
    selection.forEach(function (n) { group.attach(n); });
    setSelection([group]);
    pushSnapshot();
    toast('Grouped as \u201c' + group.name + '\u201d');
  }

  function ungroupSelection() {
    var groups = selection.filter(function (n) { return !n.isMesh && !isPartNode(n); });
    if (!groups.length) { toast('No group in the selection'); return; }
    bakePivot();
    var released = [];
    groups.forEach(function (g) {
      var parent = g.parent || objectsRoot;
      g.children.slice().forEach(function (c) {
        parent.attach(c);
        released.push(c);
      });
      parent.remove(g);
    });
    setSelection(released);
    pushSnapshot();
    toast('Ungrouped');
  }

  /* ---------- 吸附 / 变换模式 ---------- */
  var snapOn = false;
  function setSnap(on) {
    snapOn = on;
    gizmo.setTranslationSnap(on ? 0.25 : null);
    gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
    gizmo.setScaleSnap(on ? 0.1 : null);
    document.getElementById('btnSnap').classList.toggle('on', on);
  }

  function setMode(mode) {
    gizmo.setMode(mode);
    ['translate', 'rotate', 'scale'].forEach(function (m) {
      document.getElementById('mode-' + m).classList.toggle('on', m === mode);
    });
  }

  function syncSpaceLabel() {
    document.getElementById('btnSpace').querySelector('.lbl').textContent =
      gizmo.space === 'world' ? 'World' : 'Local';
  }

  function toggleSpace() {
    gizmo.setSpace(gizmo.space === 'world' ? 'local' : 'world');
    featureSpacePrev = null; // 用户手动选择后不再自动还原
    syncSpaceLabel();
  }

  /* ---------- 导入 / 导出 ----------
   * 本地打开:通过 <a download> 直接下载。
   * 作为 claude.ai Artifact 打开:页面自身的下载会被沙盒拦截,
   * 改用 downloads 能力(viewer 会看到保存确认框)。 */
  function getDownloadsNS() {
    if (window.claude && typeof window.claude.use === 'function') {
      return window.claude.use('downloads'); // Promise<namespace | null>
    }
    return Promise.resolve(null);
  }

  function anchorDownload(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function saveFile(data, filename, doneMsg) {
    getDownloadsNS().then(function (dl) {
      if (!dl) {
        anchorDownload(new Blob([data]), filename);
        toast(doneMsg);
        return;
      }
      dl.save({ filename: filename, data: data }).then(function () {
        toast(doneMsg);
      }).catch(function (err) {
        if (err && err.code === 'declined') toast('Save canceled');
        else toast('Save failed: ' + (err && err.code ? err.code : 'unknown error'));
      });
    });
  }

  function exportJSON() {
    var json = JSON.stringify(serializeScene(), null, 2);
    rebuildAttachment();
    saveFile(json, 'kitbash-scene.json', 'Scene JSON exported');
    openModal('Scene JSON (saved as a file; you can also copy it here)', json);
  }

  function exportGLB() {
    bakePivot();
    if (!objectsRoot.children.length) { toast('The scene is empty'); return; }
    var exporter = new THREE.GLTFExporter();
    getDownloadsNS().then(function (dl) {
      if (dl) {
        // Artifact 沙盒的文件类型白名单不含 .glb,
        // 改导出内嵌缓冲区的 glTF-JSON(改回 .gltf 扩展名即可用)
        exporter.parse(objectsRoot, function (result) {
          rebuildAttachment();
          saveFile(JSON.stringify(result), 'kitbash-scene.gltf.json',
            'glTF exported \u2014 rename to .gltf to import into Blender');
        }, function () {
          rebuildAttachment();
          toast('glTF export failed');
        }, { binary: false, embedImages: true });
      } else {
        exporter.parse(objectsRoot, function (result) {
          rebuildAttachment(); // 导出遍历结束后再恢复多选枢轴
          anchorDownload(new Blob([result], { type: 'model/gltf-binary' }), 'kitbash-scene.glb');
          toast('GLB exported');
        }, function () {
          rebuildAttachment();
          toast('GLB export failed');
        }, { binary: true });
      }
    });
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        loadSceneData(data, false);
        pushSnapshot();
        toast('Scene loaded');
      } catch (err) {
        toast('Failed to parse the file: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  /* ---------- 示例场景:Frame Bottom Assembly 全套零件清单 ----------
   * 数量来自 aristos 的装配任务图 task_graph_frame_bottom.json(共 24 件):
   * 机臂×4 螺柱×4 M3×22×4 M3×16盘头×4 楔块×2 M3×16杯头×2 前板/后板/X锁块/M3×6 各×1 */
  var KIT_SCENE = (function () {
    var objects = [];
    function put(key, name, x, z, ry) {
      objects.push({ name: name, type: 'part:' + key, p: [x, 0, z], r: [0, ry || 0, 0], s: [1, 1, 1] });
    }
    for (var i = 0; i < 4; i++) put('arm_5in', 'Arm ' + (i + 1), -3.5 + i * 0.85, 0.8);
    put('split_front_plate', 'Front Plate', 0.6, -1.9);
    put('split_rear_plate', 'Rear Plate', 2.2, -1.9);
    put('aluminum_x_lock', 'X-Lock', 0.6, 0.4);
    put('aluminum_arm_wedge_5mm', 'Arm Wedge L', 1.6, 0.15);
    put('aluminum_arm_wedge_5mm', 'Arm Wedge R', 1.6, 0.65);
    for (i = 0; i < 4; i++) put('knurled_standoff', 'Standoff ' + (i + 1), 0.3 + i * 0.3, 1.5);
    for (i = 0; i < 4; i++) put('screw_m3x22_pan', 'M3\u00d722 ' + (i + 1), 1.7 + i * 0.3, 1.5);
    for (i = 0; i < 4; i++) put('screw_m3x16_pan', 'M3\u00d716 ' + (i + 1), 0.3 + i * 0.3, 2.3);
    put('screw_m3x16_socket_cap', 'M3\u00d716 Cap L', 1.8, 2.3);
    put('screw_m3x16_socket_cap', 'M3\u00d716 Cap R', 2.1, 2.3);
    put('screw_m3x6_pan', 'M3\u00d76', 2.6, 2.3);
    return {
      v: 1,
      counter: 40,
      camera: { p: [6.5, 5.5, 7.5], t: [-0.2, 0.3, -0.2] },
      objects: objects
    };
  })();

  function buildDemoScene() {
    loadSceneData(KIT_SCENE, false);
    if (window.KBParts && KBParts.ready()) {
      objectsRoot.children.slice().forEach(function (n) {
        if (n.userData.kbPending) KBParts.resolve(n);
      });
    }
    setSelection([]);
    refreshTree();
  }

  /* ---------- 场景树 ---------- */
  var treeEl = document.getElementById('tree');
  var countEl = document.getElementById('objCount');

  /* 多选枢轴激活时,被选对象临时挂在 pivot 下;
     场景树按其原父节点展示,保证树不随选择状态跳动 */
  function childrenOf(parent) {
    var list = parent.children.slice();
    if (pivot) {
      pivot.children.forEach(function (c) {
        if ((c.userData._prevParent || objectsRoot) === parent) list.push(c);
      });
    }
    return list;
  }

  function refreshTree() {
    if (!treeEl) return; // 场景树面板已从界面移除
    treeEl.innerHTML = '';
    var total = 0;
    (function walk(parent, depth) {
      childrenOf(parent).forEach(function (node) {
        total += 1;
        var row = document.createElement('button');
        row.className = 'node' + (selection.indexOf(node) >= 0 ? ' sel' : '');
        row.style.paddingLeft = (8 + depth * 14) + 'px';
        row.innerHTML = iconFor(isPartNode(node) ? 'part' : (node.userData.kbType || 'group')) +
          '<span class="nm"></span>';
        row.querySelector('.nm').textContent = node.name;
        row.addEventListener('click', function (e) {
          if (e.shiftKey) toggleSelect(node);
          else setSelection([node]);
        });
        treeEl.appendChild(row);
        if (!node.isMesh && !isPartNode(node)) walk(node, depth + 1); // 零件是原子节点
      });
    })(objectsRoot, 0);
    if (!total) {
      treeEl.innerHTML = '<div class="tree-empty">Scene is empty</div>';
    }
    countEl.textContent = total;
  }

  /* ---------- 属性检查器 ---------- */
  var inspEmpty = document.getElementById('inspEmpty');
  var inspBody = document.getElementById('inspBody');
  var inspMulti = document.getElementById('inspMulti');
  var inspTransform = document.getElementById('inspTransform');
  var nameInput = document.getElementById('propName');
  var colorInput = document.getElementById('propColor');
  var colorCode = document.getElementById('propColorCode');
  var metalInput = document.getElementById('propMetal');
  var roughInput = document.getElementById('propRough');
  var opacityInput = document.getElementById('propOpacity');
  var vecInputs = {};
  ['p', 'r', 's'].forEach(function (k) {
    ['x', 'y', 'z'].forEach(function (ax) {
      vecInputs[k + ax] = document.getElementById('prop-' + k + ax);
    });
  });

  function firstMeshIn(node) {
    var found = null;
    node.traverse(function (o) { if (!found && o.isMesh) found = o; });
    return found;
  }

  var syncingInspector = false;
  function syncInspectorFromSelection() {
    syncingInspector = true;
    var n = selection.length;
    inspEmpty.style.display = n ? 'none' : 'block';
    inspBody.classList.toggle('show', n > 0);
    if (n) {
      var single = n === 1 ? selection[0] : null;
      inspMulti.style.display = single ? 'none' : 'block';
      inspMulti.textContent = n + ' objects selected \u2014 material edits apply to all';
      inspTransform.style.display = single ? 'block' : 'none';
      nameInput.parentElement.style.display = single ? 'block' : 'none';
      if (single) {
        nameInput.value = single.name;
        var dp = single.position, dr = single.rotation, ds = single.scale;
        if (pivot && single.parent === pivot) {
          // 挂在铰链枢轴下:面板显示世界变换
          var wp = new THREE.Vector3(), wq = new THREE.Quaternion(), wsv = new THREE.Vector3();
          single.updateWorldMatrix(true, false);
          single.matrixWorld.decompose(wp, wq, wsv);
          dp = wp; ds = wsv;
          dr = new THREE.Euler().setFromQuaternion(wq);
        }
        vecInputs.px.value = dp.x.toFixed(2);
        vecInputs.py.value = dp.y.toFixed(2);
        vecInputs.pz.value = dp.z.toFixed(2);
        vecInputs.rx.value = THREE.MathUtils.radToDeg(dr.x).toFixed(1);
        vecInputs.ry.value = THREE.MathUtils.radToDeg(dr.y).toFixed(1);
        vecInputs.rz.value = THREE.MathUtils.radToDeg(dr.z).toFixed(1);
        vecInputs.sx.value = ds.x.toFixed(2);
        vecInputs.sy.value = ds.y.toFixed(2);
        vecInputs.sz.value = ds.z.toFixed(2);
      }
      var mesh = firstMeshIn(selection[0]);
      if (mesh) {
        var hex = '#' + mesh.material.color.getHexString();
        colorInput.value = hex;
        colorCode.textContent = hex;
        metalInput.value = mesh.material.metalness;
        roughInput.value = mesh.material.roughness;
        opacityInput.value = mesh.material.opacity;
        metalInput.nextElementSibling.value = Number(mesh.material.metalness).toFixed(2);
        roughInput.nextElementSibling.value = Number(mesh.material.roughness).toFixed(2);
        opacityInput.nextElementSibling.value = Number(mesh.material.opacity).toFixed(2);
      }
    }
    syncingInspector = false;
  }

  function applyTransformFromInputs() {
    if (syncingInspector || selection.length !== 1) return;
    // 铰链枢轴下先收回,数值编辑始终按原父空间语义
    if (pivot && selection[0].parent === pivot) bakePivot();
    var node = selection[0];
    node.position.set(+vecInputs.px.value || 0, +vecInputs.py.value || 0, +vecInputs.pz.value || 0);
    node.rotation.set(
      THREE.MathUtils.degToRad(+vecInputs.rx.value || 0),
      THREE.MathUtils.degToRad(+vecInputs.ry.value || 0),
      THREE.MathUtils.degToRad(+vecInputs.rz.value || 0)
    );
    node.scale.set(+vecInputs.sx.value || 1, +vecInputs.sy.value || 1, +vecInputs.sz.value || 1);
  }

  function applyMaterial(fn) {
    if (syncingInspector) return;
    selection.forEach(function (node) {
      node.traverse(function (o) { if (o.isMesh) fn(o.material); });
    });
  }

  Object.keys(vecInputs).forEach(function (k) {
    vecInputs[k].addEventListener('input', applyTransformFromInputs);
    vecInputs[k].addEventListener('change', function () { pushSnapshot(); });
  });
  nameInput.addEventListener('change', function () {
    if (selection.length === 1) {
      selection[0].name = nameInput.value || selection[0].name;
      pushSnapshot();
    }
  });
  colorInput.addEventListener('input', function () {
    colorCode.textContent = colorInput.value;
    applyMaterial(function (m) { m.color.set(colorInput.value); });
  });
  colorInput.addEventListener('change', function () { pushSnapshot(); });
  [[metalInput, 'metalness'], [roughInput, 'roughness']].forEach(function (pair) {
    pair[0].addEventListener('input', function () {
      pair[0].nextElementSibling.value = Number(pair[0].value).toFixed(2);
      applyMaterial(function (m) { m[pair[1]] = +pair[0].value; });
    });
    pair[0].addEventListener('change', function () { pushSnapshot(); });
  });
  opacityInput.addEventListener('input', function () {
    opacityInput.nextElementSibling.value = Number(opacityInput.value).toFixed(2);
    applyMaterial(function (m) {
      m.opacity = +opacityInput.value;
      m.transparent = m.opacity < 1;
    });
  });
  opacityInput.addEventListener('change', function () { pushSnapshot(); });
  document.getElementById('btnResetXform').addEventListener('click', function () {
    if (!selection.length) return;
    bakePivot();
    selection.forEach(function (node) {
      node.rotation.set(0, 0, 0);
      node.scale.set(1, 1, 1);
      if (node.parent === objectsRoot) { // 顶层对象:落回地面
        node.updateMatrixWorld(true);
        var box = new THREE.Box3().setFromObject(node);
        if (isFinite(box.min.y)) node.position.y -= box.min.y;
      }
    });
    syncInspectorFromSelection();
    pushSnapshot();
    toast('Transform reset (rotation 0 \u00b7 scale 1 \u00b7 grounded)');
  });

  document.getElementById('btnResetMat').addEventListener('click', function () {
    if (!selection.length) return;
    selection.forEach(function walk(n) {
      if (isPartNode(n)) {
        if (window.KBParts) KBParts.resetMaterial(n);
        return;
      }
      if (n.isMesh) {
        n.material.metalness = 0.08;
        n.material.roughness = 0.6;
        n.material.opacity = 1;
        n.material.transparent = false;
      }
      n.children.forEach(walk);
    });
    syncInspectorFromSelection();
    pushSnapshot();
    toast('Material reset to default');
  });

  /* ---------- 工具栏状态 ---------- */
  function updateToolStates() {
    document.getElementById('btnUndo').disabled = undoStack.length < 2;
    document.getElementById('btnRedo').disabled = !redoStack.length;
    document.getElementById('btnGroup').disabled = selection.length < 2;
    document.getElementById('btnUngroup').disabled =
      !selection.some(function (n) { return !n.isMesh; });
    document.getElementById('btnDup').disabled = !selection.length;
    document.getElementById('btnDel').disabled = !selection.length;
  }

  /* ---------- 提示 / 模态 ---------- */
  var toastEl = document.getElementById('toast');
  var toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  var modalEl = document.getElementById('modal');
  function openModal(title, text) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalText').value = text;
    modalEl.classList.add('show');
  }
  document.getElementById('modalClose').addEventListener('click', function () {
    modalEl.classList.remove('show');
  });
  document.getElementById('modalCopy').addEventListener('click', function () {
    var ta = document.getElementById('modalText');
    ta.select();
    try {
      navigator.clipboard.writeText(ta.value).then(function () { toast('Copied to clipboard'); });
    } catch (e) {
      document.execCommand('copy');
      toast('Copied to clipboard');
    }
  });
  modalEl.addEventListener('click', function (e) {
    if (e.target === modalEl) modalEl.classList.remove('show');
  });

  /* ---------- 图标 ---------- */
  function iconFor(type) {
    var s = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">';
    var d = {
      box: '<path d="M4 7l6-3 6 3v6l-6 3-6-3z"/><path d="M4 7l6 3 6-3M10 10v6"/>',
      sphere: '<circle cx="10" cy="10" r="6.5"/><ellipse cx="10" cy="10" rx="6.5" ry="2.4"/>',
      cylinder: '<ellipse cx="10" cy="5.5" rx="5" ry="2"/><path d="M5 5.5v9M15 5.5v9"/><path d="M5 14.5a5 2 0 0 0 10 0"/>',
      cone: '<path d="M10 3.5L4.6 14.5M10 3.5l5.4 11"/><ellipse cx="10" cy="14.5" rx="5.4" ry="2"/>',
      torus: '<ellipse cx="10" cy="10" rx="6.5" ry="4.5"/><ellipse cx="10" cy="10" rx="2.6" ry="1.6"/>',
      capsule: '<rect x="6.5" y="3.5" width="7" height="13" rx="3.5"/>',
      part: '<path d="M6.5 3h7M6.5 5.5h7M10 3v2.5"/><path d="M8.6 5.5h2.8l-.5 9.2-.9 1.8-.9-1.8z"/>',
      slab: '<path d="M3 11l7-3.5 7 3.5-7 3.5z"/><path d="M3 11v2l7 3.5 7-3.5v-2"/>',
      group: '<rect x="3.5" y="3.5" width="8" height="8" rx="1.5"/><rect x="8.5" y="8.5" width="8" height="8" rx="1.5"/>'
    };
    return s + (d[type] || d.box) + '</svg>';
  }
  // 把场景树里用的小图标注入部件按钮
  document.querySelectorAll('[data-icon]').forEach(function (el) {
    el.insertAdjacentHTML('afterbegin', iconFor(el.getAttribute('data-icon'))
      .replace('width="14" height="14"', 'width="20" height="20"'));
  });

  /* ---------- 事件绑定 ---------- */
  document.querySelectorAll('.part').forEach(function (btn) {
    btn.addEventListener('click', function () { addPart(btn.getAttribute('data-type')); });
  });
  document.getElementById('mode-translate').addEventListener('click', function () { setMode('translate'); });
  document.getElementById('mode-rotate').addEventListener('click', function () { setMode('rotate'); });
  document.getElementById('mode-scale').addEventListener('click', function () { setMode('scale'); });
  document.getElementById('btnSpace').addEventListener('click', toggleSpace);
  document.getElementById('btnSnap').addEventListener('click', function () { setSnap(!snapOn); });
  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('btnRedo').addEventListener('click', redo);
  document.getElementById('btnGroup').addEventListener('click', groupSelection);
  document.getElementById('btnUngroup').addEventListener('click', ungroupSelection);
  document.getElementById('btnDup').addEventListener('click', duplicateSelection);
  document.getElementById('btnDel').addEventListener('click', deleteSelection);
  document.getElementById('btnFocus').addEventListener('click', function () { focusOn(selection); });
  document.getElementById('btnNew').addEventListener('click', function () {
    if (confirm('Clear the scene? This can be undone.')) {
      clearSceneObjects();
      pushSnapshot();
      toast('New empty scene');
    }
  });
  document.getElementById('btnDemo').addEventListener('click', function () {
    if (confirm('Load the Frame Bottom Assembly kit? The current scene will be replaced (undoable).')) {
      buildDemoScene();
      pushSnapshot();
      toast('Frame Bottom Assembly kit loaded (24 parts)');
    }
  });
  document.getElementById('btnExportJson').addEventListener('click', exportJSON);
  document.getElementById('btnExportGlb').addEventListener('click', exportGLB);
  var importFile = document.getElementById('importFile');
  document.getElementById('btnImport').addEventListener('click', function () { importFile.click(); });
  importFile.addEventListener('change', function () {
    if (importFile.files[0]) importJSON(importFile.files[0]);
    importFile.value = '';
  });

  /* ---------- 快捷键 ---------- */
  window.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    var ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (ctrl && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (ctrl && e.code === 'KeyD') { e.preventDefault(); duplicateSelection(); return; }
    if (ctrl && e.code === 'KeyG' && e.shiftKey) { e.preventDefault(); ungroupSelection(); return; }
    if (ctrl && e.code === 'KeyG') { e.preventDefault(); groupSelection(); return; }
    if (ctrl) return;
    switch (e.code) {
      case 'KeyW': setMode('translate'); break;
      case 'KeyE': setMode('rotate'); break;
      case 'KeyR': setMode('scale'); break;
      case 'KeyQ': toggleSpace(); break;
      case 'KeyV': setSnap(!snapOn); break;
      case 'KeyF': focusOn(selection); break;
      case 'Escape':
        if (modalEl.classList.contains('show')) modalEl.classList.remove('show');
        else setSelection([]);
        break;
      case 'Delete':
      case 'Backspace': e.preventDefault(); deleteSelection(); break;
    }
  });

  /* ---------- 渲染循环 ---------- */
  window.addEventListener('resize', function () {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  var clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    var dt = clock.getDelta();
    if (focusAnim) {
      focusAnim.t = Math.min(1, focusAnim.t + dt / 0.32);
      var k = 1 - Math.pow(1 - focusAnim.t, 3);
      orbit.target.lerpVectors(focusAnim.fromT, focusAnim.toT, k);
      camera.position.lerpVectors(focusAnim.fromP, focusAnim.toP, k);
      if (focusAnim.t >= 1) focusAnim = null;
    }
    orbit.update();
    helpers.forEach(function (h) { h.update(); });
    renderer.render(scene, camera);
  }

  /* ---------- 供手势模块 (src/gesture.js) 使用的内部 API ---------- */
  window.KB = {
    camera: camera,
    orbit: orbit,
    scene: scene,
    gizmo: gizmo,
    objectsRoot: objectsRoot,
    setSelection: setSelection,
    pushSnapshot: pushSnapshot,
    saveFile: saveFile,
    syncInspector: syncInspectorFromSelection,
    toast: toast,
    isSnap: function () { return snapOn; },
    isPart: isPartNode,
    rebuildAttachment: rebuildAttachment,
    onSelection: function (fn) { selectionHooks.push(fn); },
    nextName: function (base) { nameCounter += 1; return base + ' ' + nameCounter; },
    /* 从屏幕坐标拾取顶层节点,返回 {node, point} 或 null */
    raycastTopAt: function (px, py) {
      bakePivot();
      pointer.x = (px / window.innerWidth) * 2 - 1;
      pointer.y = -(py / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      var hits = raycaster.intersectObjects(objectsRoot.children, true);
      if (!hits.length) return null;
      var node = hits[0].object;
      while (node.parent && node.parent !== objectsRoot) node = node.parent;
      return { node: node, point: hits[0].point.clone() };
    },
    /* 沿视线方向把屏幕坐标 + 距离转换成世界坐标 */
    unprojectAt: function (px, py, dist) {
      pointer.x = (px / window.innerWidth) * 2 - 1;
      pointer.y = -(py / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      return raycaster.ray.origin.clone()
        .add(raycaster.ray.direction.clone().multiplyScalar(dist));
    }
  };

  /* ---------- 启动 ---------- */
  var restored = false;
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      var data = JSON.parse(saved);
      if (data && data.objects && data.objects.length) {
        loadSceneData(data, false);
        restored = true;
      }
    }
  } catch (e) { /* 忽略,回落到示例场景 */ }
  if (!restored) buildDemoScene();
  undoStack.push(JSON.stringify(serializeScene()));
  setMode('translate');
  setSnap(false);
  updateToolStates();
  syncInspectorFromSelection();
  refreshTree();
  animate();
  if (restored) toast('Restored your last scene \u2014 click \u201cKit\u201d for the demo kit');
})();
