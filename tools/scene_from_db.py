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
ap.add_argument("--layout", choices=["installed", "kit"], default="installed",
                help="installed: pose from Step3DPaths (default); kit: every part with a model laid out on the table")
ap.add_argument("--models", help="models dir (needed for --layout kit, to size the grid cells)")
ap.add_argument("--table-width", type=float, default=560.0, help="kit: wrap rows beyond this width (mm)")
a = ap.parse_args()

c = sqlite3.connect(a.db)


def installed_scene():
    """Every part with a 3D path, at its pose at the end of step --step (default: final)."""
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
    return [{
        "id": uuid, "name": name, "glb": f"/assembly_graph_assets/{model}.glb",
        "pose": {"x": round(x, 3), "y": round(y, 3), "z": round(z, 3),
                 "roll": round(roll, 4), "pitch": round(pitch, 4), "yaw": round(yaw, 4)},
    } for uuid, name, model, x, y, z, roll, pitch, yaw in rows]


def kit_scene():
    """Every part instance whose type has a model, standing on the table (y = 0) in
    rows grouped by type, largest types first. Poses are the GLB origin, upright
    as modelled, so screws stand on their heads exactly like the hand-made kit."""
    import pathlib, trimesh
    if not a.models:
        sys.exit("--layout kit needs --models DIR")
    models = {f.stem.replace("-", "").lower(): f for f in pathlib.Path(a.models).glob("*.glb")}
    types = []
    for pid, name, model in c.execute("SELECT id, name, model FROM PartTypes ORDER BY id"):
        f = models.get((model or "").replace("-", "").lower())
        if not f:
            continue
        mesh = trimesh.load(f, force="mesh")
        mm = 1.0 if float(mesh.extents.max()) > 1 else 1000.0
        bmin, bmax = mesh.bounds * mm
        parts = c.execute("SELECT uuid, name FROM Parts WHERE type=? ORDER BY name", (pid,)).fetchall()
        if parts:
            types.append(dict(model=model, bmin=bmin, bmax=bmax, parts=parts))
    # big flat things at the back, hardware up front
    types.sort(key=lambda t: -(t["bmax"][0] - t["bmin"][0]) * (t["bmax"][2] - t["bmin"][2]))

    import numpy as np
    from scipy.spatial.transform import Rotation as Rot

    def lay_flat(bmin, bmax):
        """Plate-like parts (thinnest side well under the other two) lie on their
        big face: rotate so the thin axis points up. Everything else -- screws,
        standoffs, motors -- stays as modelled. Returns (euler_xyz, R)."""
        ext = bmax - bmin
        thin = int(np.argmin(ext))
        if ext[thin] > 0.3 * np.sort(ext)[1] or thin == 1:
            return (0.0, 0.0, 0.0), np.eye(3)
        eul = (np.pi / 2, 0.0, 0.0) if thin == 2 else (0.0, 0.0, np.pi / 2)   # Z→Y or X→Y
        return eul, Rot.from_euler("xyz", eul).as_matrix()

    for t in types:                                    # rotated footprints
        eul, R = lay_flat(t["bmin"], t["bmax"])
        corners = np.array([[x, y, z] for x in (t["bmin"][0], t["bmax"][0])
                            for y in (t["bmin"][1], t["bmax"][1]) for z in (t["bmin"][2], t["bmax"][2])]) @ R.T
        t["eul"], t["rmin"], t["rmax"] = eul, corners.min(0), corners.max(0)
    types.sort(key=lambda t: -(t["rmax"][0] - t["rmin"][0]) * (t["rmax"][2] - t["rmin"][2]))

    GAP, ROW_GAP = 10.0, 22.0
    scene, x, z, row_depth = [], 0.0, 0.0, 0.0
    for t in types:
        w = t["rmax"][0] - t["rmin"][0]
        d = t["rmax"][2] - t["rmin"][2]
        if x > 0 and x + w > a.table_width:            # wrap
            x, z, row_depth = 0.0, z + row_depth + ROW_GAP, 0.0
        for uuid, name in t["parts"]:
            if x > 0 and x + w > a.table_width:
                x, z, row_depth = 0.0, z + row_depth + ROW_GAP, 0.0
            # world = R·p + o: put the rotated bbox in the cell, bottom on the table
            ox = x + w / 2 - (t["rmin"][0] + t["rmax"][0]) / 2
            oz = z + d / 2 - (t["rmin"][2] + t["rmax"][2]) / 2
            oy = -t["rmin"][1]
            scene.append({"id": uuid, "name": name, "glb": f"/assembly_graph_assets/{t['model']}.glb",
                          "pose": {"x": round(ox, 2), "y": round(oy, 2), "z": round(oz, 2),
                                   "roll": round(t["eul"][0], 4), "pitch": round(t["eul"][1], 4), "yaw": round(t["eul"][2], 4)}})
            x += w + GAP
            row_depth = max(row_depth, d)
    # centre the whole table on the origin
    xs = [p["pose"]["x"] for p in scene]; zs = [p["pose"]["z"] for p in scene]
    cx, cz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
    for p in scene:
        p["pose"]["x"] = round(p["pose"]["x"] - cx, 2); p["pose"]["z"] = round(p["pose"]["z"] - cz, 2)
    return scene


scene = kit_scene() if a.layout == "kit" else installed_scene()

out = json.dumps(scene, indent=2)
if a.out == "-": print(out)
else:
    open(a.out, "w").write(out + "\n"); print(f"{len(scene)} parts -> {a.out}", file=sys.stderr)
