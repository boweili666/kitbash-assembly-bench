# Kitbash Assembly Bench — Explainer

> A web-based 3D assembly workbench: practice assembling a real drone frame
> with auto-labeled holes, magnetic assembly snapping, and a ghost "answer"
> animation. Repo: https://github.com/boweili666/kitbash-assembly-bench

---

## 1. What it is

Kitbash Assembly Bench is a pure-frontend (three.js) 3D assembly interface.
The scene holds the complete 24-part kit of the **Lumenier QAV-S 2 Joshua
Bardwell SE** frame bottom assembly — four 5-inch carbon arms, front/rear
plates, the aluminum X-Lock, two arm wedges, four knurled standoffs, and
thirteen M3 screws. Part types and quantities come straight from the BOM of
the aristos assembly task graph.

You can:

- Drag parts directly with the mouse; hold **Ctrl** for **magnetic assembly
  snapping** (face-to-face, peg-in-hole)
- Press **Answer** to play a translucent ghost animation of the reference
  assembly — parts fly in along their real insertion paths, in real step order
- Export the result as **GLB** (Blender / game engines) or **JSON**
  (re-importable)

Three things worth emphasizing: **holes are auto-detected from mesh
geometry**; **snapping enforces real assembly constraints** (a peg in a hole
can only slide along its axis); and **the answer animation comes from the
assembly graph's original 3D path data**, not hand-placed poses.

## 2. Quick start

| Goal | How |
| --- | --- |
| Load parts | Topbar **Kit** (the full 24-part kit) |
| See the answer | Topbar **Answer** → play / speed / click step nodes / drag the bar |
| Select | Click a part; Shift+click multi-select; Esc to clear |
| Move | Drag the part directly (ground plane); Shift+drag = raise/lower |
| Gizmo | W / E / R = move / rotate / scale; Q toggles World/Local |
| **Assembly snap** | **Hold Ctrl** while dragging: holes center onto axes, faces mate flush; pull away to detach |
| Rotate around a hole | With a part seated on a hole, hold Ctrl: the pivot jumps to the hole (Y along its axis); drag the E ring to hinge around it |
| Grid snap | V or topbar Snap: move 0.25 / rotate 15° / scale 0.1 |
| Group | Ctrl+G / Ctrl+Shift+G; duplicate Ctrl+D; delete Del |
| Undo | Ctrl+Z / Ctrl+Shift+Z (60-step snapshots) |
| Save | Auto-saved to localStorage; JSON export re-imports; GLB export |

Typical flow: stand a standoff upright → Ctrl-drag the rear plate onto its
axis → Ctrl+E to hinge the plate around that hole and line up a second hole
→ seat a second standoff → turn a screw vertical, Ctrl-snap it into a hole,
Ctrl+Shift-drag to push it in → Ctrl+G to group the finished subassembly.

## 3. Architecture

```
aristos project (data)                  Editor (pure frontend, three.js r147 UMD)
┌─────────────────────────┐             ┌────────────────────────────────────┐
│ 3d_model/*.glb  10 parts │──┐          │ app.js    scene/selection/undo/IO  │
│ task graph BOM  24 inst. │  │ tools/   │ snap.js   assembly snap + dragging │
│ step_3d_paths   77 steps │  ├────────▶ │ parts.js  part loading + labels    │
└─────────────────────────┘  │          │ answer.js answer timeline          │
                             │          └────────────────────────────────────┘
              label_holes.py │ generates            ▲
              (hole labeling)▼                      │ build.py embeds (base64)
                  assets/parts/manifest.json ───────┘
                  assets/parts/answer_poses.json       → dist/ single file 2.3MB
```

- **Zero-dependency runtime**: three.js and all part data are bundled into a
  single HTML file (`dist/kitbash-standalone.html`) that runs from `file://`.
  The dev entry (`index.html`) needs `python3 serve.py`.
- Modules cooperate through a tiny `window.KB / KBSnap / KBParts / KBAnswer`
  surface — no framework, no build chain.

## 4. Automatic hole labeling (tools/label_holes.py)

The source GLBs carry no hole metadata. The labeling script detects
cylindrical features straight from the triangle mesh:

1. **Candidate axes**: bounding-box axes + PCA principal axes.
2. **Barrel filter**: triangles whose normals are roughly perpendicular to a
   candidate axis (|n·d| < 0.5, loose enough to tolerate threads).
3. **Adjacency clustering**: connected components over shared edges (≥12
   faces).
4. **Circle fit**: project cluster centroids onto the perpendicular plane and
   run a Kasa least-squares fit; keep clusters with relative residual < 0.20,
   arc coverage ≥ 240°, and radial spread < 0.5 r.
5. **Hole vs. peg**: normals pointing toward the axis = hole (H1…Hn); away =
   peg (P1…Pn).
6. **Solid-of-revolution fallback**: low-poly screw threads shatter the
   adjacency clusters — fall back to "all barrel points share one axis",
   band the points by radius, fit each band, and keep only the dominant
   direction (by max feature depth) to kill phantom side-view cylinders.

Results: rear plate 18 holes ⌀3.0, X-Lock 10, front plate 7 (⌀2.6–3.0), one
hole each on arms and wedges, and a ⌀3.0 shaft + ⌀5.5 head per screw. All
coordinates are converted to editor units (global unitScale ≈ 24.77 per
meter; parts keep their true relative sizes) and written to `manifest.json`.
Selecting a part renders amber rings + H labels on its holes, blue on pegs.

## 5. Assembly snapping (src/snap.js)

Every part carries two kinds of snap features in world space: **axes** from
its holes/pegs (center + direction + radius) and the six **faces** of its
bounding box (center + normal). While dragging with **Ctrl** held, the solver
runs each frame:

- **Axis-to-axis** (peg-in-hole / hole-on-hole): when two axes are within 20°
  and 0.32 units of perpendicular offset, apply a small rotation correction
  and remove the offset → the axes become collinear. The along-axis component
  is preserved, so continued dragging naturally degenerates to *sliding along
  the hole axis*. A radius-match bonus makes a ⌀3 shaft prefer a ⌀3 hole over
  a nearby larger one.
- **Face-to-face**: normals opposed (dot < −0.90) and gap < 0.30 → mate
  flush; the in-plane component stays free, so the part slides on the mating
  surface.
- **Hysteresis**: tight engage, loose release thresholds (0.32 / 0.55), and
  the release check re-validates *only the pair that originally engaged* — an
  18-hole plate can't be kept captive by its other holes; dragging across a
  hole field ratchets hole-to-hole.
- **No hole-hopping while rotating**: during a rotate drag the solver only
  maintains the existing constraint and never acquires a new one.

**Ctrl gating and the hinge pivot**: with Ctrl released everything moves
freely. While Ctrl is held and the part sits coaxial with another part's
axis, the transform pivot jumps to the hole, its Y axis aligns with the hole
axis, and the gizmo switches to Local — the Y arrow is insertion/extraction,
the Y ring is hinge rotation around the hole. Releasing Ctrl restores the
pivot to the part origin. The same solver serves both direct dragging and
gizmo dragging.

## 6. The answer animation (src/answer.js)

The data chain starts from aristos' `step_3d_paths.json` (per-step 3D paths
of the assembly graph: millimeters + three.js XYZ Euler angles, keyed by part
instance UUIDs):

1. Each part's **last pose** = its installed pose; ordering parts by "the step
   in which the pose last changed" yields the **21 installation steps** with
   their names.
2. Within each part's installation step, the **approach/insertion waypoints
   just before the endpoint** are kept (staging-tray points discarded) —
   wedges slide in sideways, M3×22 screws come down from above, the rear
   plate mates upward from below; every direction comes from the source data.
3. Coordinate conversion `t = R·(offset·S) + t_mm·k` compensates the parts'
   rebasing and unit scaling; the whole assembly is recentered and hovers
   1.35 units above the scene.
4. Data erratum: M3×22 #2/#3 share a duplicated UUID in the task graph, so
   the missing screw is filled in by mirror symmetry.

The player renders translucent cyan ghosts (unselectable, not snappable, and
excluded from undo/export), flying each part along its trajectory (arc-length
interpolation over the polyline, quaternion slerp for orientation). The
control bar offers play/pause, 0.5–2× speed, a clickable/scrubbable progress
bar, and 21 step nodes — click one to jump to that step's completed state;
hover shows the step name and its parts.

## 6.5 Failure detection (src/check.js + snap.js)

No physics simulation — the user's assembly is compared slot by slot against the reference; every rule is demoable:

| Rule | Basis | What you see |
| --- | --- | --- |
| Wrong hole / position | align the reference assembly to the user's X-Lock (assembly starts there); match same-type parts to slots by global nearest error (identical parts are interchangeable); each part's rotational symmetries (auto-detected by the labeler: wedge z180, plates z180, standoff multiple) make symmetric-equivalent poses count as the same pose | "M3×22 1 is in the wrong hole / position: off by 12.4 mm" |
| Wrong part | an empty slot occupied by another part of the same family (screw↔screw, front↔rear plate) | "Wrong part at M3×22 1's slot: found M3×16 1" |
| Screw inserted backwards | compare the signed shaft→head vector with the reference | "M3×22 1 is inserted backwards — the head faces the wrong way" |
| Assembly order | hard dependencies rear plate → arms → front plate | "Out of order: Front Plate placed before Arm 1" |
| Completion score | slots within 3.2 mm, 12°, and correctly oriented, out of 24 | panel progress bar |

For this the labeler recomputes each feature's **axial extent** from all vertices in a radial band (not the
centroid span of the clustered faces), and excludes the Phillips-recess vertices that fall inside the head's
extent when measuring shafts — giving 22/16/6 mm shafts, 3 mm heads, 20 mm standoffs and 2 mm plates,
which keeps the slot comparison millimetre-accurate.

## 7. Other implementation notes

- **Undo**: snapshot-based — the whole scene is serialized after every
  operation into a 60-deep stack; the same JSON doubles as localStorage
  autosave and the import/export format.
- **Part instancing**: GLB geometry is baked (node transforms → vertices,
  then the normalization transform) and shared across instances; materials
  are cloned per instance (recolorable, with one-click reset).
- **Multi-select / hinge pivots**: selected nodes are temporarily reparented
  under a pivot group for unified transforms, then "baked" back — one
  mechanism serves both cases.
- **Reset Transform**: one click zeroes rotation, resets scale, and settles
  the part on the ground (keeping X/Z).
- **Testing**: headless Playwright regressions — the four snap scenarios
  (mate / center / slide / detach), screw-in-hole precision (zero offset),
  hinge rotation at 15°-per-frame with zero drift, BOM count verification,
  and save/restore round-trips.

## 8. Known limits & next steps

- Snapping corrects position and small orientation errors only: axes more
  than 20° apart won't engage (use the 15° grid snap to pre-orient).
- Collisions are handled only along hole axes (peg / hole / head / barrel
  extents); parts can still interpenetrate sideways — full collision needs a
  physics engine.
- The arms' oblong slots are not circles and are currently not detected.
- Possible next steps: a guided step mode (highlight only the parts for the
  current step), feeding Checks results to the agent for natural-language
  coaching, full collision (Rapier + convex decomposition), multi-user
  collaboration, and a mobile layout.

---

*Stack: three.js r147 (UMD) · vanilla JS (no framework) · Python
(trimesh/numpy for offline labeling). Data: the aristos project (Lumenier
QAV-S 2 frame GLBs + assembly task graph + step 3D paths).*
