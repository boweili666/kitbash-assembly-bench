#!/usr/bin/env python3
"""Reference assembly for the simulator, from a task graph JSON and its step_3d_paths.json.

The ARISTOS task graph (task_graph_*.json: nodes, parts, requirements) gives the steps, their
order and prerequisites, and the part instances; step_3d_paths.json gives every part's pose in
every keyframe of every step. Nothing about this particular product is written here:

  steps       the graph's steps in which some part with a model moves, in the graph's order;
              steps with no motion (tighten, solder, tape, ...) are skipped
  a part      installed in the first step it moves in; its path is that step's trajectory,
              carried to where the part ends up at the end of the build (the checks compare
              against final poses, which are relative to the parts around them)
  assembly    a later step that moves parts installed earlier, rigidly together, is an assembly
  steps       step: each rigid set is a group, the part those groups join is the base, and how
              far each group waited from its final spot is its stage offset
  mates       which parts touch / share a hole axis at the end (features_db.compute_mates)
  kit         every part at its pose in the first keyframe (where the recording laid it out)
  start       when in its step the recording sets the part off (0..1): in one step, of two parts
              that go together the one that starts first goes in first (grommets before the board)
  approach    from the recording; a hole slides onto a peg from the peg's tip, so a part that the
              recording brings onto an earlier part's peg from the root side (through that part)
              comes in mirrored along the peg axis instead

    python3 tools/answer_from_graph.py GRAPH.json PATHS.json FEATURES_DB MODELS_DIR \
        --out assets/parts/answer_graph77.json [--manifest assets/parts/manifest.json]
"""
import argparse, json, pathlib, sqlite3, sys
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from features_db import (part_types, compute_mates, pose_matrix, matrix_pose,  # noqa: E402
                         load_mesh, TRAY_JUMP_MM)

FIELDS = ("x", "y", "z", "roll", "pitch", "yaw")
MOVE_EPS = 1e-6
RIGID_MM = 0.5          # parts moving together keep their relative pose within this
RIGID_DEG = 0.5


def as_tuple(p):
    return tuple(round(float(p[f]), 4 if f in ("roll", "pitch", "yaw") else 3) for f in FIELDS)


def pose_dict(v):
    return dict(zip(FIELDS, v))


def rel(Ma, Mb):
    return np.linalg.inv(Mb) @ Ma


def same_rel(A, B):
    d = np.linalg.inv(A) @ B
    ang = np.degrees(np.arccos(np.clip((np.trace(d[:3, :3]) - 1) / 2, -1, 1)))
    return np.linalg.norm(d[:3, 3]) < RIGID_MM and ang < RIGID_DEG


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("graph"); ap.add_argument("paths"); ap.add_argument("features_db"); ap.add_argument("models")
    ap.add_argument("--out", required=True)
    ap.add_argument("--manifest", help="also put the answer and the kit into this simulator manifest")
    a = ap.parse_args()

    g = json.load(open(a.graph)); P = json.load(open(a.paths))
    db = sqlite3.connect(a.features_db)
    types = {t["uuid"]: t for t in part_types(db, a.models) if t["file"]}
    by_tid = {t["id"]: t for t in types.values()}
    gparts = {p["id"]: p for p in g["parts"]}
    names = {n["id"]: n["name"] for n in g["nodes"]}
    order = [n["id"] for n in g["nodes"]]
    steps = {s["step_id"]: s for s in P["steps"]}

    # keyframes per step: [(time, {part: pose tuple})]
    frames = {sid: [(kf["time"], {p["part_id"]: as_tuple(p) for p in kf["poses"]}) for kf in s["3d_path"]]
              for sid, s in steps.items()}
    recorded = set().union(*[set(f[0][1]) for f in frames.values()])
    live = sorted(pid for pid in recorded if pid in gparts and gparts[pid]["type"] in types)
    skipped_parts = sorted(gparts[pid]["name"] for pid in gparts if pid not in live)

    def moved(sid):
        f = frames.get(sid)
        if not f: return []
        a0, a1 = f[0][1], f[-1][1]
        return [pid for pid in live if pid in a0 and a0[pid] != a1[pid]]
    moving = {sid: moved(sid) for sid in order}
    anim = [sid for sid in order if moving[sid]]
    last_frame = frames[anim[-1]][-1][1]
    final = {pid: last_frame[pid] for pid in live}

    home = {}
    for sid in anim:
        for pid in moving[sid]:
            home.setdefault(pid, sid)

    # assembly steps: parts installed earlier move again, rigidly together
    assembly = {}
    for sid in anim:
        again = [pid for pid in moving[sid] if home[pid] != sid]
        if not again: continue
        f0, f1 = frames[sid][0][1], frames[sid][-1][1]
        groups = []
        for pid in again:
            M0, M1 = pose_matrix(f0[pid]), pose_matrix(f1[pid])
            for grp in groups:
                q = grp[0]
                if same_rel(rel(M0, pose_matrix(f0[q])), rel(M1, pose_matrix(f1[q]))):
                    grp.append(pid); break
            else:
                groups.append([pid])
        assembly[sid] = groups

    parts_db = {pid: dict(uuid=pid, name=gparts[pid]["name"], type=types[gparts[pid]["type"]]["id"]) for pid in live}
    mates = compute_mates(db, by_tid, parts_db, live, final)

    for sid, groups in assembly.items():
        f0 = frames[sid][0][1]
        # the base: what the groups mate with that is not one of them (the first such part, by mate strength)
        mine = {pid for grp in groups for pid in grp}
        base = None
        for grp in groups:
            for pid in grp:
                for m in mates.get(pid, []):
                    if m["pid"] not in mine and (base is None) and m["kind"] == "feature":
                        base = m["pid"]
        if base is None:
            base = next((m["pid"] for grp in groups for pid in grp for m in mates.get(pid, []) if m["pid"] not in mine), None)
        stage = []
        for grp in groups:
            off = np.mean([np.array(f0[pid][:3]) - np.array(final[pid][:3]) for pid in grp], axis=0)
            stage.append([round(float(x), 3) for x in off])
        assembly[sid] = dict(base=base, groups=groups, stage=stage)

    def trajectory(pid):
        """the part's installing trajectory, carried rigidly to where it ends up"""
        sid = home[pid]
        pts = []
        for _, poses in frames[sid]:
            v = poses[pid]
            if not pts or v != pts[-1]: pts.append(v)
        T = pose_matrix(final[pid]) @ np.linalg.inv(pose_matrix(pts[-1]))
        pts = [tuple(matrix_pose(T @ pose_matrix(v))) for v in pts]
        while len(pts) > 1 and np.linalg.norm(np.array(pts[0][:3]) - np.array(pts[1][:3])) > TRAY_JUMP_MM:
            pts = pts[1:]                  # far tray points are not part of the approach
        return [tuple(round(float(x), 4) for x in v) for v in pts]

    def start(pid):
        """when the part leaves its rest pose in its installing step (keyframe time, 0..1)"""
        f = frames[home[pid]]
        rest = f[0][1][pid]
        for k in range(1, len(f)):
            if f[k][1][pid] != rest:
                return round(float(f[k - 1][0]), 4)
        return 0.0

    # where each peg's tip is: the side of the peg away from the middle of its part (model frame, mm);
    # the axis in the feature data does not say (a screw's runs towards its head)
    tips, bodies = {}, {}
    def peg_tips(tid):
        if tid in tips: return tips[tid]
        t = by_tid[tid]
        if tid not in bodies:
            mesh, mm = load_mesh(t["file"]); bodies[tid] = (mesh.bounds[0] + mesh.bounds[1]) / 2 * mm; del mesh
        out = {}
        for name, cx, cy, cz, ax, ay, az in db.execute(
                "SELECT name, centerX, centerY, centerZ, axisX, axisY, axisZ FROM PartTypeFeatures "
                "WHERE partTypeId=? AND kind='peg'", (tid,)):
            d = np.array([ax, ay, az]); side = float(np.dot(np.array([cx, cy, cz]) - bodies[tid], d))
            out[name] = d * np.sign(side) if abs(side) > 0.5 else None     # too close to the middle: no telling
        tips[tid] = out
        return out

    def earlier(q, pid):
        i, j = index[home[q]], index[home[pid]]
        return i < j or (i == j and start(q) < start(pid))

    def from_tip_side(pid, path):
        if len(path) < 2: return path
        end = np.array(path[-1][:3]); off = np.array(path[0][:3]) - end
        if np.linalg.norm(off) < 1e-6: return path
        votes = []
        for m in mates.get(pid, []):
            q = m["pid"]
            if m["kind"] != "feature" or q not in home or not earlier(q, pid): continue
            for mine, other in m["features"]:
                tip = peg_tips(parts_db[q]["type"]).get(other) if mine.startswith("H") else None
                if tip is None: continue
                tw = pose_matrix(final[q])[:3, :3] @ tip
                votes.append((float(np.dot(off, tw)) / np.linalg.norm(off), tw))
        if not votes or any(v > -0.5 for v, _ in votes): return path     # tip side (or across): as recorded
        tw = votes[0][1]
        out = []
        for v in path[:-1]:
            o = np.array(v[:3]) - end; o = o - 2 * np.dot(o, tw) * tw
            out.append(tuple(round(float(x), 4) for x in (end + o)) + tuple(v[3:]))
        print(f"  approach of {gparts[pid]['name']} mirrored to the tip side of the peg it slides onto")
        return out + [path[-1]]

    # answer steps: graph order; prerequisites = graph requirements, transitively, among answer steps
    index = {sid: i for i, sid in enumerate(anim)}
    req = g.get("requirements", {})
    def ancestors(sid, seen=None):
        seen = set() if seen is None else seen
        for r in req.get(sid, []):
            if r not in seen:
                seen.add(r); ancestors(r, seen)
        return seen
    out_steps = []
    for sid in anim:
        st = {"i": index[sid], "id": sid, "name": names[sid],
              "requires": sorted(index[x] for x in ancestors(sid) if x in index)}
        if sid in assembly:
            st["assembly"] = assembly[sid]
        out_steps.append(st)

    out_parts = []
    for pid in live:
        if pid not in home:
            continue                      # recorded but never moves: nothing to do with it
        path = trajectory(pid)
        key = types[gparts[pid]["type"]]["key"]
        path = from_tip_side(pid, path)
        out_parts.append({"id": pid, "key": key, "name": gparts[pid]["name"], "step": index[home[pid]],
                          "start": start(pid), "path": [pose_dict(v) for v in path],
                          "mates": [{"id": m["pid"], "kind": m["kind"], "features": m["features"],
                                     "rel": pose_dict(m["rel"])} for m in mates.get(pid, [])]})
    out_parts.sort(key=lambda d: (d["step"], d["name"]))
    answer = {"source": pathlib.Path(a.graph).name, "graph": g.get("id"), "paths": pathlib.Path(a.paths).name,
              "steps": out_steps, "parts": out_parts}
    pathlib.Path(a.out).write_text(json.dumps(answer, ensure_ascii=False, indent=1), encoding="utf-8")

    first = frames[order[0]][0][1] if frames.get(order[0]) else frames[anim[0]][0][1]
    kit = [{"id": pid, "name": gparts[pid]["name"], "key": types[gparts[pid]["type"]]["key"],
            "pose": pose_dict(first[pid])} for pid in live if pid in home]
    if a.manifest:
        m = json.load(open(a.manifest))
        m["answer"] = answer; m["kit"] = kit; m["source"] = answer["source"]
        pathlib.Path(a.manifest).write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{len(order)} graph steps -> {len(out_steps)} with motion; {len(out_parts)} parts "
          f"({len(skipped_parts)} without a model or a pose skipped)")
    for st in out_steps:
        extra = ""
        if "assembly" in st:
            extra = f"   [assembly: base {gparts[st['assembly']['base']]['name']}, groups " + \
                    " | ".join(", ".join(gparts[p]["name"] for p in grp) for grp in st["assembly"]["groups"]) + \
                    f", stage {st['assembly']['stage']}]"
        moved_names = [p["name"] for p in out_parts if p["step"] == st["i"]]
        print(f"  {st['i'] + 1:2d}. {st['name'][:50]:50s} {', '.join(moved_names)[:60]}{extra}")
    print("skipped parts:", ", ".join(skipped_parts))


if __name__ == "__main__":
    main()
