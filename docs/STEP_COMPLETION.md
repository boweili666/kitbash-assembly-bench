# Step completion and out-of-order assembly

How the simulator decides that an assembly step is done, how it treats a
trainee who does not follow the manual's order, and what it tells ARISTOS.
Everything below is implemented in `src/check.js` (judgement), `src/answer.js`
(next-step ghost), `src/bridge.js` (protocol) and generated from
`task_graphs.db` by `tools/features_db.py answer`.

## 1. Principles

1. **Completion is a property of the scene, not of the click sequence.** After
   every place the whole state is recomputed from part poses. Nothing is
   remembered between placements, so taking a part off makes its step
   incomplete again, and any order the task graph permits just works.
2. **A part is "in place" relative to the part it mates with, not relative to
   the world.** A wedge with its screw assembled on the far side of the table is
   as complete as one assembled on the X-Lock. The previous implementation
   aligned the whole reference to the user's X-Lock and compared in world space;
   sub-assemblies built elsewhere read as "wrong position".
3. **Order is the task graph's partial order, not a list.** Of the 351 pairs of
   the 27 geometric steps, 286 (81.5 %) carry no ordering constraint; the four
   motor steps are free with respect to every other step; there are 8×10¹⁹
   valid orders. Only stepping onto a step whose prerequisites are not done is
   out of order.
4. **The simulator computes geometry; the backend decides what to say.** The
   simulator reports which steps are complete / available / premature /
   blocked and what just happened. Whether to intervene, and how, is ARISTOS's
   call. Grabbing a part is never an error; starting to seat it somewhere it
   does not belong is the moment worth reacting to.

## 2. Reference data (generated)

`features_db.py answer` reads `Step3DPaths`, `StepRequirements`, `StepParts`
and `PartTypeFeatures` and writes, for the graph's geometric steps:

```
steps[]  { i, id (Steps.uuid), name, requires: [answer indices, transitive] }
parts[]  { id (Parts.uuid), key, name, step,
           path:  [ {x,y,z,roll,pitch,yaw} … ]     approach → installed, mm, GLB origin
           mates: [ { id, kind: 'feature'|'contact', features: [[mine, theirs]…], rel } ] }
```

- A **step** is a graph step in which some part moves (27 of 353 for the drone
  graph). Parts that never move in the paths (the 16 motor screws, 4 grommets)
  are attached to the step that lists them in `StepParts`.
- **mates** are the parts each part is assembled to, at the final poses:
  `feature` when a hole/peg of one is coaxial with a compatible feature of the
  other (axes within 5°, on the same line within 1.5 mm, diameters compatible
  allowing +0.6 mm for CAD undersize, axial extents overlapping); `contact`
  when only the bounding boxes touch (arms in the X-Lock slots, motors on arm
  tips — those mating surfaces are not cylinders). 52 of 53 parts have a
  feature mate; arm #2 has contact mates only.
- `rel` is the part's pose in the mate's frame, informational; the simulator
  recomputes relative transforms from the paths in scene units.

The steps are ordered by the animation's own chronology (parts already
installed when the step starts is strictly monotone 0 → 52), constrained by
`StepRequirements`. `requires` is the transitive closure restricted to
geometric steps.

## 3. Judging a part: relative pose to its mates

For slot *t* (a reference part) occupied by user part *u*, and a mate *m*
occupied by user part *um*:

```
R_ref  = inv(M_m)  · M_t          reference relative transform (node frames)
R_user = inv(M_um) · M_u          the trainee's
error  = min over symmetries S_m of the mate and S_t of the part
         of  inv(S_m) · R_ref · S_t   vs  R_user
```

- position error `d`, and an angle: full quaternion angle for plates and
  bodies; for screws the **signed shaft→head axis** (so a screw put in head
  first reads as reversed, > 90°); unsigned axis for standoffs and nuts.
- **in place**: `d < 3.2 mm`, not reversed, angle `< 12°`.
- **near** (assembled to the mate but not right): `d < 20 mm`, angle `< 45°`.
- Symmetries come from `PartTypeSymmetries` (plates 180° about the long axis,
  wedge 180°, standoff 5-fold, screws 90/180/270): a symmetric-equivalent pose
  is the same pose. Identical part instances are interchangeable.

Which mates count for slot *t*: those in the **same or an earlier step**. A
later step's part is that step's business. An earlier-step mate that has
itself been judged misplaced (it had a reference and missed it) is skipped, so
one misplaced arm does not make every standoff on it look wrong; an
earlier-step mate whose own prerequisites are simply absent still serves as a
reference frame.

A slot is **ok** when at least one mate is near and every near mate matches.
A slot whose part touches none of its mates is "on the table": named, not
placed.

## 4. Pairing user parts to reference slots

The user's parts carry no slot identity, and identical parts are
interchangeable, so the pairing is derived from geometry:

1. **Unique anchors** — a part type with exactly one reference slot and exactly
   one instance in the scene (X-Lock, rear plate, front plate, ESC, …) is paired
   directly.
2. **Propagation** — for every empty slot, for every mate already paired, every
   free part of the slot's type is scored by relative error; matches within the
   *near* gate are assigned greedily by score across the whole scene.
3. **Pairs** — two empty slots that are mates of each other (wedge + its screw,
   motor + its nut) are resolved by enumerating free part pairs, with a tighter
   gate (6.4 mm) since there is no anchor.

Repeat 2–3 until nothing changes. Parts left unpaired are still on the table.

## 5. Step states

For each step: `progress = ok slots / slots`; **done** = all slots ok.

| state | meaning |
| --- | --- |
| `complete` | done, and every prerequisite step is `complete` |
| `premature` | done, but some prerequisite is not — out of order. Does **not** unlock its dependents |
| `available` | not done, every prerequisite `complete` — anything here may be done next, in any order |
| `blocked` | not done, some prerequisite not `complete` |

Two counts are reported: `stepsComplete` (done, the trainee-facing progress)
and `stepsSettled` (state `complete`, the task-graph-facing one).

## 6. Issues

| message | condition |
| --- | --- |
| *X is N mm off its place on Y* | paired, near a mate, `d ≥ 3.2 mm` |
| *X is tilted N° on Y* | position fine, angle `≥ 12°` |
| *X is inserted backwards into Y* | signed screw axis `> 90°` |
| *Wrong part on Y: found A, expected X* | slot empty; a part of the same family but another type has its GLB origin within 4.8 mm of where X's would be |
| *Out of order: "S" done/started before "P"* | S is `premature`, or `blocked` and started (a part of S is near a mate) — and P is a prerequisite that has **not started**. A prerequisite that has started but is misplaced already carries its own message |

One message per mate pair; the later step of a mismatched pair owns the
message.

## 7. What the simulator sends (bridge protocol)

After every place, and after the scene is set:

```
kb:state {
  state: {
    steps:  [{ id, index, name, state, progress, requires: [step ids] }],
    parts:  [{ id, name, step, placed, ok, by }],      by = user part id occupying the slot
    issues: [{ severity, message, objectId, step }],
    next:   step id | null,                            first available step, started ones first
    score:  { partsOk, partsTotal, stepsComplete, stepsSettled, stepsTotal }
  },
  lastPlace: { objectId, pose, fitsStep: step id | null, ok }
}
```

Snap attempts are reported separately as `kb:snapAttempt` (§7a).

Host commands: `kb:getState`, `kb:showNext`, `kb:showStep {step}`,
`kb:hideAnswer`, `kb:highlight {id, color|null}`, `kb:fuse {parentId,
childId}`, `kb:unfuse {childId}`. In `<Simulator>` these are `onStateChange`
and `ref.getState / showNext / showStep / hideAnswer / highlight / fuse /
unfuse`.

Suggested wiring on the ARISTOS side (not done here):

- `state.steps` → task-graph node states, replacing the hand-curated linear
  `ASSEMBLY_SEQUENCE`; `next` → what the tutor proposes.
- `lastPlace.fitsStep && ok` → step confirmed; call `fuse(mate, part)` so the
  sub-assembly moves as one from then on.
- a `grab` whose `objectId` is not a part of any `available` step → note it,
  say nothing; an `Out of order … started` issue → the trainee has begun
  seating a part where it does not belong yet → intervene.

## 7a. Snap attempts (`kb:snapAttempt`)

Snapping (Ctrl-drag) pairs a feature of the moved part with a feature of a
part already on the table: peg → hole, hole ↔ hole (coaxial alignment, e.g. a
standoff over a plate hole), or, failing that, a bounding-box face against a
face. A pair is **geometrically incompatible** when it is peg on peg, or the
peg's diameter exceeds the hole's by more than 0.6 mm (the CAD undersize
allowance used everywhere else). Incompatible pairs never snap: the target is
shown red and the part stays free (or falls back to a face snap).

Every new pairing the solver settles on, and every incompatible pairing it
refuses, is reported once per gesture:

```
kb:snapAttempt { object1, object2,            part being moved, part snapped to (Parts.uuid)
                 snapPoint1, snapPoint2,      feature name on each ('H3', 'P1', or face 'F+y')
                 success, reason }            reason: 'peg-on-peg' | 'peg wider than hole' | null
```

Whether the hole is the one the manual wants is not judged here; that is the
step judgement in `kb:state`. A screw offered head first still snaps on its
shaft axis (the shaft is coaxial with the head) and is then reported as
*inserted backwards* by the checker.

## 8. Next-step ghost (`Next` button / `kb:showNext`)

The reference trajectory of the next available step, replayed on a loop **on
the trainee's own assembly**: ghost pose = user anchor pose · inv(reference
anchor pose) · reference waypoint, where the anchor is a placed part of the
step or of its mates (or, for the very first step, a free part of the right
type on the table). Free parts the step needs are highlighted amber. After each
place the step is re-evaluated: done → the ghost moves to the next available
step; not done → it re-anchors on the current structure.

## 9. Trainee mode and fuse

- `?trainee=1` (default when embedded via the bridge; `?tools=1` restores the
  editor): no scale, delete, duplicate, group or material editing; the `R`,
  `Delete`, `Ctrl+D`, `Ctrl+G` shortcuts are inert. Colour changes remain
  available to the host through `kb:highlight`.
- `fuse(parent, child)` puts both under one group (the existing Ctrl+G
  mechanism), so clicking either selects and moves the whole sub-assembly;
  groups merge when fused again; `unfuse` releases a part. Nested parts stay
  visible to the checker.

## 10. Known limits

- The arms' slot geometry and the motor mounts are not cylinders (the arm
  model has one hole feature; motor-mount holes are not in
  `PartTypeFeatures`), so those steps are judged by relative pose only, no
  feature engagement. Adding motor-mount holes to the arm's features would
  tighten this.
- Insertion depth is not enforced (CAD diameters are off by up to 0.4 mm; see
  `FEATURE_SCHEMA.md`); "seated" counts as done, torque is not modelled.
- Sideways interpenetration is not prevented; only motion along hole axes is
  constrained.
- Motor #3/#4 sit on arms #4/#3 in the path data while the step text says
  #3/#3 and #4/#4 — harmless here because identical parts are interchangeable,
  but worth fixing in the graph.
