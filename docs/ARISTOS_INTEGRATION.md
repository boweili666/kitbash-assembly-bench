# Integrating the assembly simulator into ARISTOS

**Status: on branch `bowei/simulator` of `aristos_frontend` (from gin-dev
`72cc057`, two commits). The trainee view can switch to the simulator; its
frames reach the backend on the existing channel. The grab / move / place
callbacks are exposed and deliberately left unconnected.** This document is
the hand-off.

## 1. Motivation

ARISTOS trains people to assemble a real product under a camera. Trainees do
not always have the parts — the kit is shared, expensive, or not shipped yet —
and the tutor pipeline (VQA on camera frames) cannot be exercised without a
build in front of the lens.

The simulator removes that dependency: the trainee assembles the **same parts,
in the same steps, from the same task graph**, on screen. To ARISTOS it looks
like a camera — 10 fps JPEG frames on the same channel — so everything
downstream keeps working unchanged. Beyond that, the simulator knows what the
camera has to guess: *which* part was picked up, *where* it was put down, to
the millimetre. Those events are exposed as callbacks for whatever ARISTOS
wants to do with them later.

## 2. What is delivered

| | where |
| --- | --- |
| `<Simulator>` — the component, Dana's signature | `integration/react/Simulator.tsx` |
| `<SimulatorTraineeView>` — host stub with every callback exposed and **empty** | `integration/react/aristos/SimulatorTraineeView.tsx` |
| `initialScene` for the drone kit (82 parts on the table, real UUIDs) | `integration/react/aristos/kit_scene.json` |
| Generators from `task_graphs.db` | `tools/scene_from_db.py`, `tools/features_db.py` |
| The simulator itself (plain JS, served as a page) | this repo; `python3 serve.py` or `dist/kitbash-standalone.html` |
| Runnable demo of the component with a live event log | `integration/react/demo/` |

Both `.tsx` files depend only on React. They type-check under `--strict`
against React 19 (the gin-dev frontend's version).

## 3. The interface

```tsx
<Simulator
  initialScene={parts}                         // ScenePart[]
  onGrabObject={(objectId, pose) => …}          // trainee picked a part up
  onMoveObject={(objectId, pose) => …}          // while dragging, ≤ 30 Hz
  onPlaceObject={(objectId, pose) => …}         // trainee put it down
  onViewUpdate={(image) => …}                   // rendered frame, JPEG data URL, 10 Hz
/>
```

- `objectId` — the part-instance UUID from the task graph (`Parts.uuid`),
  exactly as passed in `initialScene`.
- `pose` — `{x, y, z, roll, pitch, yaw}`: **millimetres, Y up, XYZ Euler
  radians (R = Rx·Ry·Rz), position of the GLB node origin.** This is the
  `Step3DPaths` convention, so a placed pose can be compared with the graph's
  target pose without any conversion. Verified round trip: < 1e-4 mm.
- `image` — `data:image/jpeg;base64,…`, the same payload the webcam path
  sends today.

```ts
interface ScenePart {
  id: string;        // Parts.uuid
  glb?: string;      // "…/<model uuid>.glb" — resolved by the model uuid (hyphens optional)
  key?: string;      // or the simulator's part type name
  name?: string;     // display name; Parts.name
  pose: Pose;
}
```

Optional: `src` (where the simulator page is served), `frameRate` (default 10;
0 disables frames), `moveRate` (default 30), `onReady`, `onPopOutChange`, and a
ref with `getScene()` (every part's current pose), `setScene(parts)`,
`popOut()` / `dockBack()` (move the simulator to its own browser window and
back — the scene travels along, the pane shows the window's live picture,
frames never stop) and `isPoppedOut()`.

**Assembly state.** `onStateChange(state, lastPlace)` fires after every place
with the simulator's own judgement of the build — which steps are `complete`,
`available`, `premature` (done out of order) or `blocked`, per-part placement,
issues (wrong hole, reversed screw, wrong part, out of order) and the step it
would show next. It is computed from part poses against the reference
assembly generated from `task_graphs.db`, relative to mating parts, so
sub-assemblies built anywhere on the table count and identical parts are
interchangeable. The ref adds `getState()`, `showNext()` / `showStep(step)` /
`hideAnswer()` (a looping ghost of the step on the trainee's current
assembly), `highlight(objectId, color)` and `fuse(parentId, childId)` /
`unfuse(childId)` (make parts move as one). Full definition:
[`STEP_COMPLETION.md`](STEP_COMPLETION.md).

When embedded the simulator runs in **trainee mode**: no scale, delete,
duplicate, group or material editing (`?tools=1` on `src` restores them).

## 4. Producing `initialScene` from the database

```sh
# every modelled part of the graph on the table, grouped by type (session start)
python3 tools/scene_from_db.py task_graphs.db --layout kit --models media/models --out kit_scene.json

# the build as it stands after step N (resume a session mid-way)
python3 tools/scene_from_db.py task_graphs.db --layout installed --step N --out step_N.json
```

Both read `Parts`, `PartTypes` and `Step3DPaths`. Parts whose model is not in
the simulator's part library are skipped with a `console.warn` — today that is
28 of the 48 part types (electronics, wires, connectors), which have no GLB in
the data package and no rigid-body assembly step anyway.

## 5. Where it mounts — done on `bowei/simulator`

gin-dev's `TraineeCam.tsx` renders `<Webcam>` and, every 100 ms, emits its
screenshot as `session-video-frame`. The branch adds a **Real / Sim** toggle
next to "Trainee view" (default Real) and, in Sim, a **Pop out / Dock back**
button for working in a separate window (second monitor). In Sim, the webcam is unmounted and
`<SimulatorTraineeView onViewUpdate={sendFrame} />` takes its place — the
simulator's 10 fps frames go out through the very same `sendFrame`, so **the
backend receives simulated frames exactly like camera frames and needs no
change**. Files on the branch:

```
src/components/Simulator/Simulator.tsx             the component
src/components/Simulator/SimulatorTraineeView.tsx  host; callbacks are props with no-op defaults
src/components/Simulator/kit_scene.ts              82-part initialScene from task_graphs.db
public/simulator/kitbash-standalone.html           the simulator page, served same-origin
src/config.ts                                      SIMULATOR_URL (override: VITE_SIMULATOR_URL)
src/components/AristosSession/TraineeCam.tsx       the toggle
```

Passes the project's own gates: `tsc -b`, `npm run build`, and `eslint` with no
new findings. Verified with the backend running: switching to Sim sends
`session-video-frame` at 10.0 fps with a JPEG data URL and the session id;
switching back stops them and restores the webcam. Login is untouched: the
session page still requires an account, as on gin-dev.

## 6. What is deliberately not connected

| callback | today | suggested wiring (ARISTOS decides) |
| --- | --- | --- |
| `onViewUpdate(image)` | **connected** on the branch | goes through TraineeCam's existing `sendFrame` → `session-video-frame`; replaces the webcam screenshot |
| `onPlaceObject(id, pose)` | no-op | a new event, e.g. `session-sim-action {action:'place', objectId, pose}`; compare `pose` with the step's `Step3DPaths` target → deterministic "right part, right hole, right orientation" without VQA |
| `onGrabObject(id, pose)` | no-op | same event, `action:'grab'`; lets the tutor react to "you picked up the wrong screw" before it is placed |
| `onMoveObject(id, pose)` | no-op | usually not sent; useful for dwell-time / hesitation analytics |
| `onSnapAttempt(obj1, obj2, snapPoint1, snapPoint2, success, reason)` | no-op | the trainee lined a feature of the moved part up with one of another part (Ctrl-drag); `success=false` means geometrically impossible (peg on peg, peg wider than the hole) and the snap was refused; the ids are `PartTypeFeatures.name` ('H3', 'P1') or a bounding-box face ('F+y'). Which hole the manual wants is `onStateChange`'s business |
| `onCollision(obj1, obj2, info)` | no-op | the moved part is pushed into another: solids interpenetrating by more than 1 mm (`info.kind='mesh'`, `depthMm`), or a peg lined up with a hole it cannot enter (`'feature'`, `snapPoint1/2`). Correctly assembled pairs never collide; nothing is blocked, ARISTOS decides whether to say something |
| `onStateChange(state, lastPlace)` | no-op | `state.steps` → task-graph node states (replaces the hand-curated linear sequence); `state.next` → what the tutor proposes; `lastPlace.fitsStep && ok` → confirm the step and `ref.fuse(mate, part)`; an *Out of order … started* issue → the trainee has begun seating a part where it does not belong yet → intervene; a `grab` of a part no `available` step uses → note, say nothing |

Nothing else is touched: no auth, no session database, no chat, no Workflow
server calls. The component does not know ARISTOS exists.

## 7. Running the simulator

The component is an iframe onto the simulator page; host the page anywhere:

| option | when |
| --- | --- |
| `python3 serve.py` in this repo → `http://127.0.0.1:8123/index.html` | development |
| copy `dist/kitbash-standalone.html` into `aristos_frontend/public/simulator/` and set `VITE_SIMULATOR_URL=/simulator/kitbash-standalone.html` | one deployable, no extra server |
| any static host | production |

The page is self-contained (three.js and all part meshes inlined; 8.5 MB, of
which 2.6 MB are the two propeller meshes).

Data the page is built from — regenerate when the task graph changes:

```sh
python3 tools/features_db.py import   task_graphs.db part_features.json          # contributor hole/peg data
python3 tools/scene_from_db.py        task_graphs.db --layout kit --models media/models --out kit.json
python3 tools/features_db.py answer   task_graphs.db media/models --out answer.json   # reference assembly (Step3DPaths + StepRequirements)
python3 tools/features_db.py manifest task_graphs.db media/models --kit kit.json --answer answer.json --copy-glb --out assets/parts/manifest.json
python3 build.py                                                                 # → dist/
```

Part features (holes, pegs, symmetries) are **contributor data** in
`task_graphs.db` — see `FEATURE_SCHEMA.md`. The simulator cannot snap parts
whose type has no features.

Everything the simulator shows about the *reference* build — the Answer
animation's steps and per-part approach paths, and the poses, step order and
prerequisites the Checks compare against — is generated from `Step3DPaths`,
`StepRequirements` and `StepParts` by `features_db.py answer`. Steps are the
graph steps in which a part moves (27 of 353 for this graph), ordered by the
animation's own chronology; parts whose type has no model are skipped. A new
part type needs no code change: its simulator key is derived from its name.

## 8. Verified

Playwright, real GPU, against the gin-dev toolchain (React 19, Vite 8):

- `initialScene` of 53 / 82 parts loads with UUIDs preserved; pose round trip < 1e-4 mm, rotation matrix < 5e-4
- dragging a part fires `onGrabObject` ×1, `onMoveObject` ×n, `onPlaceObject` ×1 with the right UUID
- `onViewUpdate` at 10.0 fps
- the simulator's own regressions (snapping, undo, answer animation) unchanged

## 9. Open questions for Dana

1. Event names and payloads for grab / place — reuse `session-keypress`-style
   envelopes, or a new `session-sim-action`?
2. Should a simulated session be a flag on the session (no toggle in the UI)?
3. Hosting: iframe from this repo's server, or a static copy inside
   `aristos_frontend/public`?
4. GitLab destination for this code: a branch of `aristos_frontend`, or a new
   repository as a submodule?
