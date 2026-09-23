/* Assembly area, separate from the parts tray. Bounds are world X/Z units;
 * height is unrestricted, so stacked assemblies are supported. */
(function () {
  'use strict';
  var KB = window.KB;
  // 装配区在物料区前面:托盘占 x -6.8..6.8 / z -4.2..4.2,装配区放在它前方(+z)一段
  var bounds = { minX: -5, maxX: 5, minZ: 6, maxZ: 16 };
  var center = new THREE.Vector3(0, 0, 11);
  var group = new THREE.Group(); group.name = 'Assembly workspace';
  // Deliberately visible in ARISTOS frames, but outside objectsRoot: no picking/export.
  // Boundary only: no filled surface between the camera and an underside assembly.
  var points = [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ],
    [bounds.minX, bounds.maxZ], [bounds.minX, bounds.minZ]].map(function (p) { return new THREE.Vector3(p[0], .015, p[1]); });
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x66d1ba })));
  var label = document.createElement('canvas'); label.width = 1024; label.height = 128;
  var ctx = label.getContext('2d'); ctx.fillStyle = '#96ead7'; ctx.font = '600 52px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('ASSEMBLY WORKSPACE', 512, 60); ctx.font = '28px sans-serif'; ctx.fillText('Move the base here before connecting parts', 512, 106);
  var mesh = new THREE.Mesh(new THREE.PlaneGeometry(7, .875), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(label), transparent: true, depthWrite: false, side: THREE.FrontSide }));
  mesh.rotation.x = -Math.PI / 2; mesh.position.set(center.x, .02, bounds.maxZ - .55); group.add(mesh); KB.scene.add(group);

  function box(node, position, quaternion) {
    node.updateWorldMatrix(true, true);
    var delta = null;
    if (position) {
      var desired = new THREE.Matrix4().compose(position, quaternion || node.quaternion, node.scale);
      if (node.parent) desired.premultiply(node.parent.matrixWorld);
      delta = desired.multiply(node.matrixWorld.clone().invert());
    }
    var out = new THREE.Box3();
    node.traverse(function (n) {
      if (!n.isMesh || n.userData.kbOverlay) return;
      if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
      var m = n.matrixWorld.clone(); if (delta) m.premultiply(delta);
      out.union(n.geometry.boundingBox.clone().applyMatrix4(m));
    });
    return out;
  }
  function contains(node, position, quaternion) {
    var b = box(node, position, quaternion), eps = .001;
    return !b.isEmpty() && b.min.x >= bounds.minX - eps && b.max.x <= bounds.maxX + eps &&
      b.min.z >= bounds.minZ - eps && b.max.z <= bounds.maxZ + eps;
  }
  function destination(node) {
    var b = box(node), c = b.getCenter(new THREE.Vector3());
    var p = node.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(center.x - c.x, 0, center.z - c.z));
    if (node.parent) p.applyMatrix4(node.parent.matrixWorld.clone().invert());
    return p;
  }
  /* 取景:两个区各自的镜头,以及在两者之间来回切的按钮 ---------------------- */
  function trayView() {           // 物料区:按这次布局实际占用的范围取景
    var e = window.KBTray ? KBTray.extent() : { minX: -7.6, maxX: 7.6, minZ: -5.6, maxZ: 4.4 };
    var cx = (e.minX + e.maxX) / 2, cz = (e.minZ + e.maxZ) / 2;
    var span = Math.max(e.maxX - e.minX, e.maxZ - e.minZ);
    return { p: [cx, span * 0.85, cz + span * 0.75], t: [cx, 0, cz] };
  }
  var WORK = { p: [center.x, 7.5, center.z + 9], t: [center.x, .4, center.z] }; // 装配区
  var at = 'tray';
  function overview() { KB.flyCamera([0, 15, 26], [0, 0, 4]); at = 'overview'; }
  function look(where) {
    at = where;
    var v = where === 'work' ? WORK : trayView();
    KB.flyCamera(v.p, v.t);
    var btn = document.getElementById('btnArea');
    if (btn) btn.querySelector('.lbl').textContent = where === 'work' ? 'Workspace' : 'Parts tray';
    KB.toast(where === 'work' ? 'Assembly workspace' : 'Parts tray');
    KB.emit('areaChange', where);
  }
  function toggle() { look(at === 'work' ? 'tray' : 'work'); }
  var btnArea = document.getElementById('btnArea');
  if (btnArea) btnArea.addEventListener('click', toggle);
  window.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (e.code !== 'KeyB' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    toggle();
  });

  window.KBWorkspace = { contains: contains, destination: destination, bounds: bounds, center: center, overview: overview,
    look: look, toggle: toggle,
    canConnect: function (source, target) { return contains(target); },
    message: function (node) { return 'Move ' + (node.name || 'the receiving part') + ' fully into the assembly workspace first.'; } };
})();

KBWorkspace.overview();
