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
 * The simulator itself runs in an iframe (the plain-JS bench served from
 * `src`, with `?bridge=1&embed=1`); this component owns the postMessage
 * protocol so callers never see it.
 *
 * Pose convention matches aristos `step_3d_paths.json`: millimetres, Y up,
 * XYZ Euler radians (roll→x, pitch→y, yaw→z), position of the GLB node origin.
 */
import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
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

export interface SimulatorHandle {
  /** Current pose of every part. */
  getScene: () => Promise<Array<{ id: string; name: string; key: string; pose: Pose }>>;
  /** Replace the whole scene. */
  setScene: (parts: ScenePart[]) => void;
}

const DEFAULT_SRC = 'http://127.0.0.1:8123/index.html';

type BenchMessage =
  | { type: 'kb:ready'; protocol: number; keys: string[] }
  | { type: 'kb:grab' | 'kb:move' | 'kb:place'; id: string; name: string; key: string; pose: Pose }
  | { type: 'kb:frame'; image: string; t: number }
  | { type: 'kb:scene'; parts: Array<{ id: string; name: string; key: string; pose: Pose }> }
  | { type: 'kb:warn'; message: string };

const Simulator = forwardRef<SimulatorHandle, SimulatorProps>(function Simulator(props, ref) {
  const {
    initialScene, onReady, src = DEFAULT_SRC,
    frameRate = 10, moveRate = 30, frameWidth = 960, className, style,
  } = props;

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const originRef = useRef<string>('*');
  const sceneWaiters = useRef<Array<(parts: any) => void>>([]);

  // Latest-callback refs: the message listener is registered once and must
  // never go stale, however often the parent re-renders with new closures.
  const cb = useRef(props);
  cb.current = props;

  const post = (msg: object) => {
    iframeRef.current?.contentWindow?.postMessage(msg, originRef.current);
  };

  useEffect(() => {
    try { originRef.current = new URL(src).origin; } catch { originRef.current = '*'; }

    const onMessage = (ev: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || ev.source !== frame.contentWindow) return;
      const msg = ev.data as BenchMessage;
      if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('kb:')) return;

      switch (msg.type) {
        case 'kb:ready':
          post({
            type: 'kb:init',
            scene: cb.current.initialScene,
            options: { frames: frameRate > 0, fps: frameRate, width: frameWidth, moveHz: moveRate },
          });
          cb.current.onReady?.();
          break;
        case 'kb:grab':  cb.current.onGrabObject?.(msg.id, msg.pose); break;
        case 'kb:move':  cb.current.onMoveObject?.(msg.id, msg.pose); break;
        case 'kb:place': cb.current.onPlaceObject?.(msg.id, msg.pose); break;
        case 'kb:frame': cb.current.onViewUpdate?.(msg.image); break;
        case 'kb:scene':
          sceneWaiters.current.splice(0).forEach((resolve) => resolve(msg.parts));
          break;
        case 'kb:warn':
          console.warn('[Simulator]', msg.message);
          break;
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [src, frameRate, moveRate, frameWidth]);

  useImperativeHandle(ref, () => ({
    getScene: () => new Promise((resolve) => {
      sceneWaiters.current.push(resolve);
      post({ type: 'kb:getScene' });
    }),
    setScene: (parts) => post({ type: 'kb:setScene', scene: parts }),
  }), []);

  const url = `${src}${src.includes('?') ? '&' : '?'}bridge=1&embed=1`;

  return (
    <iframe
      ref={iframeRef}
      src={url}
      title="Kitbash assembly simulator"
      className={className}
      style={{ border: 0, width: '100%', height: '100%', display: 'block', ...style }}
      allow="fullscreen"
    />
  );
});

export default Simulator;
