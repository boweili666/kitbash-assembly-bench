# Integrating the assembly simulator into ARISTOS

**Status: interface exposed, nothing wired.** The simulator ships as a React
component with exactly the signature requested; every callback is surfaced and
left empty for the ARISTOS team to connect. This document is the hand-off.

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
0 disables frames), `moveRate` (default 30), `onReady`, and a ref with
`getScene()` (every part's current pose) and `setScene(parts)`.

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

## 5. Where it mounts in the gin-dev frontend

`TraineeCam.tsx` renders `<Webcam>` and, every 100 ms, emits its screenshot as
`session-video-frame`. The simulator takes that slot:

```tsx
// TraineeCam.tsx — sketch, not applied
{source === 'real'
  ? <Webcam ref={webcamRef} … />
  : <SimulatorTraineeView session={session} />}
```

with a Real / Sim toggle next to the "Trainee view" label, or with `source`
decided by a session flag ("simulated session") so trainees never see the
toggle. **No change to the backend is needed for this**: once `onViewUpdate`
is connected to the existing `session-video-frame` emit, the tutor receives
simulated frames exactly like camera frames.

## 6. What is deliberately not connected

| callback | today | suggested wiring (ARISTOS decides) |
| --- | --- | --- |
| `onViewUpdate(image)` | no-op | `socket.emit('session-video-frame', {sessionID, payload: {data: image}})` — the existing channel; replaces the webcam screenshot |
| `onPlaceObject(id, pose)` | no-op | a new event, e.g. `session-sim-action {action:'place', objectId, pose}`; compare `pose` with the step's `Step3DPaths` target → deterministic "right part, right hole, right orientation" without VQA |
| `onGrabObject(id, pose)` | no-op | same event, `action:'grab'`; lets the tutor react to "you picked up the wrong screw" before it is placed |
| `onMoveObject(id, pose)` | no-op | usually not sent; useful for dwell-time / hesitation analytics |

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
python3 tools/features_db.py manifest task_graphs.db media/models --kit kit.json --copy-glb --out assets/parts/manifest.json
python3 build.py                                                                 # → dist/
```

Part features (holes, pegs, symmetries) are **contributor data** in
`task_graphs.db` — see `FEATURE_SCHEMA.md`. The simulator cannot snap parts
whose type has no features.

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
