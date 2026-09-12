/**
 * SimulatorTraineeView — the Kitbash assembly simulator standing in for the
 * trainee's camera when there are no physical parts to assemble.
 *
 * This is the integration surface and nothing more: every callback Dana asked
 * for is exposed here and left EMPTY on purpose. ARISTOS decides what each one
 * feeds (a socket event, the tutor, a log); this file does not emit, fetch or
 * store anything. See docs/ARISTOS_INTEGRATION.md for the suggested wiring.
 *
 * Drop-in: copy this file and Simulator.tsx into aristos_frontend/src/, and
 * render <SimulatorTraineeView session={session} /> where TraineeCam renders
 * <Webcam> today (behind a Real / Sim toggle, or as the only view when the
 * session is flagged as simulated).
 */
import Simulator, { type Pose, type ScenePart } from '../Simulator';
import kitScene from './kit_scene.json';

// Where the simulator itself is served from. `python3 serve.py` in the
// kitbash repo (port 8123), or a static copy of dist/kitbash-standalone.html.
const SIMULATOR_URL =
  (import.meta as any).env?.VITE_SIMULATOR_URL || 'http://127.0.0.1:8123/index.html';

interface Props {
  /** The ARISTOS session; only its id is read here, for the integrator's convenience. */
  session: { id: string };
  /**
   * Parts on the table when the session starts. Default: every modelled part
   * of the current task graph laid out by type (tools/scene_from_db.py
   * --layout kit). Pass the output of --layout installed --step N to start a
   * session mid-build.
   */
  initialScene?: ScenePart[];
}

export default function SimulatorTraineeView({ session, initialScene }: Props) {
  // ---- Integration points -------------------------------------------------
  // Each receives the part-instance UUID from the task graph (Parts.uuid) and
  // the part's pose: mm, Y up, XYZ Euler radians, GLB node origin — the same
  // convention as Step3DPaths, so it can be compared with the graph directly.

  const onGrabObject = (objectId: string, pose: Pose) => {
    // TODO(ARISTOS): the trainee picked a part up.
    // e.g. socket.emit('session-sim-action', { sessionID: session.id, action: 'grab', objectId, pose })
    void objectId; void pose;
  };

  const onMoveObject = (objectId: string, pose: Pose) => {
    // TODO(ARISTOS): the part is being moved (≤ 30 Hz while dragging).
    void objectId; void pose;
  };

  const onPlaceObject = (objectId: string, pose: Pose) => {
    // TODO(ARISTOS): the trainee put the part down. This is the natural moment
    // to compare `pose` against the step's target in Step3DPaths.
    void objectId; void pose;
  };

  const onViewUpdate = (image: string) => {
    // TODO(ARISTOS): rendered frame, JPEG data URL, 10 Hz — the same payload
    // TraineeCam sends from the webcam today:
    // socket.emit('session-video-frame', { sessionID: session.id, payload: { data: image } })
    void image;
  };
  // -------------------------------------------------------------------------

  void session;

  return (
    <Simulator
      src={SIMULATOR_URL}
      initialScene={initialScene ?? (kitScene as ScenePart[])}
      onGrabObject={onGrabObject}
      onMoveObject={onMoveObject}
      onPlaceObject={onPlaceObject}
      onViewUpdate={onViewUpdate}
      frameRate={10}
      style={{ width: '100%', aspectRatio: '16 / 10', borderRadius: 12, border: '1px solid var(--hairline)' }}
    />
  );
}
