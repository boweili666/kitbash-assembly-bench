#!/usr/bin/env python3
"""Build a <Simulator> initialScene from an ARISTOS task_graphs.db.

    python3 tools/scene_from_db.py path/to/task_graphs.db [--step N] [--out scene.json]

Every part that has a 3D path gets its pose at the end of step N (default: the
last step), expressed exactly as the DB stores it: mm, Y up, XYZ Euler radians,
GLB node origin. Parts are referenced by their model UUID as
/assembly_graph_assets/<model>.glb, which bridge.js resolves to a bench part
type; unknown models are skipped by the bench with a warning.
"""
import argparse, json, sqlite3, sys

ap = argparse.ArgumentParser()
ap.add_argument("db")
ap.add_argument("--step", type=int, default=None, help="pose as of the end of this step id (default: final)")
ap.add_argument("--out", default="-")
a = ap.parse_args()

c = sqlite3.connect(a.db)
where = f"AND sp.stepId <= {a.step}" if a.step is not None else ""
rows = c.execute(f"""
  SELECT p.uuid, p.name, pt.model, sp.x, sp.y, sp.z, sp.roll, sp.pitch, sp.yaw
  FROM Step3DPaths sp
  JOIN Parts p ON p.id = sp.partId
  JOIN PartTypes pt ON pt.id = p.type
  WHERE sp.id IN (
    SELECT sp2.id FROM Step3DPaths sp2
    WHERE sp2.partId = sp.partId {where}
    ORDER BY sp2.stepId DESC, sp2.stepTime DESC LIMIT 1)
  ORDER BY p.name""").fetchall()

scene = [{
    "id": uuid, "name": name, "glb": f"/assembly_graph_assets/{model}.glb",
    "pose": {"x": round(x, 3), "y": round(y, 3), "z": round(z, 3),
             "roll": round(roll, 4), "pitch": round(pitch, 4), "yaw": round(yaw, 4)},
} for uuid, name, model, x, y, z, roll, pitch, yaw in rows]

out = json.dumps(scene, indent=2)
if a.out == "-": print(out)
else:
    open(a.out, "w").write(out + "\n"); print(f"{len(scene)} parts -> {a.out}", file=sys.stderr)
