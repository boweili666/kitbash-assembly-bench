#!/usr/bin/env python3
"""Derive a part's missing holes from the reference assembly, then measure them on the mesh.

Where a contributor file labels only the holes a task step needs, the rest of a
part's holes are missing -- the arm, for instance, carries only the hole that
pins it to the front plate, although four motor screws and the motor boss pass
straight through it.  Those partners *are* labelled and their installed poses
are known, so every such axis is already pinned down by the final assembly:

    partner peg (P*) at its installed pose  ->  axis in the target part's frame

The axis fixes the position; the mesh fixes the size.  Around each axis the
script casts rays to measure the bore radius and the material thickness, and
keeps the axis only where a real bore is found -- so a screw that merely passes
*beside* the part is dropped.

    python3 tools/holes_from_answer.py arm_5in                  # report
    python3 tools/holes_from_answer.py arm_5in --write          # patch the manifest
    python3 tools/holes_from_answer.py arm_5in --out arm.json   # contributor file

Geometry is computed in the model's own frame (the GLB node origin, Y up), the
same convention as Step3DPaths and tools/features_db.py.
"""
import argparse
import json
import pathlib

import numpy as np
import trimesh

ROOT = pathlib.Path(__file__).resolve().parent.parent
PARTS = ROOT / "assets" / "parts"
RAYS = 24               # rays per measurement circle
CLEARANCE_MM = 0.15     # a bore this much wider than the peg still counts as its hole
MIN_DIA_MM = 1.5
SEAT_GAP_MM = 1.5       # a boss seated in a bore may stop this far short of the far face
FIT_SLACK = 0.85        # a bore measuring this fraction of the peg still counts as its bore


def rot(roll, pitch, yaw):
    """XYZ Euler (R = Rx·Ry·Rz), the pose convention of Step3DPaths."""
    cx, sx, cy, sy, cz, sz = (np.cos(roll), np.sin(roll), np.cos(pitch),
                              np.sin(pitch), np.cos(yaw), np.sin(yaw))
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return rx @ ry @ rz


class Frame:
    """A part instance placed in the assembly: model frame (mm) <-> world (mm)."""

    def __init__(self, pose):
        self.R = rot(pose.get("roll", 0.0), pose.get("pitch", 0.0), pose.get("yaw", 0.0))
        self.t = np.array([pose.get("x", 0.0), pose.get("y", 0.0), pose.get("z", 0.0)])

    def to_world(self, p_mm):
        return self.R @ np.asarray(p_mm) + self.t

    def dir_to_world(self, d):
        return self.R @ np.asarray(d)

    def from_world(self, p_world):
        return self.R.T @ (np.asarray(p_world) - self.t)

    def dir_from_world(self, d):
        return self.R.T @ np.asarray(d)


def perpendicular(d):
    u = np.array([0.0, 1.0, 0.0]) if abs(d[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(u, d)
    u /= np.linalg.norm(u)
    return u, np.cross(d, u)


def span_along(mesh, c, d):
    """Where the part sits along the axis, as a [t_min, t_max] range around c."""
    t = (mesh.vertices - c) @ d
    return float(t.min()), float(t.max())


def probe_point(mesh, c, d, peg_len):
    """Move the test point to where the peg meets the part.

    A peg is given by its own centre; a screw head sitting 10 mm below a plate
    would otherwise be measured in thin air.  The peg's reach is stretched by
    SEAT_GAP_MM at both ends: a boss that seats flush in a counterbore stops a
    few tenths short of the far face, and that bore is still its bore."""
    lo, hi = span_along(mesh, c, d)
    a = max(lo, -peg_len / 2 - SEAT_GAP_MM)
    b = min(hi, peg_len / 2 + SEAT_GAP_MM)
    if b <= a:
        return None
    return c + d * (a + b) / 2


def measure_bore(mesh, c, d, want_r, max_r):
    """Radius and axial extent of the bore around the axis (c, d), or None.

    The radius is the median first hit of rays fired outwards from the axis;
    the extent comes from rays fired along the axis from inside the wall.
    """
    u, v = perpendicular(d)
    angles = np.linspace(0, 2 * np.pi, RAYS, endpoint=False)
    dirs = np.array([np.cos(a) * u + np.sin(a) * v for a in angles])

    def cast(at):
        origins = np.repeat(at[None, :], RAYS, axis=0)
        hits, index_ray = mesh.ray.intersects_location(origins, dirs, multiple_hits=False)[:2]
        if len(index_ray) < RAYS * 0.8:
            return None                               # the axis is not inside a bore
        return hits, dirs[index_ray], np.linalg.norm(hits - origins[index_ray], axis=1)

    # re-centre once: the partner's axis may sit anywhere inside a slot, and the
    # half-width only reads true from the middle of the bore.  Measure again at
    # the new centre, so the radius and the centre always describe the same spot
    # (a re-centring that walks into solid material fails this second cast).
    shot = cast(c)
    if shot is None:
        return None
    off = shot[0].mean(axis=0) - c
    c = c + off - d * float(np.dot(off, d))
    shot = cast(c)
    if shot is None:
        return None
    hits, hit_dirs, dist = shot
    # a motor-mount slot is long in one direction: what fits a screw is the half-width,
    # so take a low percentile rather than the median
    r = float(np.percentile(dist, 25))
    if r > max_r or r < MIN_DIA_MM / 2:
        return None
    # The reference assembly says this peg sits in this bore, so a bore that reads
    # slightly narrow is a measurement/CAD-tolerance artefact, not a rejection --
    # only a bore far too small means "this is some other hole the peg misses".
    if r + CLEARANCE_MM < want_r and r < want_r * FIT_SLACK:
        return None

    # thickness: step just past the bore wall, then see how far the surface is
    # each way along the axis.  A cut-out is not a tube -- walk the directions
    # from nearest wall outwards until one of them lands in solid material.
    order = np.argsort(dist)
    for j in order:
        probe = c + hit_dirs[j] * (dist[j] + 0.3)
        ends = []
        for sign in (1.0, -1.0):
            pts, idx = mesh.ray.intersects_location(probe[None, :], (sign * d)[None, :],
                                                    multiple_hits=False)[:2]
            if not len(idx):
                break
            ends.append(sign * float(np.linalg.norm(pts[0] - probe)))
        if len(ends) != 2:
            continue
        lo, hi = min(ends), max(ends)
        if hi - lo > 0.05:
            return r, c + d * (lo + hi) / 2, hi - lo
    return None


def spec_of(manifest, key):
    for p in manifest["parts"]:
        if p["key"] == key:
            return p
    raise SystemExit(f"unknown part key: {key}")


def to_model_mm(spec, c_units, unit_scale, mm_per_unit):
    """manifest local units -> the part's own model frame in millimetres"""
    return (np.asarray(c_units) / unit_scale + np.asarray(spec["offset"])) * mm_per_unit


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("key", help="part key to label, e.g. arm_5in")
    ap.add_argument("--manifest", default=str(PARTS / "manifest.json"))
    ap.add_argument("--models", default=str(PARTS), help="directory holding <key>.glb")
    ap.add_argument("--write", action="store_true", help="add the holes to the manifest")
    ap.add_argument("--out", help="also write a contributor part_features.json here")
    a = ap.parse_args()

    manifest = json.loads(pathlib.Path(a.manifest).read_text())
    answer = manifest.get("answer")
    if not answer:
        raise SystemExit("this manifest carries no reference assembly")
    S = manifest["unitScale"]
    target = spec_of(manifest, a.key)

    mesh = trimesh.load(pathlib.Path(a.models) / target["file"], force="mesh")
    mm_per_unit = 1.0 if float(mesh.extents.max()) > 1 else 1000.0
    mesh_mm = mesh.copy()
    mesh_mm.apply_scale(mm_per_unit)
    ext = float(mesh_mm.extents.max())

    by_key = {}
    for p in manifest["parts"]:
        by_key[p["key"]] = p
    instances = [p for p in answer["parts"] if p["key"] == a.key]
    if not instances:
        raise SystemExit(f"{a.key} does not appear in the reference assembly")
    print(f"{a.key}: {len(instances)} instance(s) in the reference assembly, "
          f"{len(target['holes'])} hole(s) labelled")

    # every peg in the assembly, as an axis in world millimetres
    pegs = []
    for q in answer["parts"]:
        qs = by_key.get(q["key"])
        if not qs or q["key"] == a.key:
            continue
        frame = Frame(q["path"][-1])
        for f in qs["pegs"]:
            c = to_model_mm(qs, f["c"], S, mm_per_unit)
            d = np.asarray(f["d"], dtype=float)
            pegs.append({
                "name": q["name"], "id": f["id"],
                "c": frame.to_world(c), "d": frame.dir_to_world(d),
                "r": f["r"] / S * mm_per_unit, "len": f["depth"] / S * mm_per_unit,
            })

    found = []
    known = [{
        "c": to_model_mm(target, h["c"], S, mm_per_unit),
        "d": np.asarray(h["d"], dtype=float),
        "r": h["r"] / S * mm_per_unit, "id": h["id"], "existing": True,
    } for h in target["holes"]]

    for inst in instances:
        frame = Frame(inst["path"][-1])
        for peg in pegs:
            c = frame.from_world(peg["c"])
            d = frame.dir_from_world(peg["d"])
            d /= np.linalg.norm(d)
            # the peg has to reach the part at all
            near = np.clip(c, mesh_mm.bounds[0], mesh_mm.bounds[1])
            if np.linalg.norm(near - c) > peg["len"] / 2 + SEAT_GAP_MM + ext:
                continue
            probe = probe_point(mesh_mm, c, d, peg["len"])
            if probe is None:
                continue
            got = measure_bore(mesh_mm, probe, d, peg["r"], max_r=ext * 0.35)
            if not got:
                continue
            r, centre, depth = got
            # the peg demonstrably passes here, so the hole is at least peg-sized:
            # never hand the simulator a hole its own partner would bounce off
            r = max(r, peg["r"])
            entry = {"c": centre, "d": d, "r": r, "depth": depth,
                     "via": [f"{peg['name']}·{peg['id']}"]}
            if any(same_axis(entry, k) for k in known):
                continue
            hit = next((f for f in found if same_axis(entry, f)), None)
            if hit:
                # several screws land in the same slot (different arms, different
                # motor positions): average them and keep the tightest measurement
                n = len(hit["via"])
                hit["c"] = (np.asarray(hit["c"]) * n + centre) / (n + 1)
                hit.setdefault("radii", [hit["r"]]).append(r)
                hit["r"] = float(np.median(hit["radii"]))
                hit["via"].append(entry["via"][0])
                continue
            found.append(entry)

    if not found:
        print("  nothing new: every partner axis is already labelled or has no bore here")
        return

    k = mm_per_unit / 1.0
    next_n = 1 + max([int(h["id"][1:]) for h in target["holes"]] or [0])
    new = []
    for i, f in enumerate(sorted(found, key=lambda f: (-f["r"], f["c"][0]))):
        fid = f"H{next_n + i}"
        new.append({
            "id": fid,
            "c": [round(float(x), 4) for x in (f["c"] / mm_per_unit - np.asarray(target["offset"])) * S],
            "d": [round(float(x), 4) for x in f["d"]],
            "r": round(float(f["r"] / mm_per_unit * S), 4),
            "depth": round(float(f["depth"] / mm_per_unit * S), 4),
        })
        print(f"  {fid}  ⌀{f['r'] * 2:6.2f} mm  depth {f['depth']:5.2f} mm  "
              f"at [{f['c'][0]:7.2f} {f['c'][1]:6.2f} {f['c'][2]:7.2f}] mm   from {', '.join(f['via'])}")

    if a.write:
        target["holes"].extend(new)
        pathlib.Path(a.manifest).write_text(json.dumps(manifest, ensure_ascii=False, indent=1),
                                            encoding="utf-8")
        print(f"\nwrote {len(new)} hole(s) into {a.manifest}")
    if a.out:
        holes = target["holes"]
        doc = [{
            "partType": target.get("partTypeUuid"),
            "model": (target.get("models") or [None])[0],
            "name": target.get("name", target["label"]),
            "features": [{
                "name": h["id"], "kind": "hole",
                "center": [round(float(x), 3) for x in to_model_mm(target, h["c"], S, mm_per_unit)],
                "axis": h["d"],
                "diameter": round(h["r"] * 2 / S * mm_per_unit, 3),
                "depth": round(h["depth"] / S * mm_per_unit, 3),
            } for h in holes] + [{
                "name": p["id"], "kind": "peg",
                "center": [round(float(x), 3) for x in to_model_mm(target, p["c"], S, mm_per_unit)],
                "axis": p["d"],
                "diameter": round(p["r"] * 2 / S * mm_per_unit, 3),
                "depth": round(p["depth"] / S * mm_per_unit, 3),
            } for p in target["pegs"]],
            "symmetries": [{"axis": s["axis"], "center": target.get("sym_center"),
                            "degrees": s["deg"]} for s in target.get("sym", [])],
        }]
        pathlib.Path(a.out).write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"wrote {a.out} — import with tools/features_db.py")


def same_axis(x, y):
    """Same bore: parallel axes, centres on top of each other, similar radius."""
    if abs(float(np.dot(x["d"], y["d"]))) < 0.95:
        return False
    v = np.asarray(x["c"]) - np.asarray(y["c"])
    perp = v - np.asarray(y["d"]) * float(np.dot(v, y["d"]))
    # a slot's screws sit a couple of millimetres apart inside one bore, but a wide
    # bore next door is still its own hole -- judge by the *narrower* of the two
    return float(np.linalg.norm(perp)) < min(x["r"], y["r"]) * 1.2 + 0.5


if __name__ == "__main__":
    main()
