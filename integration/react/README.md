# `<Simulator>` — Kitbash assembly simulator as a React component

```tsx
import Simulator from './Simulator';

<Simulator
  initialScene={parts}                              // ScenePart[]
  onGrabObject={(id, pose) => ...}                  // user picked a part up
  onMoveObject={(id, pose) => ...}                  // while dragging (≤ 30 Hz)
  onPlaceObject={(id, pose) => ...}                 // user put it down
  onViewUpdate={(image) => ...}                     // JPEG data URL, 10 Hz
/>
```

`id` is the part-instance UUID you passed in `initialScene` (the assembly
graph's part id), echoed back unchanged. `pose` is `{x, y, z, roll, pitch, yaw}`.

## Pose convention

Identical to aristos `step_3d_paths.json`, so poses round-trip without conversion:

| | |
| --- | --- |
| position | millimetres, **Y up**, of the part's **GLB node origin** |
| rotation | radians, XYZ Euler (`R = Rx·Ry·Rz`; roll→x, pitch→y, yaw→z) |

Round-trip accuracy (set via `initialScene`, read back): position < 1e-4 mm,
rotation matrix < 5e-4.

## `initialScene`

```ts
interface ScenePart {
  id: string;        // part-instance UUID
  key?: string;      // simulator part type, e.g. 'arm_5in' …
  glb?: string;      // … or a GLB url; recognised by the model UUID in the file
                     //    name (assembly_graph_assets/<uuid>.glb)
  name?: string;
  pose: Pose;
}
```

Known part types (15, all with auto-labelled holes for snapping):
`split_rear_plate split_front_plate aluminum_x_lock arm_5in aluminum_arm_wedge_5mm
knurled_standoff screw_m3x6_pan screw_m3x8_socket_cap screw_m3x16_pan
screw_m3x16_socket_cap screw_m3x22_pan motor_2207 motor_nut_m5 damper_m2 esc_4in1`.
A part whose model is not recognised is skipped with a `console.warn`.

`demo/src/scene.ts` is a real example: 10 parts with their UUIDs and installed
poses taken straight from the Frame+ESC+Motors+FC graph.

## Other props / ref

| prop | default | |
| --- | --- | --- |
| `src` | `http://127.0.0.1:8123/index.html` | where the bench is served from (`python3 serve.py`, or any static host of this repo / `dist/kitbash-standalone.html`) |
| `frameRate` | 10 | `onViewUpdate` rate, Hz; 0 disables |
| `frameWidth` | 960 | frame width in px |
| `moveRate` | 30 | max `onMoveObject` rate while dragging |
| `onReady` | | fires once the part library and initial scene are loaded |

```ts
const sim = useRef<SimulatorHandle>(null);
await sim.current.getScene();     // → [{id, name, key, pose}]  current pose of every part
sim.current.setScene(parts);      // replace the scene
```

## How it works

The bench stays plain JavaScript (zero regression risk) and runs in an iframe
with `?bridge=1&embed=1`. `src/bridge.js` speaks a small postMessage protocol
(`kb:init / kb:grab / kb:move / kb:place / kb:frame / kb:getScene / kb:scene`);
`Simulator.tsx` owns that protocol so callers only see props and callbacks.
Callbacks are read through a latest-ref, so re-rendering the parent with new
closures never restarts the frame loop.

## Dropping into aristos_frontend

`aristos/SimulatorTraineeView.tsx` is the ready-made host: it renders
`<Simulator>` with the drone kit as `initialScene` (`aristos/kit_scene.json`,
82 parts with their task-graph UUIDs) and exposes all four callbacks as empty,
documented stubs for ARISTOS to wire. Full hand-off in
[`docs/ARISTOS_INTEGRATION.md`](../../docs/ARISTOS_INTEGRATION.md).

### Manually

Copy `Simulator.tsx` anywhere under `src/` — no dependencies beyond React.
Serve the bench (`python3 serve.py` in this repo, port 8123) or point `src` at
a static copy of `dist/kitbash-standalone.html`.

## Demo

```sh
python3 serve.py                          # bench on :8123
cd integration/react/demo && npx vite     # demo on :5180 (borrows aristos_frontend/node_modules via symlink)
```
Left: the component. Right: every callback as it fires, plus the latest
`onViewUpdate` frame. Verified end-to-end with Playwright: UUIDs preserved,
pose round-trip, grab/move/place on drag, 10.0 fps frames on GPU.
