/**
 * SimulatorTraineeView — the assembly simulator standing in for the trainee's
 * camera when there are no physical parts to assemble.
 *
 * This is the integration surface. Every callback the simulator offers is a
 * prop here; the defaults are documented no-ops so the surface is visible even
 * when nothing is connected. TraineeCam wires only onViewUpdate (to the
 * existing session-video-frame emit); grab / move / place are left for the
 * backend design to decide. See docs/ARISTOS_INTEGRATION.md in the
 * kitbash-assembly-bench repository for the suggested wiring.
 *
 * The ref exposes popOut() / dockBack(): the simulator can move to its own
 * browser window (a second monitor, a bigger view) and come back, keeping the
 * trainee's progress; the frames keep flowing either way. It also takes
 * commands: jumpToStep(nodeId) lays the build out at a step (e.g. from a click
 * on the task graph), pointAt(objectId) puts the yellow arrow on a part.
 *
 * Poses everywhere: mm, Y up, XYZ Euler radians, GLB node origin — the
 * Step3DPaths convention, so a placed pose compares with the graph directly.
 * objectId is the part instance's task-graph UUID (Parts.uuid).
 */
import { forwardRef } from 'react';
import Simulator from '../Simulator';
import type { Pose, ScenePart, SimulatorHandle, SimState, LastPlace, CollisionInfo, PlaceCheck, Diagnosis, StepState, TutorialResult } from '../Simulator';
import kitScene from './kit_scene.json';
const SIMULATOR_URL = (import.meta as any).env?.VITE_SIMULATOR_URL ?? '/simulator/kitbash-standalone.html';

interface Props {
  /** Parts on the table when the session starts. Default: the drone kit, by type. */
  initialScene?: ScenePart[];
  /** The trainee picked a part up. */
  onGrabObject?: (objectId: string, pose: Pose) => void;
  /** The part is being moved (≤ 30 Hz while dragging). */
  onMoveObject?: (objectId: string, pose: Pose) => void;
  /** The trainee put the part down. `check` already compares it with the step's target (in the task graph's frame). */
  onPlaceObject?: (objectId: string, pose: Pose, check?: PlaceCheck) => void;
  /** Rendered frame as a JPEG data URL, 10 Hz — the same payload the webcam path sends. */
  onViewUpdate?: (image: string) => void;
  /** The simulator moved to its own window (true) or back into the page (false). */
  onPopOutChange?: (poppedOut: boolean) => void;
  /** Assembly state after every place: which steps are complete / available / premature / blocked, issues, next step. */
  onStateChange?: (state: SimState, lastPlace?: LastPlace) => void;
  /** Snap attempt (Ctrl-drag): moved part, target part, feature ids on each, and whether it was geometrically valid. */
  onSnapAttempt?: (object1Id: string, object2Id: string, snapPoint1Id: string, snapPoint2Id: string,
                   success: boolean, reason: string | null) => void;
  /** The moved part (object1) is pushed into object2: solids interpenetrating > 1 mm, or a peg on a hole it cannot enter. */
  onCollision?: (object1Id: string, object2Id: string, info: CollisionInfo) => void;
  /** A task-graph node changed state, e.g. to colour the graph. */
  onStepChange?: (nodeId: string, state: StepState, previous: StepState | null, step: { index: number; name: string }) => void;
  /** A new error, in the error / diagnosis schema (observation, and the node where the mistake was made). */
  onError?: (error: Diagnosis) => void;
  /** The practice tutorial ended (completed or skipped). */
  onTutorialEnd?: (result: TutorialResult) => void;
  /** Every step is complete. */
  onAssemblyComplete?: (info: { level: number | 'demo' | null; steps: number }) => void;
}

// Not connected to anything yet, on purpose: each callback's signature is
// the one in Props above; this default simply drops the event.
const notWired = () => {};

const SimulatorTraineeView = forwardRef<SimulatorHandle, Props>(function SimulatorTraineeView({
  initialScene = kitScene,
  onGrabObject = notWired,
  onMoveObject = notWired,
  onPlaceObject = notWired,
  onViewUpdate = notWired,
  onPopOutChange = notWired,
  onStateChange = notWired,
  onSnapAttempt = notWired,
  onCollision = notWired,
  onStepChange = notWired,
  onError = notWired,
  onTutorialEnd = notWired,
  onAssemblyComplete = notWired,
}, ref) {
  return (
    <Simulator
      ref={ref}
      src={SIMULATOR_URL}
      initialScene={initialScene}
      onGrabObject={onGrabObject}
      onMoveObject={onMoveObject}
      onPlaceObject={onPlaceObject}
      onViewUpdate={onViewUpdate}
      onPopOutChange={onPopOutChange}
      onStateChange={onStateChange}
      onSnapAttempt={onSnapAttempt}
      onCollision={onCollision}
      onStepChange={onStepChange}
      onError={onError}
      onTutorialEnd={onTutorialEnd}
      onAssemblyComplete={onAssemblyComplete}
      frameRate={10}
      style={{
        width: '100%',
        aspectRatio: '16 / 10',
        borderRadius: 12,
        border: '1px solid var(--hairline)',
      }}
    />
  );
});

export default SimulatorTraineeView;
