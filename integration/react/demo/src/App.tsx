import { useRef, useState, useCallback } from 'react';
import Simulator, { type Pose, type SimulatorHandle } from '../../Simulator';
import scene from './scene';

type Row = { t: number; kind: 'ready' | 'grab' | 'move' | 'place' | 'scene'; id?: string; pose?: Pose; text?: string };

const fmt = (p: Pose) =>
  `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)} mm · ` +
  `rpy ${p.roll.toFixed(2)} ${p.pitch.toFixed(2)} ${p.yaw.toFixed(2)}`;

export default function App() {
  const sim = useRef<SimulatorHandle>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [frame, setFrame] = useState<string>('');
  const [frames, setFrames] = useState(0);
  const [moves, setMoves] = useState(0);
  const t0 = useRef(performance.now());

  const log = useCallback((r: Omit<Row, 't'>) =>
    setRows((rs) => [{ t: performance.now() - t0.current, ...r }, ...rs].slice(0, 60)), []);

  const short = (id: string) => id.slice(0, 8);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', height: '100vh', fontFamily: 'system-ui', fontSize: 13 }}>
      <Simulator
        ref={sim}
        initialScene={scene}
        onReady={() => log({ kind: 'ready', text: `initialScene: ${scene.length} parts` })}
        onGrabObject={(id, pose) => log({ kind: 'grab', id, pose })}
        onMoveObject={(id, pose) => { setMoves((n) => n + 1); log({ kind: 'move', id, pose }); }}
        onPlaceObject={(id, pose) => log({ kind: 'place', id, pose })}
        onViewUpdate={(img) => { setFrame(img); setFrames((n) => n + 1); }}
      />
      <aside style={{ background: '#171b21', color: '#e7ecf2', padding: 12, overflow: 'auto', borderLeft: '1px solid #2a313b' }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 14, letterSpacing: '.08em', textTransform: 'uppercase', color: '#8d97a5' }}>
          &lt;Simulator&gt; callbacks
        </h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <button data-testid="getScene" onClick={async () => {
            const parts = await sim.current!.getScene();
            log({ kind: 'scene', text: parts.map((p) => `${p.name} @ ${p.pose.x.toFixed(1)},${p.pose.y.toFixed(1)},${p.pose.z.toFixed(1)}`).join(' | ') });
            (window as any).__lastScene = parts;
          }}>getScene()</button>
          <span data-testid="counters" style={{ color: '#8d97a5' }}>frames {frames} · moves {moves}</span>
        </div>
        {frame && <img src={frame} alt="onViewUpdate" style={{ width: '100%', borderRadius: 6, border: '1px solid #2a313b', marginBottom: 8 }} />}
        <ol data-testid="log" style={{ listStyle: 'none', margin: 0, padding: 0, fontFamily: 'ui-monospace, monospace', fontSize: 11.5 }}>
          {rows.map((r, i) => (
            <li key={i} data-kind={r.kind} style={{ padding: '4px 0', borderBottom: '1px solid #232932' }}>
              <span style={{ color: '#5c6673' }}>{(r.t / 1000).toFixed(2)}s </span>
              <b style={{ color: { ready: '#6cc08b', grab: '#e8a33d', move: '#8d97a5', place: '#6cc08b', scene: '#9fb3ff' }[r.kind] }}>{r.kind}</b>
              {r.id && <span style={{ color: '#c9d1da' }}> {short(r.id)}…</span>}
              {r.pose && <div style={{ color: '#8d97a5' }}>{fmt(r.pose)}</div>}
              {r.text && <div style={{ color: '#8d97a5', wordBreak: 'break-word' }}>{r.text}</div>}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
