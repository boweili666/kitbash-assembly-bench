/* ============================================================
 * 零件库 — 加载 aristos 无人机机架零件 (GLB),接入部件架与吸附
 *
 * 数据来源 assets/parts/manifest.json(tools/label_holes.py 生成):
 * 每个零件带孔位(H1..Hn)与销轴(P1..Pn)标签:圆心/轴向/半径/深度,
 * 坐标已归一到编辑器单位。孔与销作为轴特征参与装配吸附(螺丝插孔)。
 * 选中零件时在孔位画琥珀色圆环 + 标签,销轴画蓝色圆环。
 *
 * 单文件构建时 window.KB_PARTS_DATA 内嵌 manifest 与 GLB(base64);
 * 开发模式从 assets/parts/ 拉取。
 * ============================================================ */
(function () {
  'use strict';

  var KB = window.KB;
  var cache = {};        // key → {prims:[{geometry, material}], spec, defaultColor}
  var manifest = null;
  var ready = false;

  /* ---------- 数据加载 ---------- */
  function b64ToBuf(b64) {
    var bin = atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  function loadAll() {
    var loader = new THREE.GLTFLoader();
    var getBuf;
    if (window.KB_PARTS_DATA) {
      manifest = window.KB_PARTS_DATA.manifest;
      getBuf = function (file) { return Promise.resolve(b64ToBuf(window.KB_PARTS_DATA.files[file])); };
    } else {
      var base = location.pathname.indexOf('/dist/') >= 0 ? '../assets/parts/' : 'assets/parts/';
      getBuf = function (file) {
        return fetch(base + file).then(function (r) {
          if (!r.ok) throw new Error(file);
          return r.arrayBuffer();
        });
      };
      var manifestP = fetch(base + 'manifest.json').then(function (r) {
        if (!r.ok) throw new Error('manifest');
        return r.json();
      });
    }

    var start = window.KB_PARTS_DATA
      ? Promise.resolve()
      : manifestP.then(function (m) { manifest = m; });

    return start.then(function () {
      return Promise.all(manifest.parts.map(function (spec) {
        return getBuf(spec.file).then(function (buf) {
          return new Promise(function (res, rej) {
            loader.parse(buf, '', function (gltf) {
              res(bake(spec, gltf));
            }, rej);
          });
        });
      }));
    });
  }

  /* 把 glTF 场景烘焙成零件几何:节点变换 → 顶点,再套 manifest 的归一变换 */
  function bake(spec, gltf) {
    gltf.scene.updateMatrixWorld(true);
    var us = manifest.unitScale;
    var off = spec.offset;
    var norm = new THREE.Matrix4().makeScale(us, us, us)
      .multiply(new THREE.Matrix4().makeTranslation(-off[0], -off[1], -off[2]));
    var prims = [];
    gltf.scene.traverse(function (o) {
      if (!o.isMesh) return;
      var g = o.geometry.clone();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(norm, o.matrixWorld));
      var mat = (Array.isArray(o.material) ? o.material[0] : o.material).clone();
      mat.metalness = Math.min(mat.metalness !== undefined ? mat.metalness : 0.4, 0.85);
      if (mat.roughness !== undefined && mat.roughness < 0.25) mat.roughness = 0.35;
      prims.push({ geometry: g, material: mat });
    });
    var defaultColor = prims.length ? '#' + prims[0].material.color.getHexString() : '#c8cfd6';
    cache[spec.key] = { prims: prims, spec: spec, defaultColor: defaultColor,
      original: { holes: JSON.parse(JSON.stringify(spec.holes)), pegs: JSON.parse(JSON.stringify(spec.pegs)) } }; // 标注工具 Reset 用
  }

  /* ---------- 实例化 / 序列化辅助(app.js 调用) ---------- */
  function instantiate(key, tint) {
    var entry = cache[key];
    var wrapper = new THREE.Group();
    wrapper.userData.kbType = 'part:' + key;
    if (!entry) { // 数据未就绪:占位,resolve() 时补全
      wrapper.userData.kbPending = { tint: tint || null };
      return wrapper;
    }
    entry.prims.forEach(function (pr) {
      var m = new THREE.Mesh(pr.geometry, pr.material.clone());
      m.castShadow = m.receiveShadow = true;
      m.userData.kbShared = true; // 几何体共享,删除时不 dispose
      wrapper.add(m);
    });
    if (tint) {
      wrapper.traverse(function (o) { if (o.isMesh) o.material.color.set(tint); });
    }
    return wrapper;
  }

  function resolve(wrapper) {
    var key = wrapper.userData.kbType.slice(5);
    var entry = cache[key];
    if (!entry) return;
    var tint = wrapper.userData.kbPending ? wrapper.userData.kbPending.tint : null;
    delete wrapper.userData.kbPending;
    var real = instantiate(key, tint);
    real.children.slice().forEach(function (c) { wrapper.add(c); });
  }

  function getTint(wrapper) {
    var entry = cache[wrapper.userData.kbType.slice(5)];
    var mesh = null;
    wrapper.traverse(function (o) { if (!mesh && o.isMesh) mesh = o; });
    if (!entry || !mesh) {
      return wrapper.userData.kbPending ? wrapper.userData.kbPending.tint : null;
    }
    var hex = '#' + mesh.material.color.getHexString();
    return hex === entry.defaultColor ? null : hex;
  }

  /* 恢复 GLB 原始材质(含颜色) */
  function resetMaterial(wrapper) {
    var entry = cache[wrapper.userData.kbType.slice(5)];
    if (!entry) return;
    var i = 0;
    wrapper.children.forEach(function (o) {
      if (!o.isMesh || i >= entry.prims.length) return;
      o.material.dispose();
      o.material = entry.prims[i].material.clone();
      i += 1;
    });
  }

  /* ---------- 与 ARISTOS 数据的换算(mm · Y 朝上 · XYZ 欧拉 · GLB 节点原点) ---------- */
  function bare(u) { return String(u || '').replace(/-/g, '').toLowerCase(); }

  // 装配图里的模型 UUID(manifest.parts[].models,连字符无关)→ 零件类型 key
  function keyForModel(modelUuid) {
    if (!manifest) return null;
    var want = bare(modelUuid);
    for (var i = 0; i < manifest.parts.length; i++) {
      var ms = manifest.parts[i].models || [];
      for (var j = 0; j < ms.length; j++) if (bare(ms[j]) === want) return manifest.parts[i].key;
    }
    return null;
  }

  // 零件节点 → 其 GLB 原点的世界位姿。烘焙时 v' = S·(v − offset),所以 GLB 原点在节点局部的 −offset·S
  function poseOf(node) {
    var key = node.userData.kbType.slice(5);
    var spec = cache[key] ? cache[key].spec : null;
    var S = manifest.unitScale, k = S / 1000;
    node.updateMatrixWorld(true);
    var originLocal = spec
      ? new THREE.Vector3(-spec.offset[0] * S, -spec.offset[1] * S, -spec.offset[2] * S)
      : new THREE.Vector3();
    var p = node.localToWorld(originLocal);
    var e = new THREE.Euler().setFromQuaternion(node.getWorldQuaternion(new THREE.Quaternion()), 'XYZ');
    return { x: p.x / k, y: p.y / k, z: p.z / k, roll: e.x, pitch: e.y, yaw: e.z };
  }

  // GLB 原点位姿 → 挂在场景根下的零件节点的 position / rotation(t = R·(offset·S) + t_mm·k)
  function nodeTransform(key, pose) {
    var spec = cache[key] ? cache[key].spec : null;
    var S = manifest.unitScale, k = S / 1000;
    var e = new THREE.Euler(pose.roll || 0, pose.pitch || 0, pose.yaw || 0, 'XYZ');
    var q = new THREE.Quaternion().setFromEuler(e);
    var offW = spec
      ? new THREE.Vector3(spec.offset[0] * S, spec.offset[1] * S, spec.offset[2] * S).applyQuaternion(q)
      : new THREE.Vector3();
    return { p: [(pose.x || 0) * k + offW.x, (pose.y || 0) * k + offW.y, (pose.z || 0) * k + offW.z],
             r: [e.x, e.y, e.z] };
  }

  // ScenePart {id, key | glb, name?, pose} → 场景存档里的对象;认不出模型返回 null
  function sceneObject(part) {
    var key = part.key && cache[part.key] ? part.key : null;
    if (!key && part.glb) {
      var m = /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})/i.exec(part.glb);
      if (m) key = keyForModel(m[1]);
    }
    if (!key) return null;
    var t = nodeTransform(key, part.pose || {});
    return { id: part.id, name: part.name || cache[key].spec.label, type: 'part:' + key, p: t.p, r: t.r, s: [1, 1, 1] };
  }

  // The task graph records the X-Lock's first appearance, but the operation
  // mounts two previously prepared assemblies onto that fixed receiving part.
  var operationAnswer = null;
  function assemblyAnswer() {
    var a = manifest && manifest.answer;
    if (!a || a === operationAnswer) return a || null;
    operationAnswer = a;
    var st = a.steps.find(function (s) { return s.id === '972c5284-031e-44eb-883f-cc040168dac0'; });
    var base = a.parts.find(function (p) { return st && p.step === st.i && p.key === 'aluminum_x_lock'; });
    if (!base) return a;
    var wedges = a.parts.filter(function (p) { return p.key === 'aluminum_arm_wedge_5mm' && p.step < st.i && p.mates.some(function (m) { return m.id === base.id; }); });
    if (wedges.length !== 2) return a;
    var groups = wedges.map(function (w) { return a.parts.filter(function (p) { return p.step === w.step; }).map(function (p) { return p.id; }); });
    st.name = 'Attach both Wedge Assemblies to X-Lock';
    st.requires = wedges.map(function (w) { return w.step; });
    st.assembly = { base: base.id, groups: groups };
    var rear = a.parts.find(function (p) { return p.key === 'split_rear_plate'; });
    if (rear && rear.step > st.i && a.steps[rear.step].requires.indexOf(st.i) < 0) a.steps[rear.step].requires.push(st.i);
    return a;
  }

  window.KBParts = {
    ready: function () { return ready; },
    unitScale: function () { return manifest ? manifest.unitScale : 24.77; },
    spec: function (key) { return cache[key] ? cache[key].spec : null; },
    original: function (key) { return cache[key] ? cache[key].original : null; },
    prims: function (key) { return cache[key] ? cache[key].prims : null; },
    keys: function () { return manifest ? manifest.parts.map(function (p) { return p.key; }) : []; },
    /* 初始"零件摆在桌上"的布局(ScenePart[]),由 tools/scene_from_db.py --layout kit 从任务图库生成 */
    kit: function () { return (manifest && manifest.kit) || null; },
    /* 参考装配(步骤顺序 / 每件的接近→落位轨迹 / 前置依赖),由 features_db.py answer 从任务图库生成;mm · GLB 原点 */
    answer: assemblyAnswer,
    keyForModel: keyForModel,
    poseOf: poseOf,
    nodeTransform: nodeTransform,
    sceneObject: sceneObject,
    instantiate: instantiate,
    resolve: resolve,
    resetMaterial: resetMaterial,
    getTint: getTint
  };
  /* ---------- 启动 ----------
   * mini 的裁剪(相对 ca69f1e 的 src/parts.js):
   *   - 去掉"部件架按钮"整节(buildShelf / spawn):mini 没有零件栏, 也不许加零件
   *   - 去掉"孔位标签可视化"整节(labelRoot / ringLine / makeTextSprite /
   *     labelSelection / syncLabels):那是选中零件时画的琥珀色孔圈, mini 不能选中;
   *     而且 labelRoot 带 userData.kbOverlay, 留着会让"场景里 kbOverlay 组 = 0"这条
   *     自检恒假
   *   - 去掉 KB.toast 调用:mini 没有 toast
   * 其余(loadAll / bake / instantiate / poseOf / nodeTransform / sceneObject /
   * assemblyAnswer)逐字保留。 */
  loadAll().then(function () {
    ready = true;
    var pending = [];
    KB.objectsRoot.traverse(function (o) { if (o.userData && o.userData.kbPending) pending.push(o); });
    pending.forEach(resolve);
  }).catch(function (err) {
    console.warn('Failed to load parts library', err);
  });
})();
