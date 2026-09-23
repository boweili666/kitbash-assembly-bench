/* Collision detection between the part being moved and the rest of the scene.
 *
 * Two detectors run after every move:
 *  - mesh: triangle-triangle intersection over one BVH per part type finds
 *    surfaces that cross; the crossing triangles are then sampled and each sample
 *    point's depth inside the other solid (ray-parity inside test + closest
 *    surface point) is measured. Only interpenetration deeper than 0.5 mm counts,
 *    so touching parts and CAD undersize (a screw in a hole modelled 0.2 mm too
 *    small) do not collide, while a part pushed through another does.
 *  - feature: a peg lined up with a hole it cannot enter (wider than the hole
 *    + 0.6 mm) with the two overlapping along the axis, unless another feature of
 *    the same part fits that hole (a screw's head over the hole its shaft is in).
 *    This catches the oversize-screw case exactly, independent of mesh detail.
 *
 * Colliding parts are tinted red while the collision lasts. A 'collision' event
 * is emitted once per pair per contact: { object1 (moved), object2, kind,
 * snapPoint1, snapPoint2, depthMm }. Nothing is blocked yet; the trainee can
 * still push the part through. */
(function () {
  'use strict';

  var KB = window.KB;
  var DEPTH_TOL_MM = 1.0;      // interpenetration deeper than this is a collision
  var EXEMPT_ENGAGED = true;   // no mesh test between parts joined by a compatible peg-in-hole
  var OVERLAP_MARGIN_MM = 0.6; // features must overlap along the axis by more than this to count
  var LEAF = 8;
  var TEST_GAP_MS = 60;
  var AXIS_COS = Math.cos(THREE.MathUtils.degToRad(10));
  var TINT = 0xd9534f;

  function unitsPerMm() { return (window.KBParts ? KBParts.unitScale() : 24.77) / 1000; }

  /* ---------- one BVH per part type over all its meshes (part-local frame) ---------- */
  var bvhCache = {};
  function soupOf(part) {
    var chunks = [], total = 0;
    part.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      var g = o.geometry, pos = g.getAttribute('position');
      if (!pos) return;
      var idx = g.index ? g.index.array : null;
      var n = idx ? idx.length / 3 : pos.count / 3;
      var tris = new Float32Array(n * 9);
      var M = o.matrix; // baked meshes sit at identity under the part; honour a transform anyway
      var v = new THREE.Vector3();
      for (var t = 0; t < n; t++) {
        for (var k = 0; k < 3; k++) {
          var vi = idx ? idx[t * 3 + k] : t * 3 + k;
          v.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(M);
          var oo = t * 9 + k * 3;
          tris[oo] = v.x; tris[oo + 1] = v.y; tris[oo + 2] = v.z;
        }
      }
      chunks.push(tris); total += tris.length;
    });
    var all = new Float32Array(total), at = 0;
    chunks.forEach(function (c) { all.set(c, at); at += c.length; });
    return all;
  }

  function buildBVH(tris) {
    var n = tris.length / 9;
    var order = new Uint32Array(n);
    var cen = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      order[i] = i;
      var o = i * 9;
      cen[i * 3] = (tris[o] + tris[o + 3] + tris[o + 6]) / 3;
      cen[i * 3 + 1] = (tris[o + 1] + tris[o + 4] + tris[o + 7]) / 3;
      cen[i * 3 + 2] = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3;
    }
    function bounds(start, count) {
      var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (var i = start; i < start + count; i++) {
        var o = order[i] * 9;
        for (var k = 0; k < 9; k++) {
          var a = k % 3, v = tris[o + k];
          if (v < mn[a]) mn[a] = v;
          if (v > mx[a]) mx[a] = v;
        }
      }
      return { min: mn, max: mx };
    }
    function build(start, count) {
      var b = bounds(start, count);
      var node = { min: b.min, max: b.max, start: start, count: count, l: null, r: null };
      if (count <= LEAF) return node;
      var ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
      var axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : (ext[1] >= ext[2] ? 1 : 2);
      var sub = Array.prototype.slice.call(order, start, start + count);
      sub.sort(function (p, q) { return cen[p * 3 + axis] - cen[q * 3 + axis]; });
      for (var i = 0; i < count; i++) order[start + i] = sub[i];
      var half = count >> 1;
      node.l = build(start, half);
      node.r = build(start + half, count - half);
      node.count = 0;
      return node;
    }
    return { tris: tris, order: order, root: n ? build(0, n) : null };
  }

  function bvhOf(part) {
    var key = part.userData.kbType;
    if (bvhCache[key]) return bvhCache[key];
    var b = buildBVH(soupOf(part));
    if (b.root) bvhCache[key] = b;
    return b;
  }

  /* ---------- triangle-triangle intersection (Moller 1997; coplanar pairs count as no contact) ---------- */
  var EPS = 1e-7;
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  function intervals(vv0, vv1, vv2, d0, d1, d2, d0d1, d0d2) {
    var a, b, c, x0, x1;
    if (d0d1 > 0) { a = vv2; b = (vv0 - vv2) * d2; c = (vv1 - vv2) * d2; x0 = d2 - d0; x1 = d2 - d1; }
    else if (d0d2 > 0) { a = vv1; b = (vv0 - vv1) * d1; c = (vv2 - vv1) * d1; x0 = d1 - d0; x1 = d1 - d2; }
    else if (d1 * d2 > 0 || d0 !== 0) { a = vv0; b = (vv1 - vv0) * d0; c = (vv2 - vv0) * d0; x0 = d0 - d1; x1 = d0 - d2; }
    else if (d1 !== 0) { a = vv1; b = (vv0 - vv1) * d1; c = (vv2 - vv1) * d1; x0 = d1 - d0; x1 = d1 - d2; }
    else if (d2 !== 0) { a = vv2; b = (vv0 - vv2) * d2; c = (vv1 - vv2) * d2; x0 = d2 - d0; x1 = d2 - d1; }
    else return null; // coplanar
    return [a, b, c, x0, x1];
  }

  function triTri(v0, v1, v2, u0, u1, u2) {
    var e1 = sub(v1, v0), e2 = sub(v2, v0);
    var n1 = cross(e1, e2);
    var d1 = -dot(n1, v0);
    var du0 = dot(n1, u0) + d1, du1 = dot(n1, u1) + d1, du2 = dot(n1, u2) + d1;
    if (Math.abs(du0) < EPS) du0 = 0;
    if (Math.abs(du1) < EPS) du1 = 0;
    if (Math.abs(du2) < EPS) du2 = 0;
    var du0du1 = du0 * du1, du0du2 = du0 * du2;
    if (du0du1 > 0 && du0du2 > 0) return false;

    e1 = sub(u1, u0); e2 = sub(u2, u0);
    var n2 = cross(e1, e2);
    var d2 = -dot(n2, u0);
    var dv0 = dot(n2, v0) + d2, dv1 = dot(n2, v1) + d2, dv2 = dot(n2, v2) + d2;
    if (Math.abs(dv0) < EPS) dv0 = 0;
    if (Math.abs(dv1) < EPS) dv1 = 0;
    if (Math.abs(dv2) < EPS) dv2 = 0;
    var dv0dv1 = dv0 * dv1, dv0dv2 = dv0 * dv2;
    if (dv0dv1 > 0 && dv0dv2 > 0) return false;

    var D = cross(n1, n2);
    var idx = 0, mx = Math.abs(D[0]);
    if (Math.abs(D[1]) > mx) { mx = Math.abs(D[1]); idx = 1; }
    if (Math.abs(D[2]) > mx) idx = 2;

    var A = intervals(v0[idx], v1[idx], v2[idx], dv0, dv1, dv2, dv0dv1, dv0dv2);
    var B = intervals(u0[idx], u1[idx], u2[idx], du0, du1, du2, du0du1, du0du2);
    if (!A || !B) return false;

    var xx = A[3] * A[4], yy = B[3] * B[4], xxyy = xx * yy;
    var i0 = A[0] * xxyy + A[1] * A[4] * yy, i1 = A[0] * xxyy + A[2] * A[3] * yy;
    var j0 = B[0] * xxyy + B[1] * B[4] * xx, j1 = B[0] * xxyy + B[2] * B[3] * xx;
    var lo1 = Math.min(i0, i1), hi1 = Math.max(i0, i1), lo2 = Math.min(j0, j1), hi2 = Math.max(j0, j1);
    return !(hi1 < lo2 || hi2 < lo1);
  }

  /* ---------- point queries against a BVH (all in that BVH's frame) ---------- */
  var RAY_DIR = new THREE.Vector3(0.3, 0.72, 0.6).normalize();
  var _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
  var _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _p = new THREE.Vector3(), _t = new THREE.Vector3(), _q = new THREE.Vector3();
  function loadTri(bvh, i) {
    var o = bvh.order[i] * 9, tr = bvh.tris;
    _a.set(tr[o], tr[o + 1], tr[o + 2]); _b.set(tr[o + 3], tr[o + 4], tr[o + 5]); _c.set(tr[o + 6], tr[o + 7], tr[o + 8]);
  }
  function rayHitsTri(origin, dir) { // Moller-Trumbore, t > 0, tolerant of edge hits
    _e1.subVectors(_b, _a); _e2.subVectors(_c, _a);
    _p.crossVectors(dir, _e2);
    var det = _e1.dot(_p);
    if (Math.abs(det) < 1e-12) return false;
    var inv = 1 / det;
    _t.subVectors(origin, _a);
    var u = _t.dot(_p) * inv;
    if (u < 0 || u > 1) return false;
    _q.crossVectors(_t, _e1);
    var v = dir.dot(_q) * inv;
    if (v < 0 || u + v > 1) return false;
    return _e2.dot(_q) * inv > 1e-9;
  }
  function rayBox(o, d, node) {
    var tmin = -Infinity, tmax = Infinity;
    for (var k = 0; k < 3; k++) {
      var oc = k === 0 ? o.x : (k === 1 ? o.y : o.z), dc = k === 0 ? d.x : (k === 1 ? d.y : d.z);
      if (Math.abs(dc) < 1e-12) { if (oc < node.min[k] || oc > node.max[k]) return false; continue; }
      var t1 = (node.min[k] - oc) / dc, t2 = (node.max[k] - oc) / dc;
      if (t1 > t2) { var tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax || tmax < 0) return false;
    }
    return true;
  }
  function countCrossings(bvh, node, o, d) {
    if (!rayBox(o, d, node)) return 0;
    if (!node.l) {
      var c = 0;
      for (var i = node.start; i < node.start + node.count; i++) { loadTri(bvh, i); if (rayHitsTri(o, d)) c++; }
      return c;
    }
    return countCrossings(bvh, node.l, o, d) + countCrossings(bvh, node.r, o, d);
  }
  function inside(bvh, p) { return (countCrossings(bvh, bvh.root, p, RAY_DIR) & 1) === 1; }

  var _cp = new THREE.Vector3(), _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _ap = new THREE.Vector3(), _bp = new THREE.Vector3(), _cpv = new THREE.Vector3();
  function closestOnTri(p, out) { // Ericson, Real-Time Collision Detection 5.1.5
    _ab.subVectors(_b, _a); _ac.subVectors(_c, _a); _ap.subVectors(p, _a);
    var d1 = _ab.dot(_ap), d2 = _ac.dot(_ap);
    if (d1 <= 0 && d2 <= 0) return out.copy(_a);
    _bp.subVectors(p, _b);
    var d3 = _ab.dot(_bp), d4 = _ac.dot(_bp);
    if (d3 >= 0 && d4 <= d3) return out.copy(_b);
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return out.copy(_a).addScaledVector(_ab, d1 / (d1 - d3));
    _cpv.subVectors(p, _c);
    var d5 = _ab.dot(_cpv), d6 = _ac.dot(_cpv);
    if (d6 >= 0 && d5 <= d6) return out.copy(_c);
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return out.copy(_a).addScaledVector(_ac, d2 / (d2 - d6));
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return out.copy(_b).addScaledVector(_cpv.subVectors(_c, _b), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
    var denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
    return out.copy(_a).addScaledVector(_ab, v).addScaledVector(_ac, w);
  }
  function boxDist2(p, node) {
    var d = 0, k, v, c;
    for (k = 0; k < 3; k++) {
      c = k === 0 ? p.x : (k === 1 ? p.y : p.z);
      v = c < node.min[k] ? node.min[k] - c : (c > node.max[k] ? c - node.max[k] : 0);
      d += v * v;
    }
    return d;
  }
  function nearest2(bvh, node, p, best) {
    if (boxDist2(p, node) >= best) return best;
    if (!node.l) {
      for (var i = node.start; i < node.start + node.count; i++) {
        loadTri(bvh, i);
        var d2 = closestOnTri(p, _cp).distanceToSquared(p);
        if (d2 < best) best = d2;
      }
      return best;
    }
    var dl = boxDist2(p, node.l), dr = boxDist2(p, node.r);
    if (dl < dr) { best = nearest2(bvh, node.l, p, best); return nearest2(bvh, node.r, p, best); }
    best = nearest2(bvh, node.r, p, best);
    return nearest2(bvh, node.l, p, best);
  }
  function depthInto(bvh, p) { // how far p sits inside the solid; 0 when outside
    if (!inside(bvh, p)) return 0;
    return Math.sqrt(nearest2(bvh, bvh.root, p, Infinity));
  }

  /* ---------- BVH pair traversal: A's tree expressed in B's frame ---------- */
  var tmpV = new THREE.Vector3();
  function boxToFrame(node, M) {
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < 8; i++) {
      tmpV.set(i & 1 ? node.max[0] : node.min[0], i & 2 ? node.max[1] : node.min[1], i & 4 ? node.max[2] : node.min[2])
        .applyMatrix4(M);
      if (tmpV.x < mn[0]) mn[0] = tmpV.x; if (tmpV.x > mx[0]) mx[0] = tmpV.x;
      if (tmpV.y < mn[1]) mn[1] = tmpV.y; if (tmpV.y > mx[1]) mx[1] = tmpV.y;
      if (tmpV.z < mn[2]) mn[2] = tmpV.z; if (tmpV.z > mx[2]) mx[2] = tmpV.z;
    }
    return { min: mn, max: mx };
  }
  function overlaps(a, b) {
    return a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
      a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
      a.min[2] <= b.max[2] && a.max[2] >= b.min[2];
  }
  function triAt(bvh, i, M, out) {
    var o = bvh.order[i] * 9;
    for (var k = 0; k < 3; k++) {
      tmpV.set(bvh.tris[o + k * 3], bvh.tris[o + k * 3 + 1], bvh.tris[o + k * 3 + 2]);
      if (M) tmpV.applyMatrix4(M);
      out[k][0] = tmpV.x; out[k][1] = tmpV.y; out[k][2] = tmpV.z;
    }
  }
  var TA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], TB = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  var MAX_CANDIDATES = 24;
  function leavesHit(ba, na, bb, nb, M, out) {
    for (var i = na.start; i < na.start + na.count; i++) {
      triAt(ba, i, M, TA);
      for (var j = nb.start; j < nb.start + nb.count; j++) {
        triAt(bb, j, null, TB);
        if (triTri(TA[0], TA[1], TA[2], TB[0], TB[1], TB[2])) {
          out.push([i, j]);
          if (out.length >= MAX_CANDIDATES) return;
        }
      }
    }
  }
  function traverse(ba, na, bb, nb, M, out) {
    if (out.length >= MAX_CANDIDATES) return;
    if (!overlaps(boxToFrame(na, M), nb)) return;
    var leafA = !na.l, leafB = !nb.l;
    if (leafA && leafB) { leavesHit(ba, na, bb, nb, M, out); return; }
    var sizeA = (na.max[0] - na.min[0]) + (na.max[1] - na.min[1]) + (na.max[2] - na.min[2]);
    var sizeB = (nb.max[0] - nb.min[0]) + (nb.max[1] - nb.min[1]) + (nb.max[2] - nb.min[2]);
    if (leafB || (!leafA && sizeA > sizeB)) {
      traverse(ba, na.l, bb, nb, M, out); traverse(ba, na.r, bb, nb, M, out);
    } else {
      traverse(ba, na, bb, nb.l, M, out); traverse(ba, na, bb, nb.r, M, out);
    }
  }

  /* Points spread over a triangle (in the frame it is given in). */
  var SAMPLES = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [1 / 3, 1 / 3, 1 / 3],
    [0.75, 0.25, 0], [0.25, 0.75, 0], [0, 0.75, 0.25], [0, 0.25, 0.75], [0.75, 0, 0.25], [0.25, 0, 0.75]];
  function maxDepthOfTri(tri, bvh) {
    var best = 0, p = new THREE.Vector3();
    for (var s = 0; s < SAMPLES.length; s++) {
      var w = SAMPLES[s];
      p.set(tri[0][0] * w[0] + tri[1][0] * w[1] + tri[2][0] * w[2],
        tri[0][1] * w[0] + tri[1][1] * w[1] + tri[2][1] * w[2],
        tri[0][2] * w[0] + tri[1][2] * w[1] + tri[2][2] * w[2]);
      var d = depthInto(bvh, p);
      if (d > best) best = d;
    }
    return best;
  }

  /* How far one triangle reaches past the other's plane, on the side it reaches least: for two
   * surfaces that cross at a shallow interpenetration this is that interpenetration; for a shaft
   * pushed through a plate it is the shorter overshoot. Taken over both triangles. */
  function planeReach(t, u) {
    var n = cross(sub(u[1], u[0]), sub(u[2], u[0]));
    var len = Math.sqrt(dot(n, n));
    if (len < 1e-12) return Infinity;
    var pos = 0, neg = 0;
    for (var k = 0; k < 3; k++) {
      var d = dot(n, sub(t[k], u[0])) / len;
      if (d > pos) pos = d;
      if (-d > neg) neg = -d;
    }
    return Math.min(pos, neg);
  }
  function crossingDepth(tA, tB) {
    return Math.min(planeReach(tA, tB), planeReach(tB, tA));
  }

  var invB = new THREE.Matrix4(), invA = new THREE.Matrix4(), MAB = new THREE.Matrix4(), MBA = new THREE.Matrix4();
  /* Deepest interpenetration between parts a and b, in scene units (0 = none). Surfaces that merely
   * cross within DEPTH_TOL (touching parts, CAD undersize) do not count. */
  function penetration(a, b) {
    var ba = bvhOf(a), bb = bvhOf(b);
    if (!ba.root || !bb.root) return 0;
    invB.copy(b.matrixWorld).invert(); MAB.multiplyMatrices(invB, a.matrixWorld);
    invA.copy(a.matrixWorld).invert(); MBA.multiplyMatrices(invA, b.matrixWorld);
    var cand = [];
    traverse(ba, ba.root, bb, bb.root, MAB, cand);
    if (!cand.length) return 0;
    var worst = 0;
    var tA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], tB = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    var tBinB = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var i = 0; i < cand.length; i++) {
      triAt(ba, cand[i][0], MAB, tA);          // a's triangle in b's frame
      triAt(bb, cand[i][1], null, tBinB);      // b's triangle in b's frame
      var d = crossingDepth(tA, tBinB);
      if (d > worst) worst = d;
      d = maxDepthOfTri(tA, bb);               // sampled points of a's triangle inside b
      if (d > worst) worst = d;
      triAt(bb, cand[i][1], MBA, tB);          // b's triangle in a's frame → inside a
      d = maxDepthOfTri(tB, ba);
      if (d > worst) worst = d;
    }
    return worst;
  }

  /* ---------- parts ---------- */
  function partsUnder(node) {
    var out = [];
    node.traverse(function (o) { if (KB.isPart(o)) out.push(o); });
    return out;
  }
  function isUnder(o, node) {
    for (var q = o; q; q = q.parent) if (q === node) return true;
    return false;
  }
  function worldBox(part) {
    part.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(part);
  }

  /* A peg of one part lined up with a hole of the other that it cannot enter, overlapping along the
   * axis — unless some other feature of the peg's part fits that hole (a screw head sits over the
   * hole its shaft is in). Peg-on-peg is left to the mesh detector: a part whose hole is not in
   * PartTypeFeatures would otherwise flag every screw passing through it. */
  function coaxial(a, b) {
    if (Math.abs(a.d.dot(b.d)) < AXIS_COS) return null;
    var v = a.c.clone().sub(b.c);
    var along = v.dot(b.d);
    var perp = v.addScaledVector(b.d, -along).length();
    if (perp > 1.5 * unitsPerMm()) return null;
    return { along: along, perp: perp };
  }
  function pegHoleHit(pegs, holes) {
    var tol = 0.3 * unitsPerMm(), margin = OVERLAP_MARGIN_MM * unitsPerMm();
    for (var j = 0; j < holes.length; j++) {
      var hole = holes[j], bad = null, fits = false;
      for (var i = 0; i < pegs.length; i++) {
        var peg = pegs[i], cx = coaxial(peg, hole);
        if (!cx) continue;
        if (peg.r <= hole.r + tol) { fits = true; break; }
        if (Math.abs(cx.along) < (peg.depth + hole.depth) / 2 - margin) bad = peg;
      }
      if (bad && !fits) return { peg: bad, hole: hole };
    }
    return null;
  }
  /* Some peg of one part sits in a compatible hole of the other: the pair is assembled as intended
   * (screw in its hole, nut on its shaft) and mesh detail — decimated motors, animation poses a
   * millimetre off — must not turn that into a collision. */
  function engaged(fa, fb) {
    var tol = 0.3 * unitsPerMm();
    function pegIn(pegs, holes) {
      for (var i = 0; i < pegs.length; i++) for (var j = 0; j < holes.length; j++) {
        var cx = coaxial(pegs[i], holes[j]);
        if (cx && pegs[i].r <= holes[j].r + tol && Math.abs(cx.along) < (pegs[i].depth + holes[j].depth) / 2) return true;
      }
      return false;
    }
    var pegsA = fa.axes.filter(function (f) { return f.kind === 'peg'; }), holesA = fa.axes.filter(function (f) { return f.kind === 'hole'; });
    var pegsB = fb.axes.filter(function (f) { return f.kind === 'peg'; }), holesB = fb.axes.filter(function (f) { return f.kind === 'hole'; });
    return pegIn(pegsA, holesB) || pegIn(pegsB, holesA);
  }
  function featureHit(fa, fb) {
    var pegsA = fa.axes.filter(function (f) { return f.kind === 'peg'; }), holesA = fa.axes.filter(function (f) { return f.kind === 'hole'; });
    var pegsB = fb.axes.filter(function (f) { return f.kind === 'peg'; }), holesB = fb.axes.filter(function (f) { return f.kind === 'hole'; });
    var h = pegHoleHit(pegsA, holesB);
    if (h) return { a: h.peg.id, b: h.hole.id };
    h = pegHoleHit(pegsB, holesA);
    if (h) return { a: h.hole.id, b: h.peg.id };
    return null;
  }

  /* ---------- session ---------- */
  var session = null;      // { node, moving: [parts], statics: [{part, box, feats}] }
  var colliding = {};      // pair key → { a, b, kind }
  var tinted = [];
  var lastTest = 0;

  function keyOf(a, b) { return a.uuid + '|' + b.uuid; }
  function tint(part, on) {
    part.traverse(function (o) {
      if (!o.isMesh || !o.material || !o.material.emissive) return;
      if (on) {
        if (!o.userData.kbCollideSaved) {
          o.userData.kbCollideSaved = { e: o.material.emissive.getHex(), i: o.material.emissiveIntensity };
        }
        o.material.emissive.set(TINT); o.material.emissiveIntensity = 0.7;
      } else if (o.userData.kbCollideSaved) {
        o.material.emissive.set(o.userData.kbCollideSaved.e);
        o.material.emissiveIntensity = o.userData.kbCollideSaved.i;
        delete o.userData.kbCollideSaved;
      }
    });
  }
  function clearTints() {
    tinted.forEach(function (p) { tint(p, false); });
    tinted = [];
  }

  function begin(node) {
    clearTints();
    colliding = {};
    var moving = partsUnder(node);
    var statics = [];
    KB.objectsRoot.updateMatrixWorld(true);
    KB.objectsRoot.traverse(function (o) {
      if (!KB.isPart(o) || isUnder(o, node) || o.userData.kbPending) return;
      statics.push({ part: o, box: worldBox(o), feats: window.KBSnap ? KBSnap.features(o) : null });
    });
    session = { node: node, moving: moving, statics: statics };
  }

  /* The two parts sit within tolerance of their relative pose in the reference assembly (the
   * checker's judgement): whatever the meshes do there is the reference data's business — the
   * animation poses and decimated meshes interpenetrate by a millimetre or more in places. */
  function assembledPerReference(a, b, judged) {
    if (!window.KBCheck) return false;
    if (!judged.done) { judged.done = true; judged.res = KBCheck.evaluate(); }
    if (!judged.res || !judged.res.ready) return false;
    function matesOk(x, y) {
      var sx = KBCheck.slotOf(x);
      if (!sx || !sx.ok) return false;
      return sx.near.some(function (n) { return n.ms.part && n.ms.part.node === y; });
    }
    return matesOk(a, b) || matesOk(b, a);
  }

  function test(node) {
    if (!session || session.node !== node) begin(node);
    var hits = [];
    var now = {};
    var judged = { done: false, res: null };
    session.moving.forEach(function (a) {
      if (a.userData.kbPending) return;
      var boxA = worldBox(a);
      var fa = window.KBSnap ? KBSnap.features(a) : null;
      session.statics.forEach(function (s) {
        if (!boxA.intersectsBox(s.box)) return;
        var hit = null;
        var fh = fa && s.feats ? featureHit(fa, s.feats) : null;
        if (fh) hit = { a: a, b: s.part, kind: 'feature', snapPoint1: fh.a, snapPoint2: fh.b };
        if (!hit && !(EXEMPT_ENGAGED && fa && s.feats && engaged(fa, s.feats))) {
          var depth = penetration(a, s.part);
          if (depth > DEPTH_TOL_MM * unitsPerMm() && !assembledPerReference(a, s.part, judged)) {
            hit = { a: a, b: s.part, kind: 'mesh', snapPoint1: null, snapPoint2: null, depthMm: depth / unitsPerMm() };
          }
        }
        if (hit) { now[keyOf(a, s.part)] = hit; hits.push(hit); }
      });
    });
    // tint / untint and emit on entry
    clearTints();
    Object.keys(now).forEach(function (k) {
      var h = now[k];
      tint(h.a, true); tint(h.b, true);
      tinted.push(h.a, h.b);
      if (!colliding[k]) {
        KB.emit('collision', { object1: h.a, object2: h.b, kind: h.kind, snapPoint1: h.snapPoint1, snapPoint2: h.snapPoint2,
          depthMm: h.depthMm !== undefined ? Math.round(h.depthMm * 100) / 100 : undefined });
      }
    });
    colliding = now;
    return hits;
  }

  KB.on('grab', function (node) { if (!KB.interacting()) begin(node); });
  KB.on('move', function (node) {
    if (KB.interacting()) return;
    var t = performance.now();
    if (t - lastTest < TEST_GAP_MS) return;
    lastTest = t;
    test(node);
  });
  KB.on('place', function (node) {
    session = null;
    test(node);
    session = null;
  });

  window.KBCollide = {
    test: test,
    penetration: penetration,
    depthTol: function (mm) { if (mm !== undefined) DEPTH_TOL_MM = mm; return DEPTH_TOL_MM; },
    exemptEngaged: function (on) { if (on !== undefined) EXEMPT_ENGAGED = !!on; return EXEMPT_ENGAGED; },
    engaged: function (a, b) { return engaged(KBSnap.features(a), KBSnap.features(b)); },
    triTri: triTri,
    colliding: function () { return Object.keys(colliding).map(function (k) { return colliding[k]; }); }
  };
})();
