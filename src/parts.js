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
    cache[spec.key] = { prims: prims, spec: spec, defaultColor: defaultColor };
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

  window.KBParts = {
    ready: function () { return ready; },
    unitScale: function () { return manifest ? manifest.unitScale : 24.77; },
    spec: function (key) { return cache[key] ? cache[key].spec : null; },
    prims: function (key) { return cache[key] ? cache[key].prims : null; },
    instantiate: instantiate,
    resolve: resolve,
    resetMaterial: resetMaterial,
    getTint: getTint
  };

  /* ---------- 部件架按钮 ---------- */
  var shelf = document.getElementById('shelf');

  function buildShelf() {
    if (!shelf) return; // 零件栏已从界面移除
    var sep = document.createElement('h2');
    sep.textContent = 'Parts';
    sep.style.marginTop = '6px';
    shelf.appendChild(sep);
    manifest.parts.forEach(function (spec) {
      var btn = document.createElement('button');
      btn.className = 'part';
      btn.title = 'Add ' + spec.label + ' (' + spec.holes.length + ' holes \u00b7 ' + spec.pegs.length + ' pegs)';
      btn.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">' +
        '<path d="M6.5 3h7M6.5 5.8h7M10 3v2.8"/><path d="M8.6 5.8h2.8l-.5 9.4-.9 1.8-.9-1.8z"/></svg>' +
        '<em></em>';
      btn.querySelector('em').textContent = spec.label;
      btn.addEventListener('click', function () { spawn(spec); });
      shelf.appendChild(btn);
    });
  }

  var spawnCount = 0;
  function spawn(spec) {
    var node = instantiate(spec.key, null);
    node.name = KB.nextName(spec.label);
    var a = spawnCount * 0.9;
    spawnCount += 1;
    node.position.set(Math.cos(a) * 1.5, -spec.bbox.min[1], Math.sin(a) * 1.5);
    KB.objectsRoot.add(node);
    KB.setSelection([node]);
    KB.pushSnapshot();
    KB.toast('Added ' + spec.label);
  }

  /* ---------- 孔位标签可视化(选中零件时) ---------- */
  var labelRoot = new THREE.Group();
  labelRoot.userData.kbOverlay = true; // 抓帧时隐藏
  labelRoot.matrixAutoUpdate = false;
  KB.scene.add(labelRoot);
  var labelled = [];   // [{wrapper, group}]

  function makeTextSprite(text, color) {
    var cv = document.createElement('canvas');
    cv.width = 96; cv.height = 48;
    var ctx = cv.getContext('2d');
    ctx.font = '600 30px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(16,20,25,0.9)';
    ctx.lineWidth = 6;
    ctx.strokeText(text, 48, 25);
    ctx.fillStyle = color;
    ctx.fillText(text, 48, 25);
    var tex = new THREE.CanvasTexture(cv);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, depthTest: false, transparent: true
    }));
    sp.scale.set(0.42, 0.21, 1);
    return sp;
  }

  function ringLine(c, d, r, color) {
    var u = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    u = u.clone().cross(d).normalize();
    var v = d.clone().cross(u);
    var pts = [];
    for (var i = 0; i <= 28; i++) {
      var a = i / 28 * Math.PI * 2;
      pts.push(c.clone()
        .addScaledVector(u, Math.cos(a) * r)
        .addScaledVector(v, Math.sin(a) * r));
    }
    return new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.9, depthTest: false }));
  }

  function clearLabels() {
    labelled.forEach(function (e) {
      e.group.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
      labelRoot.remove(e.group);
    });
    labelled = [];
  }

  function labelSelection(sel) {
    clearLabels();
    sel.forEach(function (node) {
      var t = node.userData.kbType || '';
      if (t.lastIndexOf('part:', 0) !== 0) return;
      var spec = cache[t.slice(5)] && cache[t.slice(5)].spec;
      if (!spec) return;
      var group = new THREE.Group();
      group.matrixAutoUpdate = false;
      function addMarks(list, color) {
        list.forEach(function (f) {
          var c = new THREE.Vector3().fromArray(f.c);
          var d = new THREE.Vector3().fromArray(f.d).normalize();
          group.add(ringLine(c, d, Math.max(f.r * 1.6, 0.09), color));
          var sp = makeTextSprite(f.id, color);
          sp.position.copy(c).addScaledVector(d, Math.max(f.depth * 0.9, 0.16));
          group.add(sp);
        });
      }
      addMarks(spec.holes, '#e8a33d');
      addMarks(spec.pegs, '#6fa8dc');
      labelRoot.add(group);
      labelled.push({ wrapper: node, group: group });
    });
  }

  KB.onSelection(labelSelection);

  (function syncLabels() {
    requestAnimationFrame(syncLabels);
    labelled.forEach(function (e) {
      e.group.matrix.copy(e.wrapper.matrixWorld);
    });
  })();

  /* ---------- 启动 ---------- */
  loadAll().then(function () {
    ready = true;
    buildShelf();
    // 恢复自动保存的场景里可能有零件占位节点,补全它们
    var pending = [];
    KB.objectsRoot.traverse(function (o) { if (o.userData && o.userData.kbPending) pending.push(o); });
    pending.forEach(resolve);
    if (pending.length) KB.toast('Parts library loaded; restored ' + pending.length + ' part' + (pending.length > 1 ? 's' : ''));
  }).catch(function (err) {
    console.warn('Failed to load parts library', err);
    KB.toast('Failed to load the parts library (run python3 serve.py and open localhost)');
  });
})();
