# Hand-off: building the ARISTOS side of the simulator

For the engineer who will wire the assembly simulator into ARISTOS. The
simulator itself is finished and does not need to change for this work; what is
missing is on the ARISTOS side — turning the events it already emits into
tutor behaviour, and deciding how a simulated session is stored.

Read [`ARISTOS_INTEGRATION.md`](ARISTOS_INTEGRATION.md) first for the *why* and
the interface reference. This document is the *to-do*: what exists, what you
have to build, how to run it, and the traps we already fell into.

---

## 0. Where things live

Paths as checked out on the machine this was written on; adjust the root, the
layout inside each repo is what matters.

| what | path | git |
| --- | --- | --- |
| this repo (the simulator) | `~/moonshot/3d_interaction` | — |
| ARISTOS | `~/moonshot/aristos` | `git@gitlab.com:cmu_aart/moonshot_reskilling/aristos.git`, branch `dana/integration` |
| ARISTOS frontend (where you will work) | `~/moonshot/aristos/external/aristos_frontend` | `git@gitlab.com:cmu_aart/moonshot_reskilling/aristos_frontend.git`, branch **`bowei/simulator-steps`** |
| task graph database | `~/moonshot/aristos/data/ARISTOS-Data/task_graphs.db` | |
| part models (GLB, named by model UUID) | `~/moonshot/aristos/data/ARISTOS-Data/media/models` (38 files) | |
| the simulator page the frontend serves | `aristos_frontend/public/simulator/kitbash-standalone.html` | build artifact — see §2 |

Inside `aristos_frontend`, the simulator lives in:

```
src/components/Simulator/Simulator.tsx             the component (mirror of integration/react/Simulator.tsx)
src/components/Simulator/SimulatorTraineeView.tsx  host stub; every callback is a prop with a no-op default
src/components/Simulator/SimulatorStage.tsx        where the pane sits in the session layout
src/components/Simulator/kit_scene.ts              82-part initialScene generated from task_graphs.db
src/components/AristosSession/TraineeCam.tsx       the Real / Sim toggle
src/config.ts                                      SIMULATOR_URL (override with VITE_SIMULATOR_URL)
public/simulator/kitbash-standalone.html           the page itself
```

The `.tsx` files in `integration/react/` of this repo are the source of truth
for the component; the copies in `aristos_frontend` are kept identical.

Pipeline commands in §5 are written relative to this repo with the database and
models copied next to them; with the paths above they read, for example:

```sh
python3 tools/features_db.py manifest \
        ~/moonshot/aristos/data/ARISTOS-Data/task_graphs.db \
        ~/moonshot/aristos/data/ARISTOS-Data/media/models \
        --kit kit.json --answer answer.json --copy-glb --out assets/parts/manifest.json
```

---

## 1. Where the line is drawn

```
  ARISTOS frontend                    simulator (this repo)
  ┌──────────────────────┐            ┌──────────────────────────────┐
  │ TraineeCam           │  postMessage│ index.html?bridge=1&embed=1  │
  │  └ SimulatorTraineeView ◄─────────► │  three.js scene, part library│
  │      └ <Simulator/>  │  (iframe)   │  mate / checks / answer       │
  └──────────┬───────────┘            └──────────────────────────────┘
             │ session-video-frame (unchanged)
             ▼
        ARISTOS backend
```

The simulator is a **page**, not a library. The React component is a thin
iframe wrapper that speaks a small postMessage protocol. It knows nothing about
ARISTOS: no auth, no session store, no chat.

**Already connected on branch `bowei/simulator-steps` of `aristos_frontend`:**
frames. Switching the trainee view to *Sim* unmounts the webcam and pipes the
simulator's 10 fps JPEGs through the existing `sendFrame`, so the backend sees
simulated sessions as camera sessions with no change.

**Not connected — your job:** every other callback. They fire correctly today
and land in no-op props.

---

## 2. Run it in five minutes

```sh
# simulator, dev mode (loads src/*.js live, no build step)
cd 3d_interaction && python3 serve.py          # → http://localhost:8123/index.html

# the React component with a live event log
cd integration/react/demo && npm i && npm run dev
```

In the ARISTOS frontend the page is served same-origin from
`public/simulator/kitbash-standalone.html`; `VITE_SIMULATOR_URL` overrides it.

**Refresh that copy whenever you pull this repo.** It is a build artifact, not
a symlink, and it goes stale silently:

```sh
python3 build.py && cp dist/kitbash-standalone.html \
  ~/moonshot/aristos/external/aristos_frontend/public/simulator/kitbash-standalone.html
```

Every page prints `Kitbash build <timestamp>` in the console and answers
`KB.build()`; the dev server answers `dev`. When a bug report does not match
the code, check this first — we lost an afternoon to a stale copy.

---

## 3. The protocol (what you will actually code against)

`?bridge=1` turns it on. The component does this for you; use the raw protocol
only if you embed without React.

### Host → simulator

| message | effect |
| --- | --- |
| `kb:init {scene, options}` | load the scene, start frames. `options`: `frames, fps, width, quality, moveHz` |
| `kb:setScene {scene}` | replace the scene (resume a session mid-way) |
| `kb:getScene` | → `kb:scene` |
| `kb:getState` | → `kb:state` |
| `kb:showNext` / `kb:showStep {step}` / `kb:hideAnswer` | looping ghost of a step **on the trainee's current build** |
| `kb:highlight {id, color\|null}` | tint one part ("this one") |
| `kb:fuse {parentId, childId}` / `kb:unfuse {childId}` | make two parts move as one once a step is confirmed |
| `kb:startFrames` / `kb:stopFrames` | |

### Simulator → host

| message | when |
| --- | --- |
| `kb:ready {protocol, keys}` | part library loaded — wait for it before `kb:init` (the component does) |
| `kb:grab / kb:move / kb:place {id, name, key, pose}` | trainee picked up / is dragging (≤ `moveHz`) / put down |
| `kb:frame {image, t}` | JPEG data URL, default 10 Hz |
| `kb:scene {parts}` | answer to `kb:getScene` |
| `kb:state {state, lastPlace?}` | after every place — the simulator's own judgement of the build |
| `kb:snapAttempt {object1, object2, snapPoint1, snapPoint2, success, reason}` | two features were lined up; `success:false` = geometrically impossible and refused |
| `kb:collision {object1, object2, kind, depthMm, snapPoint1, snapPoint2}` | parts interpenetrating > 1 mm, or a peg lined up with a hole it cannot enter |
| `kb:warn {message}` | a scene part had no known model, etc. |

### Pose convention — identical to `Step3DPaths`

`{x, y, z, roll, pitch, yaw}`, **millimetres, Y up, XYZ Euler radians
(R = Rx·Ry·Rz), position of the GLB node origin** (not the bbox centre). A pose
that comes back from `onPlaceObject` can be compared with the graph's target
pose with no conversion. Round trip measured < 1e-4 mm.

`id` is the part-instance UUID you passed in (`Parts.uuid`), echoed unchanged.

---

## 4. What to build

Ordered by value. Acceptance criteria are what we would demo.

### 4.1 Persist the simulated session (blocking everything else)

Decide whether a simulated session is a flag on the session row or a separate
kind. The frames already arrive as `session-video-frame`; nothing marks them as
simulated. Until this exists, tutor behaviour cannot be replayed or audited.

*Done when:* a session can be reopened and shows it was simulated, and
`kb:setScene` restores the build the trainee left behind (use `getScene()`).

### 4.2 Feed step state into the tutor — `onStateChange`

This is the payoff. `state.steps[]` gives each task-graph step as
`complete | available | premature | blocked`, with `progress` and `requires`;
`state.parts[]` gives per-part `placed / ok / by`; `state.issues[]` gives
wrong-hole, reversed-screw, wrong-part and out-of-order findings with the
offending `objectId`; `state.next` is the step the simulator would propose.

Replace the hand-curated linear sequence with these. Suggested reactions:

| signal | tutor |
| --- | --- |
| `lastPlace.ok && lastPlace.fitsStep` | confirm the step, then `ref.fuse(mateId, partId)` so the sub-assembly moves as one |
| an `Out of order` issue | the trainee started a step whose prerequisites are unmet — intervene |
| `state.next` changed | propose the next step; `ref.showNext()` draws the ghost |
| `issues[].severity === 'error'` | reversed screw / wrong part — say it immediately |

*Done when:* a full drone-frame build can be completed with the tutor driven
only by `onStateChange`, no VQA in the loop.

### 4.3 Deterministic grab/place events — `onGrabObject` / `onPlaceObject`

Emit them to the backend (e.g. `session-sim-action {action, objectId, pose}`).
These are what a camera can only guess: *which* part, *where*, to the
millimetre. Cheapest useful behaviour: react to "you picked up the wrong screw"
on grab, before it is placed.

*Done when:* the event stream of a build is stored and can be replayed.

### 4.4 Snap and collision feedback — `onSnapAttempt` / `onCollision`

Both are already correct and unused. `snapAttempt` with `success:false` means
the trainee tried something geometrically impossible (peg on peg, peg wider
than the hole) — a teachable moment the camera path never sees. `collision`
means parts are being pushed through each other.

*Done when:* the tutor comments on a refused snap at most once per gesture.

### 4.5 Nice to have

- `ref.highlight(objectId, color)` when the tutor names a part.
- `ref.showStep(stepId)` when the trainee asks "show me again".
- Pop-out (`ref.popOut()`) for a second monitor — already works; decide whether
  the UI exposes it to trainees.

---

## 5. Data pipeline — regenerate when the task graph changes

Everything the simulator knows about the product comes from `task_graphs.db`;
no code change is needed for a new part type (its key is derived from its
name), but the manifest must be rebuilt.

```sh
python3 tools/features_db.py import   task_graphs.db part_features.json
python3 tools/scene_from_db.py        task_graphs.db --layout kit --models media/models --out kit.json
python3 tools/features_db.py answer   task_graphs.db media/models --out answer.json
python3 tools/features_db.py manifest task_graphs.db media/models \
        --kit kit.json --answer answer.json --copy-glb --out assets/parts/manifest.json
python3 build.py
```

- **Hole/peg features are contributor data**, not detected at run time — see
  [`FEATURE_SCHEMA.md`](FEATURE_SCHEMA.md). A part type with no features cannot
  be snapped; it can still be dragged.
- Holes the contributor file misses (slots, polygonal cut-outs) can be added in
  the simulator: Expert mode → Properties → Features → **Label**, then
  **Export** writes a contributor file to import back.
- Holes that exist in the *final assembly* but were never labelled can be
  derived from it: `python3 tools/holes_from_answer.py arm_5in --write` takes
  each partner's peg axis at its installed pose and measures the bore on the
  mesh. That is how the arm got its four motor-mount slots and the motor bore.
- `answer.json` (reference assembly: per-part approach → installed paths, step
  order, prerequisites) drives the Answer/Next ghosts **and** the Checks.

### The reference assembly is part captured, part derived

`task_graphs.db` holds 353 steps but only **52 of them carry `Step3DPaths`**, and
every one of those snapshots contains the same **53 parts** — the last one
(`End Frame, ESC, Motors, and FC Assembly`) included. Steps named
`Place Propeller on Motor Shaft (A–D)`, `Place Top Plate on Top of Frame`,
`Feed Screw through Top Plate and into Standoff (A–F)` and
`Place Left/Right Camera Plate` exist **with zero pose rows**. Per part type:
propellers 4 parts / 0 posed, top plate 1/0, camera plates 2/0, knurled standoff
6/**4**, M3×6 pan 9/**1**, M2 dampers 16/**4**.

So the kit has 82 parts while ARISTOS captured poses for 53. The remaining
positions are **computed from the parts' own hole/peg features** by

```sh
python3 tools/derive_final_assembly.py            # rewrites manifest.answer in place
python3 tools/derive_final_assembly.py --dry-run  # prints what it would add
```

which appends 21 parts / 19 steps (steps 27–45), each flagged `derived: true` on
both the step and the part, with `mates` wired in both directions so the checker
can judge them. It is re-runnable: it strips its own previous output first.
What it derives, and on what evidence:

Which part goes in which step is **not guessed** — `StepParts` in the task graph
names the exact part instance for every one of these steps, down to which screws
are pan and which are countersunk. The derivation follows it:

| part | how its pose is fixed |
| --- | --- |
| Top Plate | least-squares fit of its 6 holes onto the 6 standoff free ends (max residual 1.9 mm) |
| Standoff #5/#6 | the free M3 pair at the rear of the Split Rear Plate; attitude copied from the four captured standoffs |
| Standoff Screw #5/#6 | M3×6 pan, through the rear plate into each new standoff |
| Standoff Screw #7/#8 | M3×6 pan, through the top plate into standoffs A/B |
| Standoff Screw #9–#12 | M3×6 **countersunk**, through the top plate into standoffs C–F, head flush with the plate |
| Left/Right Camera Plate | standing between top plate and front plate, `H3` over the top plate's front hole pair, M2 camera holes facing the centreline |
| 4 × M3×6 pan | camera plates: one up through the top plate, one down through the front plate, into the same through-hole |
| 4 × Propeller | hub bore on the motor shaft axis, seated on the motor's outermost face |

That accounts for all nine M3×6 pan screws in the task graph exactly.

**The countersunk screw is modelled by us.** `PartTypes.model` for
`Screw - M3x6mm Countersunk` is the literal string `TODO_MODEL` — ARISTOS has no
mesh for it, so those four steps had no part at all. `tools/make_countersunk_screw.py`
turns one to ISO 10642 / DIN 7991 dimensions (Ø3 × 4.5 mm shank, 90° head Ø6 ×
1.5 mm, 6 mm overall, length measured over the head) and registers it in the
manifest as `screw_m3x6_countersunk` plus four kit instances. It is re-runnable.
If ARISTOS later ships the real mesh, drop it in and delete the generated one.
`aristos_frontend/src/components/Simulator/kit_scene.ts` carries the matching
four kit entries at the end of the array.

Two honest caveats:

- **The propeller seats on the motor's end face, not on a shaft.** In this model
  the shaft (`motor_2207` peg `P2`) lies entirely inside the bell, so there is no
  protruding shaft to slide a hub onto. The captured propeller-nut poses sit
  inside the bell too, so nothing overlaps and **no ARISTOS pose was modified**.
- **Which diagonal takes CW vs CCW is not in the data.** The steps are named but
  carry no part type, so `check.js` maps `propeller_ccw → propeller_cw` in `SAME`:
  either diagonal assignment passes, exactly as M3×16 cap/pan are interchangeable.

The 12 spare M2 dampers are still unplaced: they belong to the flight
controller, which has no model in the kit.

---

## 6. What the judgement actually guarantees

Read [`STEP_COMPLETION.md`](STEP_COMPLETION.md) for the full definition. The
parts that surprise people:

- **Relative, not absolute.** A part is judged by its pose *relative to the
  parts it mates with*. The whole footprint must also lie inside the marked
  assembly workspace. Moving a build within the workspace preserves its score;
  moving it outside invalidates the affected parts.
- **Identical parts are interchangeable.** Slots are assigned by matching poses
  (greedy propagation + a pairwise-swap correction that uses the *mean* error
  over all placed neighbours). Swapping arm #1 and #3 still scores 53/53.
- **Tolerance: 3.2 mm / 12°.**
- **Majority rule.** A part counts as in place when *most* of its placed
  neighbours agree, not all. This matters: error is asymmetric — a screw turned
  5° reads as 0.3 mm from its own side and 3.9 mm from the far end of an arm.
  Requiring unanimity blamed three innocent arms for one crooked screw.
- **Workspace first.** Next/showNext/showStep first animate the actual receiving
  part into the workspace if it is outside, then switch to assembly guidance
  after the trainee moves it in. Hole mating rejects an outside receiver or a
  final pose crossing the boundary. X/Z mesh bounds are checked; height is free.
  Bounds live in `src/workspace.js` (X 8–18, Z −5–5, scene units). Tutorial
  fixtures start inside. No host protocol change is required.
- **`S` / Snap all** require both current and final footprints inside the workspace
  and move a part onto its exact reference pose when it is
  already close (10 mm / 25°, widened by the swing a rotation error explains).
  Automatic snapping on place is **off** by default (`KBCheck.autoSnap(true)`
  turns it on) because it fights arrow-key fine-tuning.

When a report does not make sense, run this in the console and read the two
right-hand columns — it prints every placed part with its agree/disagree votes
and its error against the assembly anchor:

```js
copy(KBCheck.diagnose())
```

---

## 7. Modes and UI surface

| | how | for |
| --- | --- | --- |
| trainee | `?trainee=1`, implied by `?bridge=1` | no scale/delete/duplicate/material editing |
| embed | `?embed=1` | compact toolbar, no hints footer |
| general (default) | toolbar toggle | click a hole → click a hole to mate; arrow keys; no gizmo, no bounding boxes |
| expert | toolbar toggle or `?expert=1` | gizmo, Move/Rotate/Scale, Ctrl-drag snapping, the hole-labelling tool |
| tutorial | toolbar button or `?tutorial=1` | two short lessons on two parts each |

The interaction model a trainee sees: **click a part → click one of its hole
discs → click the receiving hole disc**. Each hole shows a disc at *both*
mouths; the two discs you click are the two faces that end up touching. Once
mated the part is locked on that hole — `↑↓` slide it 0.25 mm along the axis,
`←→` turn it 1° around it (Shift = 90°), clicking the part releases it.

---

## 8. Traps we already hit

1. **Stale `public/simulator/kitbash-standalone.html`.** See §2. Check
   `KB.build()` before debugging anything.
2. **Which mouth you click decides which side the part lands on.** Arms go
   *under* the front plate: click the arm's top disc and the plate's lower disc.
   Clicking the obvious top-top pair puts the arm 7.5 mm high and looks right
   until Checks complains.
3. **Mesh decimation broke the motor.** `motor_2207.glb` is 4624 separate
   shells; a global edge-collapse welds them into confetti. Simplify per
   connected component (see the note in `README.md`).
4. **A part's own reference can be a liar.** An early-step part that is itself
   off is judged only against even earlier parts, so it passes — and every
   later part touching it inherits the blame. Hence the majority rule in §6.
5. **`SAME` in `check.js` treats M3×16 pan and socket-cap screws as one type.**
   If ARISTOS must distinguish head types, remove that mapping.

---

## 9. How to verify a change

There is no unit-test suite; the simulator is verified by driving the real page
with Playwright (Chromium, `--use-gl=swiftshader` works headless). The pattern:
load the page, wait for `KBParts.ready()`, build a scene with
`KBParts.sceneObject(...)` + `KB.loadSceneData`, act through real mouse clicks
or the public APIs (`KBMate.mate`, `KBCheck.snapAll`), then assert on
`KBCheck.results()` / `KBParts.poseOf(node)`.

Minimum regression set before shipping a change to the judgement:

- the complete reference assembly scores 74/74 parts, 46/46 steps, 0 issues
  (53 parts / 27 steps ARISTOS-captured, 21 / 19 derived — see §5)
- arms placed in shuffled order still score 74/74
- no step has zero slots: a step whose part has no model must not be emitted,
  or it sits at `available` forever and 100% becomes unreachable
- a part genuinely 8 mm off is still reported
- Next shows wedge transfer before screw insertion; after moving the wedge inside,
  guidance switches automatically without moving any real part on its own.
- Outside mating and outside Snap all are rejected; an exact assembly outside
  does not count as complete, and counts again after being moved inside.
- Snap all clears a jittered build inside the workspace to 15/15 of the parts placed so far
- both tutorial lessons complete by clicking

---

## 10. Open questions (for whoever owns the ARISTOS side)

1. Event envelope for grab/place — reuse the `session-keypress` shape, or a new
   `session-sim-action`?
2. Is a simulated session a flag on the session, or a separate kind?
3. Hosting: static copy inside `aristos_frontend/public`, or serve this repo?
4. Where does this code live long-term — a branch of `aristos_frontend`, or its
   own repository pulled in as a submodule?
5. Should the trainee be allowed to press **Snap all** (it moves parts onto the
   exact answer), or is that a tutor-only affordance?
