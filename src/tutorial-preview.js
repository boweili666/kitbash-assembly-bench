/* Isolated tutorial demonstrations, using the same GLB meshes and feature
 * coordinates as the assembly bench. Never run mate(), emit events, or move
 * practice/task objects to produce a preview. */
(function () {
  'use strict';
  var renderer, scene, camera, root, host, canvas, caption, cursor, sourceLabel, targetLabel;
  var source, target, sourceFeature, targetFeature, markerA, markerB;
  var moveTarget, guide, storySteps, storyNote, playButton, startQuaternion;
  var cameraCenter, cameraDirection, cameraDistance, joinedCenter, joinedDistance;
  var elapsed = 0, tickTime = 0, userPaused = false;
  function isStory() { return configuration && /^(mateArm|mateScrew)$/.test(configuration.tag); }
  var startPosition, endPosition, endQuaternion, axis, pivot, configuration;
  var frame = 0, lastDraw = 0, paused = false, active = false;
  var width = 0, height = 0;
  var ownedMaterials = [], ownedGeometries = [];
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var v = function (a) { return new THREE.Vector3().fromArray(a); };
  function material(m) { ownedMaterials.push(m); return m; }
  function geometry(g) { ownedGeometries.push(g); return g; }

  function clear() {
    cancelAnimationFrame(frame);
    frame = 0;
    ownedMaterials.forEach(function (m) { m.dispose(); });
    ownedGeometries.forEach(function (g) { g.dispose(); });
    ownedMaterials = []; ownedGeometries = [];
    if (root) scene.remove(root);
    root = null; guide = null;
  }
  function part(data) {
    var node = KBParts.instantiate(data.type.slice(5));
    node.name = data.name;
    node.position.fromArray(data.p);
    node.rotation.set.apply(node.rotation, data.r);
    node.traverse(function (mesh) {
      if (!mesh.isMesh) return;
      // Geometry belongs to KBParts' cache; only the cloned materials are ours.
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(function (m) { ownedMaterials.push(m); });
    });
    root.add(node);
    node.updateMatrixWorld(true);
    return node;
  }
  function feature(node, id, end) {
    var spec = KBParts.spec(node.userData.kbType.slice(5));
    var f = (id[0] === 'P' ? spec.pegs : spec.holes).filter(function (f) { return f.id === id; })[0];
    node.updateMatrixWorld(true);
    var c = v(f.c).applyMatrix4(node.matrixWorld), d = v(f.d).transformDirection(node.matrixWorld);
    var body = v(spec.bbox.min).add(v(spec.bbox.max)).multiplyScalar(.5).applyMatrix4(node.matrixWorld);
    return { c: c, d: d, depth: f.depth, r: f.r, end: end,
      mouth: c.clone().addScaledVector(d, (end || 0) * f.depth / 2),
      tip: d.clone().multiplyScalar(c.clone().sub(body).dot(d) < 0 ? -1 : 1) };
  }
  function ring(node, id, end, color) {
    var spec = KBParts.spec(node.userData.kbType.slice(5));
    var f = (id[0] === 'P' ? spec.pegs : spec.holes).filter(function (f) { return f.id === id; })[0];
    var mesh = new THREE.Mesh(geometry(new THREE.RingGeometry(f.r * 1.1, f.r * 1.85, 40)),
      material(new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide, depthTest: false, transparent: true })));
    mesh.position.copy(v(f.c).addScaledVector(v(f.d), (end || 0) * f.depth / 2));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v(f.d));
    mesh.renderOrder = 10;
    node.add(mesh);
    return mesh;
  }
  function positionAt(t) {
    source.position.copy(endPosition);
    source.quaternion.copy(endQuaternion);
    var tag = configuration.tag;
    if (tag === 'select' || tag === 'armScrew') source.position.copy(startPosition);
    if (tag === 'move') source.position.lerpVectors(startPosition, endPosition, smooth((t - .3) / .4));
    if (isStory()) {
      // Align while separated, then approach strictly along the receiving axis.
      source.quaternion.copy(startQuaternion).slerp(endQuaternion, smooth((t - .36) / .16));
      source.position.lerpVectors(startPosition, endPosition, smooth((t - .54) / .23));
      if (tag === 'mateArm' && t > .84) {
        var turn = new THREE.Quaternion().setFromAxisAngle(axis, Math.sin(smooth((t - .84) / .12) * Math.PI * 2) * Math.PI / 12);
        source.position.sub(pivot).applyQuaternion(turn).add(pivot);
        source.quaternion.premultiply(turn);
      }
    }
    if (tag === 'turn') {
      var q = new THREE.Quaternion().setFromAxisAngle(axis, Math.sin(t * Math.PI * 2) * Math.PI / 7);
      source.position.sub(pivot).applyQuaternion(q).add(pivot);
      source.quaternion.premultiply(q);
    }
    if (tag === 'slide') source.position.addScaledVector(axis, (1 - Math.cos(t * Math.PI * 2)) * sourceFeature.depth * .35);
    source.updateMatrixWorld(true);
  }
  function smooth(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }
  function fitCamera() {
    // Include the whole trajectory so no part gets clipped during the loop.
    var bounds = new THREE.Box3();
    for (var i = 0; i <= 12; i++) { positionAt(i / 12); bounds.expandByObject(source); if (target.parent) bounds.expandByObject(target); }
    var center = bounds.getCenter(new THREE.Vector3());
    var radius = bounds.getSize(new THREE.Vector3()).length() / 2;
    camera.aspect = width / height;
    var angle = Math.min(camera.fov * Math.PI / 360, Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect));
    var distance = radius / Math.sin(angle) * 1.08;
    var direction = configuration.course === 0 ? new THREE.Vector3(1.25, 1.6, 2.2) : new THREE.Vector3(2.6, 1.4, 1.3);
    if (isStory() && configuration.tag === 'mateArm' && configuration.target.end === -1) direction.y *= -1;
    cameraCenter = center; cameraDirection = direction.normalize(); cameraDistance = distance;
    camera.position.copy(center).addScaledVector(cameraDirection, distance);
    if (isStory()) {
      positionAt(.81);
      var joined = new THREE.Box3().setFromObject(source).expandByObject(target);
      joinedCenter = joined.getCenter(new THREE.Vector3());
      joinedDistance = joined.getSize(new THREE.Vector3()).length() / 2 / Math.sin(angle) * 1.35;
    }
    camera.near = Math.max(.001, distance / 100);
    camera.far = distance * 20;
    camera.lookAt(center);
    camera.updateProjectionMatrix();
  }
  function anchor(element, node, dx, dy) {
    var point = node.getWorldPosition(new THREE.Vector3()).project(camera);
    var x = (point.x + 1) * width / 2, y = (1 - point.y) * height / 2;
    element.style.left = Math.max(8, Math.min(width - element.offsetWidth - 8, x + dx)) + 'px';
    element.style.top = Math.max(24, Math.min(height - element.offsetHeight - 4, y + dy)) + 'px';
  }
  function draw(now) {
    var t = motion.matches ? .81 : (elapsed % (isStory() ? 14000 : 5200)) / (isStory() ? 14000 : 5200);
    positionAt(t);
    markerA.material.color.set(t > .2 ? 0x7de0aa : kindColor(configuration.source.id));
    markerA.material.opacity = .85;
    if (markerB) markerB.material.opacity = .65 + .35 * Math.sin(t * Math.PI * 4) ** 2;
    if (isStory()) {
      var reveal = smooth((t - .77) / .13);
      var direction = cameraDirection.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), reveal * .42);
      direction.y *= 1 - reveal * .45; direction.normalize();
      var closeup = smooth((t - .54) / .27);
      var focus = cameraCenter.clone().lerp(joinedCenter, closeup);
      camera.position.copy(focus).addScaledVector(direction, THREE.MathUtils.lerp(cameraDistance, joinedDistance, closeup));
      camera.lookAt(focus);
      var a = markerA.getWorldPosition(new THREE.Vector3()), b = markerB.getWorldPosition(new THREE.Vector3());
      guide.geometry.setFromPoints([a, b]); guide.computeLineDistances();
      guide.visible = t > .24 && t < .78;
      markerB.material.color.set(t >= .77 ? 0x7de0aa : kindColor(configuration.target.id));
    }
    renderer.render(scene, camera);
    anchor(sourceLabel, markerA, 12, -25);
    if (markerB) anchor(targetLabel, markerB, 12, 12);
    var tag = configuration.tag;
    var clicking = isStory() ? t < .36 : tag !== 'turn' && tag !== 'slide' && tag !== 'complete';
    cursor.hidden = !clicking;
    var second = markerB && (tag === 'mateArm' || tag === 'mateScrew') && t > .23;
    if (clicking) {
      anchor(cursor, tag === 'move' ? moveTarget : second ? markerB : markerA, 0, 0);
      cursor.classList.toggle('press', (t > .18 && t < .27) || (second && t > .29 && t < .35));
    }
    caption.textContent = tag === 'turn' ? '← / →  Rotate around the hole' : tag === 'slide' ? '↑ / ↓  Slide along the hole' :
      tag === 'move' ? 'Click the grid to move the arm' : tag === 'complete' ? 'Same parts. Same connections.' :
      second ? '2 · Click the receiving hole' : tag === 'select' ? 'Click the arm to select it' : '1 · Click the highlighted connector';
    if (isStory()) {
      var chapter = t < .23 ? 0 : t < .36 ? 1 : t < .54 ? 2 : t < .77 ? 3 : 4;
      var messages = ['1 · Pick the connection on the moving part', '2 · Pick the receiving hole mouth',
        '3 · Turn until the connectors face each other', '4 · Follow the axis — ease into contact',
        tag === 'mateArm' ? '5 · Connected — arrow keys turn around this hole' : '5 · Connected — arrow keys slide along this hole'];
      caption.textContent = messages[chapter];
      storySteps.querySelectorAll('span').forEach(function (s, i) { s.classList.toggle('current', i === chapter); s.classList.toggle('done', i < chapter); });
      host.dataset.chapter = String(chapter);
      canvas.style.opacity = motion.matches ? '1' : String(Math.min(1, t / .035, (1 - t) / .035));
      sourceLabel.hidden = targetLabel.hidden = chapter >= 2;
      markerA.material.color.set(t > .16 ? 0x7de0aa : kindColor(configuration.source.id));
    }

  }
  function loop(now) {
    if (!active || paused || userPaused || document.hidden) { frame = 0; tickTime = 0; return; }
    if (tickTime) elapsed += now - tickTime; tickTime = now;
    if (now - lastDraw > 33) { draw(now); lastDraw = now; }
    if (!motion.matches) frame = requestAnimationFrame(loop); else frame = 0;
  }
  function resume() {
    if (active && !paused && !userPaused && !document.hidden && !frame) { tickTime = 0; frame = requestAnimationFrame(loop); }
  }
  function resize() {
    if (!active || !host.clientWidth || !host.clientHeight) return;
    width = host.clientWidth; height = host.clientHeight;
    renderer.setSize(width, height, false);
    fitCamera(); draw(performance.now());
  }
  var observer = new ResizeObserver(resize);
  document.addEventListener('visibilitychange', function () { tickTime = 0; if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else resume(); });
  motion.addEventListener('change', function () { if (active) { draw(performance.now()); resume(); } });

  // 和 mate.js 里的圆片同一套配色:孔 = 亮品红,销 = 紫罗兰
  function kindColor(id) { return String(id || '').charAt(0) === 'P' ? 0x8a4bff : 0xff2d95; }

  function show(container, config) {
    clear();
    host = container; configuration = config; active = true; paused = false; userPaused = false; elapsed = 0; tickTime = 0;
    host.classList.toggle('tt-story', isStory()); delete host.dataset.chapter;
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.2;
      canvas = renderer.domElement;
      canvas.setAttribute('role', 'img');
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(33, 1, .01, 100);
      scene.add(new THREE.HemisphereLight(0xe1eeff, 0x71809a, 1.1));
      var key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(3, 5, 4); scene.add(key);
      var fill = new THREE.DirectionalLight(0x82b8ff, .65); fill.position.set(-3, 2, -4); scene.add(fill);
    }
    host.replaceChildren(canvas); canvas.style.opacity = '1';
    canvas.setAttribute('aria-label', config.label + ' — actual assembly models');
    function overlay(className) { var e = document.createElement('span'); e.className = className; host.appendChild(e); return e; }
    caption = overlay('tt-real-caption');
    if (isStory()) {
      storySteps = overlay('tt-story-steps');
      storySteps.innerHTML = ['Pick', 'Receive', 'Align', 'Join', 'Connected'].map(function (name) { return '<span>' + name + '</span>'; }).join('');
      storyNote = overlay('tt-story-note');
      storyNote.textContent = config.tag === 'mateArm' ? (config.target.end === 1 ? 'Lower arm mouth → TOP plate mouth' : 'Lower arm mouth → UNDERSIDE plate mouth') : 'Shaft disc → wedge hole mouth';
      var controls = document.createElement('div'); controls.className = 'tt-story-controls'; host.appendChild(controls);
      playButton = document.createElement('button'); playButton.type = 'button'; playButton.textContent = 'Pause'; playButton.setAttribute('aria-label', 'Pause connection demonstration'); controls.appendChild(playButton);
      playButton.onclick = function () {
        userPaused = !userPaused; tickTime = 0;
        playButton.textContent = userPaused ? 'Play' : 'Pause';
        playButton.setAttribute('aria-label', (userPaused ? 'Play' : 'Pause') + ' connection demonstration');
        if (userPaused) { cancelAnimationFrame(frame); frame = 0; } else resume();
      };
      if (config.tag === 'mateArm') {
        var faceButton = document.createElement('button'); faceButton.type = 'button'; faceButton.textContent = config.target.end === 1 ? 'Compare underside' : 'Back to top face'; controls.appendChild(faceButton);
        faceButton.onclick = function () { show(host, Object.assign({}, config, { target: Object.assign({}, config.target, { end: -config.target.end }) })); };
      }
    }
    sourceLabel = overlay('tt-real-label'); targetLabel = overlay('tt-real-label target');
    cursor = overlay('tt-real-cursor'); cursor.setAttribute('aria-hidden', 'true');
    cursor.innerHTML = '<svg viewBox="0 0 24 32"><path d="M2 2V25L8 19L13 29L18 26L13 17H23Z" fill="#fff" stroke="#132132" stroke-width="1.5"/></svg>';
    root = new THREE.Group(); scene.add(root);
    var nodes = {};
    config.objects.forEach(function (data) { nodes[data.name] = part(data); });
    source = nodes[config.source.name]; target = nodes[config.target.name];
    var alone = config.tag === 'select' || config.tag === 'move' || config.tag === 'armScrew';
    if (alone) root.remove(target);
    // Presentation poses use the course orientation, and the actual H/P records.
    source.position.set(0, 0, 0); target.position.set(0, 0, 0);
    sourceFeature = feature(source, config.source.id, config.source.end);
    targetFeature = feature(target, config.target.id, config.target.end);
    axis = targetFeature.d.clone().multiplyScalar(config.target.end || 1);
    pivot = targetFeature.mouth.clone();
    var peg = config.source.id[0] === 'P';
    var normal = peg ? sourceFeature.tip : sourceFeature.d.clone().multiplyScalar(config.source.end);
    var q = new THREE.Quaternion().setFromUnitVectors(normal, axis.clone().negate());
    var center = targetFeature.c.clone().addScaledVector(axis,
      (targetFeature.depth + (peg ? -sourceFeature.depth : sourceFeature.depth)) / 2);
    endQuaternion = q.clone().multiply(source.quaternion);
    endPosition = source.position.clone().sub(sourceFeature.c).applyQuaternion(q).add(center);
    var size = new THREE.Box3().setFromObject(source).getSize(new THREE.Vector3()).length();
    startPosition = endPosition.clone().addScaledVector(axis, size * .52);
    startQuaternion = endQuaternion.clone();
    if (isStory()) {
      var tiltAxis = new THREE.Vector3(1, 0, 0);
      if (Math.abs(axis.dot(tiltAxis)) > .9) tiltAxis.set(0, 0, 1);
      startQuaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(tiltAxis, .38));
    }
    if (alone) {
      endQuaternion.copy(source.quaternion); endPosition.set(0, 0, 0); startPosition.set(0, 0, 0);
      if (config.tag === 'move') { startPosition.x = -size * .24; endPosition.x = size * .24; }
    }
    moveTarget = new THREE.Object3D(); moveTarget.position.copy(endPosition); root.add(moveTarget);
    markerA = ring(source, config.source.id, config.source.end, kindColor(config.source.id));
    markerB = alone ? null : ring(target, config.target.id, config.target.end, kindColor(config.target.id));
    sourceLabel.textContent = config.source.name + (alone ? '' : peg ? ' · shaft' : ' · lower face');
    targetLabel.textContent = config.target.name + (peg ? ' · hole' : config.target.end === 1 ? ' · top face' : ' · underside');
    targetLabel.hidden = alone;
    if (isStory()) {
      guide = new THREE.Line(geometry(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()])),
        material(new THREE.LineDashedMaterial({ color: 0xf0bb69, dashSize: size * .025, gapSize: size * .018, transparent: true, opacity: .8, depthTest: false })));
      guide.renderOrder = 9; root.add(guide);
    }
    lastDraw = 0;
    observer.disconnect(); observer.observe(host);
    resize(); resume();
  }
  window.KBTutorialPreview = {
    show: show,
    stop: function () { active = false; observer.disconnect(); clear(); },
    pause: function (value) { paused = value; tickTime = 0; if (paused) { cancelAnimationFrame(frame); frame = 0; } else { resize(); resume(); } },
    // Read-only inspection for geometry/pose regression checks.
    inspect: function () { return { source: source, target: target, endPosition: endPosition.clone(), endQuaternion: endQuaternion.clone(), axis: axis.clone() }; }
  };
})();
