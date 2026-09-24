#!/usr/bin/env python3
"""Export the final pose of every part of the fully assembled drone.

    python3 tools/export_final_poses.py

Writes docs/final_poses.json and docs/final_poses.csv from
assets/parts/answer_poses_full.json (the reference assembly the simulator
checks against: the 53 poses captured in ARISTOS plus the 21 derived by
tools/derive_final_assembly.py).

Pose convention = Step3DPaths: millimetres, Y up, XYZ Euler radians
(R = Rx·Ry·Rz), position of the GLB node origin. All poses share one frame,
the reference-assembly frame; a part's pose relative to another part is
what the simulator's checks compare.

part_id is the task-graph part instance UUID (Parts.uuid) - the same id the
host passes in the scene and gets back in every callback.
"""
import csv, json, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
ANSWER = ROOT / 'assets/parts/answer_poses_full.json'
OUT_JSON = ROOT / 'docs/final_poses.json'
OUT_CSV = ROOT / 'docs/final_poses.csv'
FIELDS = ['x', 'y', 'z', 'roll', 'pitch', 'yaw']


def main():
    answer = json.loads(ANSWER.read_text())
    steps = {s['i']: s for s in answer['steps']}
    rows = []
    for p in sorted(answer['parts'], key=lambda p: (p['step'], p['name'])):
        final = p['path'][-1]
        st = steps.get(p['step'], {})
        rows.append({
            'part_id': p['id'], 'name': p['name'], 'type': p['key'],
            'step_index': p['step'], 'step_name': st.get('name'),
            'source': 'derived' if p.get('derived') else 'captured',
            **{k: round(float(final[k]), 4) for k in FIELDS},
        })
    OUT_JSON.write_text(json.dumps({
        'units': {'position': 'mm', 'rotation': 'rad, XYZ Euler (R = Rx*Ry*Rz)'},
        'axes': 'Y up; position is the GLB node origin; one shared reference-assembly frame',
        'parts': rows,
    }, indent=1, ensure_ascii=False) + '\n')
    with OUT_CSV.open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print(f'{len(rows)} parts -> {OUT_JSON.relative_to(ROOT)}, {OUT_CSV.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
