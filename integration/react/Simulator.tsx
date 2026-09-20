/**
 * <Simulator> — the Kitbash assembly simulator as a controlled React component.
 *
 *   <Simulator
 *     initialScene={parts}
 *     onGrabObject={(id, pose) => ...}
 *     onMoveObject={(id, pose) => ...}
 *     onPlaceObject={(id, pose) => ...}
 *     onViewUpdate={(image) => ...}      // JPEG data URL, ~10 Hz
 *   />
 *
 * The simulator runs in an iframe (the plain-JS bench served from `src`, with
 * `?bridge=1&embed=1`), or — after ref.popOut() — in its own browser window,
 * where this component keeps showing its live picture. Either way the same
 * postMessage protocol drives it, so callbacks and frames never stop.
 *
 * Pose convention matches aristos `step_3d_paths.json`: millimetres, Y up,
 * XYZ Euler radians (roll→x, pitch→y, yaw→z), position of the GLB node origin.
 */
import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import type { CSSProperties } from 'react';

export interface Pose {
  x: number; y: number; z: number;          // mm
  roll: number; pitch: number; yaw: number; // radians, XYZ order
}

export interface ScenePart {
  /** Part-instance UUID (the assembly graph's part id). Echoed back in every callback. */
  id: string;
  /** Simulator part type, e.g. 'arm_5in' — or give `glb` instead. */
  key?: string;
  /** GLB url; recognised by the model UUID in its file name (assembly_graph_assets/<uuid>.glb). */
  glb?: string;
  /** Display name; defaults to the part type's label. */
  name?: string;
  pose: Pose;
}

export interface SimulatorProps {
  /** Read once, when the bench reports ready. Replace later via ref.setScene(). */
  initialScene: ScenePart[];
  onGrabObject?: (objectId: string, pose: Pose) => void;
  onMoveObject?: (objectId: string, pose: Pose) => void;
  onPlaceObject?: (objectId: string, pose: Pose) => void;
  /** Rendered frame as a JPEG data URL. */
  onViewUpdate?: (image: string) => void;
  /** Fires once the simulator has loaded its part library and the initial scene. */
  onReady?: () => void;
  /** Fires when the simulator moves to its own window (true) or back into the page (false). */
  onPopOutChange?: (poppedOut: boolean) => void;
  /** Assembly state after every place (and after the scene is set). Ground truth — no vision needed. */
  onStateChange?: (state: SimState, lastPlace?: LastPlace) => void;
  /**
   * The trainee tried to snap two parts together (Ctrl-drag). object1 is the part being moved,
   * snapPoint ids are feature names from PartTypeFeatures ('H3', 'P1') or a bounding-box face
   * ('F+y'). success is false when the pair is geometrically incompatible (peg on peg, or a peg
   * wider than the hole); the snap is then refused. Which hole the manual wants is not judged
   * here — see onStateChange.
   */
  onSnapAttempt?: (object1Id: string, object2Id: string, snapPoint1Id: string, snapPoint2Id: string,
                   success: boolean, reason: string | null) => void;
  /** Where the bench is served from. */
  src?: string;
  /** Frame callback rate, Hz. 0 disables frames. */
  frameRate?: number;
  /** Max onMoveObject rate while dragging, Hz. */
  moveRate?: number;
  /** Frame width in px (height follows the viewport's aspect). */
  frameWidth?: number;
  className?: string;
  style?: CSSProperties;
}

/** A part as reported back by the simulator. */
export interface ScenePartState { id: string; name: string; key: string; pose: Pose }

/**
 * Assembly state, recomputed by the simulator after every place from the scene
 * geometry (relative poses against the reference assembly from task_graphs.db).
 *  complete   every part of the step is in place and all prerequisite steps are complete
 *  premature  in place, but a prerequisite step is not — done out of order
 *  available  not done; every prerequisite step is complete
 *  blocked    not done; some prerequisite step is not complete
 */
export type StepState = 'complete' | 'available' | 'premature' | 'blocked';
export interface SimStep { id: string; index: number; name: string; state: StepState; progress: number; requires: string[] }
export interface SimPart { id: string; name: string; step: string; placed: boolean; ok: boolean; by: string | null }
export interface SimIssue { severity: 'error' | 'warn'; message: string; objectId: string | null; step: string | null }
export interface SimState {
  steps: SimStep[];
  parts: SimPart[];
  issues: SimIssue[];
  /** Step id the simulator would show next (an available step, started ones first). */
  next: string | null;
  score: { partsOk: number; partsTotal: number; stepsComplete: number; stepsSettled: number; stepsTotal: number };
}
/** What the trainee just put down, and whether it landed a step. */
export interface LastPlace { objectId: string; pose: Pose; fitsStep: string | null; ok: boolean }

export interface SimulatorHandle {
  /** Current pose of every part. */
  getScene: () => Promise<ScenePartState[]>;
  /** Replace the whole scene. */
  setScene: (parts: ScenePart[]) => void;
  /** Move the simulator into its own window, carrying the current scene along. */
  popOut: () => Promise<void>;
  /** Bring it back into the page, carrying the window's scene along. */
  dockBack: () => Promise<void>;
  /** Whether it is currently in its own window. */
  isPoppedOut: () => boolean;
  /** Current assembly state (same payload as onStateChange). */
  getState: () => Promise<SimState>;
  /** Loop a ghost animation of the next available step on the trainee's current assembly. */
  showNext: () => void;
  /** Same, for a specific step (task-graph step id or answer index). */
  showStep: (step: string | number) => void;
  hideAnswer: () => void;
  /** Tint a part (CSS color or 0xrrggbb); null clears. */
  highlight: (objectId: string, color: string | number | null) => void;
  /** Make two parts move as one from now on (e.g. after a step is confirmed complete). */
  fuse: (parentId: string, childId: string) => void;
  unfuse: (childId: string) => void;
}

const DEFAULT_SRC = 'http://127.0.0.1:8123/index.html';
const POPUP_NAME = 'aristos-simulator';
const POPUP_FEATURES = 'width=1280,height=800,menubar=no,toolbar=no,location=no';

type BenchMessage =
  | { type: 'kb:ready'; protocol: number; keys: string[] }
  | { type: 'kb:grab' | 'kb:move' | 'kb:place'; id: string; name: string; key: string; pose: Pose }
  | { type: 'kb:frame'; image: string; t: number }
  | { type: 'kb:scene'; parts: ScenePartState[] }
  | { type: 'kb:state'; state: SimState; lastPlace?: LastPlace }
  | { type: 'kb:snapAttempt'; object1: string; object2: string; snapPoint1: string; snapPoint2: string;
      success: boolean; reason: string | null }
  | { type: 'kb:warn'; message: string };

const Simulator = forwardRef<SimulatorHandle, SimulatorProps>(function Simulator(props, ref) {
  // initialScene and the callbacks are read through `cb` (below), never here,
  // so a parent re-rendering with new closures cannot restart anything.
  const { src = DEFAULT_SRC, frameRate = 10, moveRate = 30, frameWidth = 960, className, style } = props;

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const popupRef = useRef<Window | null>(null);
  const originRef = useRef<string>('*');
  const sceneWaiters = useRef<Array<(parts: ScenePartState[]) => void>>([]);
  const stateWaiters = useRef<Array<(state: SimState) => void>>([]);
  // The scene the *next* bench window is initialised with: the caller's
  // initialScene at first, then whatever the last window reported, so popping
  // out and docking back never lose the trainee's progress.
  const sceneRef = useRef<ScenePart[] | null>(null);
  const [popped, setPopped] = useState(false);
  const [lastFrame, setLastFrame] = useState<string>('');

  const cb = useRef(props);
  cb.current = props;

  // Helpers that only touch refs, created once so effects and the imperative
  // handle can use them without listing them as dependencies.
  const api = useRef<{
    benchWindow: () => Window | null;
    post: (msg: object) => void;
    requestScene: () => Promise<ScenePartState[]>;
    snapshotScene: () => Promise<void>;
    url: (embed: boolean) => string;
  } | null>(null);
  if (!api.current) {
    const benchWindow = () => popupRef.current ?? iframeRef.current?.contentWindow ?? null;
    const post = (msg: object) => { benchWindow()?.postMessage(msg, originRef.current); };
    const requestScene = () => new Promise<ScenePartState[]>((resolve) => {
      sceneWaiters.current.push(resolve);
      post({ type: 'kb:getScene' });
    });
    const snapshotScene = async () => {
      if (!benchWindow()) return;
      const parts = await Promise.race([requestScene(), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
      if (parts) sceneRef.current = parts.map((p) => ({ id: p.id, key: p.key, name: p.name, pose: p.pose }));
    };
    const url = (embed: boolean) => {
      const base = cb.current.src ?? DEFAULT_SRC;
      return `${base}${base.includes('?') ? '&' : '?'}bridge=1${embed ? '&embed=1' : ''}`;
    };
    api.current = { benchWindow, post, requestScene, snapshotScene, url };
  }
  const { url } = api.current;

  useEffect(() => {
    try { originRef.current = new URL(src, window.location.href).origin; } catch { originRef.current = '*'; }

    const { benchWindow, post } = api.current!;
    const onMessage = (ev: MessageEvent) => {
      if (!ev.source || ev.source !== benchWindow()) return;
      const msg = ev.data as BenchMessage;
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('kb:')) return;

      switch (msg.type) {
        case 'kb:ready':
          post({
            type: 'kb:init',
            scene: sceneRef.current ?? cb.current.initialScene,
            options: { frames: frameRate > 0, fps: frameRate, width: frameWidth, moveHz: moveRate },
          });
          cb.current.onReady?.();
          break;
        case 'kb:grab':  cb.current.onGrabObject?.(msg.id, msg.pose); break;
        case 'kb:move':  cb.current.onMoveObject?.(msg.id, msg.pose); break;
        case 'kb:place':
          // keep the carry-over scene current even if the window is closed abruptly
          if (sceneRef.current) {
            const p = sceneRef.current.find((s) => s.id === msg.id);
            if (p) p.pose = msg.pose;
          }
          cb.current.onPlaceObject?.(msg.id, msg.pose);
          break;
        case 'kb:frame':
          if (popupRef.current) setLastFrame(msg.image);
          cb.current.onViewUpdate?.(msg.image);
          break;
        case 'kb:scene':
          sceneWaiters.current.splice(0).forEach((resolve) => resolve(msg.parts));
          break;
        case 'kb:snapAttempt':
          cb.current.onSnapAttempt?.(msg.object1, msg.object2, msg.snapPoint1, msg.snapPoint2, msg.success, msg.reason);
          break;
        case 'kb:state':
          stateWaiters.current.splice(0).forEach((resolve) => resolve(msg.state));
          cb.current.onStateChange?.(msg.state, msg.lastPlace);
          break;
        case 'kb:warn':
          console.warn('[Simulator]', msg.message);
          break;
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [src, frameRate, moveRate, frameWidth]);

  // A popped-out window the user closes by hand docks the simulator back.
  useEffect(() => {
    if (!popped) return;
    const timer = window.setInterval(() => {
      if (popupRef.current && popupRef.current.closed) {
        popupRef.current = null;
        setPopped(false);
        cb.current.onPopOutChange?.(false);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [popped]);

  useEffect(() => () => { popupRef.current?.close(); }, []);

  useImperativeHandle(ref, () => {
    const { post, requestScene, snapshotScene, url } = api.current!;
    return {
    getScene: requestScene,
    setScene: (parts) => { sceneRef.current = parts; post({ type: 'kb:setScene', scene: parts }); },
    popOut: async () => {
      if (popupRef.current && !popupRef.current.closed) { popupRef.current.focus(); return; }
      await snapshotScene();
      const w = window.open(url(false), POPUP_NAME, POPUP_FEATURES);
      if (!w) { console.warn('[Simulator] popup blocked'); return; }
      popupRef.current = w;
      setLastFrame('');
      setPopped(true);
      cb.current.onPopOutChange?.(true);
    },
    dockBack: async () => {
      if (!popupRef.current) return;
      await snapshotScene();
      popupRef.current.close();
      popupRef.current = null;
      setPopped(false);
      cb.current.onPopOutChange?.(false);
    },
    isPoppedOut: () => !!popupRef.current && !popupRef.current.closed,
    getState: () => new Promise<SimState>((resolve) => {
      stateWaiters.current.push(resolve);
      post({ type: 'kb:getState' });
    }),
    showNext: () => post({ type: 'kb:showNext' }),
    showStep: (step) => post({ type: 'kb:showStep', step }),
    hideAnswer: () => post({ type: 'kb:hideAnswer' }),
    highlight: (objectId, color) => post({ type: 'kb:highlight', id: objectId, color }),
    fuse: (parentId, childId) => post({ type: 'kb:fuse', parentId, childId }),
    unfuse: (childId) => post({ type: 'kb:unfuse', childId }),
    };
  }, []);

  const box: CSSProperties = { border: 0, width: '100%', height: '100%', display: 'block', ...style };

  if (popped) {
    // Live picture of the separate window, so the page still shows what the trainee does.
    return lastFrame
      ? <img src={lastFrame} alt="Assembly simulator (in its own window)" className={className}
             style={{ ...box, objectFit: 'contain', background: '#171b21' }} />
      : <div className={className} style={{ ...box, background: '#171b21', color: '#8d97a5',
             display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>
          Simulator is open in its own window…
        </div>;
  }

  return (
    <iframe
      ref={iframeRef}
      src={url(true)}
      title="Kitbash assembly simulator"
      className={className}
      style={box}
      allow="fullscreen"
    />
  );
});

export default Simulator;
