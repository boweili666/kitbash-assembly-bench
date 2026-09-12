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
 * Poses everywhere: mm, Y up, XYZ Euler radians, GLB node origin — the
 * Step3DPaths convention, so a placed pose compares with the graph directly.
 * objectId is the part instance's task-graph UUID (Parts.uuid).
 */
import Simulator from '../Simulator';
import type { Pose, ScenePart } from '../Simulator';
import kitScene from './kit_scene.json';
const SIMULATOR_URL = import.meta.env?.VITE_SIMULATOR_URL ?? '/simulator/kitbash-standalone.html';

interface Props {
  /** Parts on the table when the session starts. Default: the drone kit, by type. */
  initialScene?: ScenePart[];
  /** The trainee picked a part up. */
  onGrabObject?: (objectId: string, pose: Pose) => void;
  /** The part is being moved (≤ 30 Hz while dragging). */
  onMoveObject?: (objectId: string, pose: Pose) => void;
  /** The trainee put the part down — the moment to compare `pose` with the step's target. */
  onPlaceObject?: (objectId: string, pose: Pose) => void;
  /** Rendered frame as a JPEG data URL, 10 Hz — the same payload the webcam path sends. */
  onViewUpdate?: (image: string) => void;
}

// Not connected to anything yet, on purpose: each callback's signature is
// the one in Props above; this default simply drops the event.
const notWired = () => {};

export default function SimulatorTraineeView({
  initialScene = kitScene,
  onGrabObject = notWired,
  onMoveObject = notWired,
  onPlaceObject = notWired,
  onViewUpdate = notWired,
}: Props) {
  return (
    <Simulator
      src={SIMULATOR_URL}
      initialScene={initialScene}
      onGrabObject={onGrabObject}
      onMoveObject={onMoveObject}
      onPlaceObject={onPlaceObject}
      onViewUpdate={onViewUpdate}
      frameRate={10}
      style={{
        width: '100%',
        aspectRatio: '16 / 10',
        borderRadius: 12,
        border: '1px solid var(--hairline)',
      }}
    />
  );
}
