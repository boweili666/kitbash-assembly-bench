#!/usr/bin/env python3
"""Hole / peg features as contributor data in the ARISTOS task_graphs.db.

Contributors deliver a `part_features.json` (format below, JSON Schema in
docs/part_features.schema.json). It is imported into two tables next to
PartTypes and the simulator manifest is generated from the database:

  part_features.json  --import-->  PartTypeFeatures / PartTypeSymmetries  --manifest-->  assets/parts/manifest.json

All geometry is in the part model's own frame (the GLB node origin), Y up,
in millimetres -- the same convention as Step3DPaths.

Contributor file (one object per part type, or a list of them):
  {
    "partType": "<PartTypes.uuid>",          // or "model": "<model uuid>"
    "name": "Knurled Standoff",              // informational
    "features": [
      {"name": "H1", "kind": "hole", "center": [0, 0, 0],  "axis": [0, 1, 0], "diameter": 3.0, "depth": 20.0},
      {"name": "P1", "kind": "peg",  "center": [0, 10, 0], "axis": [0, 1, 0], "diameter": 5.5, "depth": 20.0}
    ],
    "symmetries": [ {"axis": [0, 1, 0], "center": [0, 10, 0], "degrees": 72} ]
  }

Commands
  import   DB FILE                 load a contributor file (replaces that part type's rows)
  export   DB --out FILE           write the database content in the contributor file format
  manifest DB MODELS_DIR --out F   build the simulator manifest (+ copy GLBs) from the database
  show     DB [NAME]               print the features of matching part types
  answer   DB MODELS_DIR --out F   reference assembly (steps in order, per-part approach ->
                                   installed paths, prerequisites) for Answer / Checks
  detect   DB MODELS_DIR           (internal) mesh detector, only to draft a first file for a
                                   contributor to correct; not part of the data workflow
"""
import argparse, gc, json, pathlib, re, shutil, sqlite3, sys, uuid as uuidlib
import numpy as np
import trimesh

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from label_holes import detect_cylinders, refine_extents, detect_symmetries  # noqa: E402

MIN_FEATURE_DIA_MM = 1.5      # thinner cylinders are windings / wires, not fasteners
DEFAULT_UNIT_SCALE = 24.767745  # simulator units per metre; pinned so existing scene data stays valid

SCHEMA = """
CREATE TABLE IF NOT EXISTS PartTypeFeatures (
	id INTEGER PRIMARY KEY,
	uuid CHAR(36),
	partTypeId INT,
	name CHAR(64),
	kind CHAR(8),
	centerX FLOAT, centerY FLOAT, centerZ FLOAT,
	axisX FLOAT, axisY FLOAT, axisZ FLOAT,
	diameter FLOAT,
	depth FLOAT,
	source CHAR(16)
);
CREATE TABLE IF NOT EXISTS PartTypeSymmetries (
	id INTEGER PRIMARY KEY,
	partTypeId INT,
	axisX FLOAT, axisY FLOAT, axisZ FLOAT,
	centerX FLOAT, centerY FLOAT, centerZ FLOAT,
	degrees FLOAT,
	source CHAR(16)
);
"""

# Simulator part key + short label, chosen by a fragment of the PartTypes name.
NAME_KEYS = [
    ("Arm Wedge",                 "aluminum_arm_wedge_5mm", "Arm Wedge"),
    ("Camera Plate (Left)",       "camera_plate_left",      "Camera Plate L"),
    ("Camera Plate (Right)",      "camera_plate_right",     "Camera Plate R"),
    ("M3x16mm Socket Cap",        "screw_m3x16_socket_cap", "M3×16 Cap"),
    ("Aluminum X-Lock",           "aluminum_x_lock",        "X-Lock"),
    ("Split Rear Plate",          "split_rear_plate",       "Rear Plate"),
    ("M3x22mm Pan",               "screw_m3x22_pan",        "M3×22"),
    ("5 inch Arm",                "arm_5in",                "Arm"),
    ("Split Front Plate",         "split_front_plate",      "Front Plate"),
    ("SE Top Plate",              "top_plate",              "Top Plate"),
    ("M3x6mm Pan",                "screw_m3x6_pan",         "M3×6"),
    ("M3x16mm Pan",               "screw_m3x16_pan",        "M3×16"),
    ("Knurled Standoff",          "knurled_standoff",       "Standoff"),
    ("2207 Motor -",              "motor_2207",             "Motor 2207"),
    ("M5 Nylon Flanged",          "motor_nut_m5",           "M5 Nut"),
    ("M3x8mm Socket Cap",         "screw_m3x8_socket_cap",  "M3×8 Cap"),
    ("Vibration Dampeners",       "damper_m2",              "M2 Damper"),
    ("4-in-1 ESC",                "esc_4in1",               "ESC 4-in-1"),
    ("Propeller -- Clockwise",    "propeller_cw",           "Propeller CW"),
    ("Propeller -- Counterclockwise", "propeller_ccw",      "Propeller CCW"),
]


def slug(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:40]


def known_key(name):
    """Simulator key + short label for the part types the checker / answer
    code already refer to by name. Anything else gets a key derived from its
    name (see part_types), so a newly uploaded part type needs no code change."""
    for frag, key, label in NAME_KEYS:
        if frag in name:
            return key, label
    return None, None


def common_prefixes(names, min_words=3, min_count=3):
    """Word prefixes shared by several part-type names -- brand / product
    strings such as 'Lumenier QAV-S 2 Joshua Bardwell' -- longest first."""
    counts = {}
    for nm in names:
        words = nm.split()
        for k in range(min_words, len(words)):
            pre = " ".join(words[:k])
            counts[pre] = counts.get(pre, 0) + 1
    return sorted((pre for pre, c in counts.items() if c >= min_count), key=len, reverse=True)


def model_file(models_dir, model_uuid):
    """The GLB for a model uuid, whether the db wrote it with or without hyphens."""
    bare = model_uuid.replace("-", "").lower()
    for f in pathlib.Path(models_dir).glob("*.glb"):
        if f.stem.replace("-", "").lower() == bare:
            return f
    return None


def part_types(db, models_dir):
    rows = db.execute("SELECT id, uuid, name, model FROM PartTypes ORDER BY id").fetchall()
    prefixes = common_prefixes([r[2] for r in rows])
    out, used = [], set()
    for pid, puuid, name, model in rows:
        f = model_file(models_dir, model) if model else None
        key, label = known_key(name)
        if not key:
            label = name
            for pre in prefixes:
                if label.startswith(pre + " "):
                    label = label[len(pre) + 1:]
                    break
            key = slug(label) or f"part_{puuid[:8]}"
            if key in used:
                key = f"{key}_{puuid[:4]}"
        used.add(key)
        out.append(dict(id=pid, uuid=puuid, name=name, model=model, file=f, key=key, label=label))
    return out


def load_mesh(path):
    mesh = trimesh.load(path, force="mesh")
    mm = 1.0 if float(mesh.extents.max()) > 1 else 1000.0   # file already in mm, or in metres
    return mesh, mm


# ---------------------------------------------------------------- detect
def cmd_detect(a):
    db = sqlite3.connect(a.db)
    db.executescript(SCHEMA)
    types = [t for t in part_types(db, a.models) if t["file"]]
    if a.only:
        types = [t for t in types if t["key"] in a.only.split(",")]
    # largest meshes last, so an out-of-memory kill loses the least
    types.sort(key=lambda t: t["file"].stat().st_size)
    for t in types:
        mesh, mm = load_mesh(t["file"])
        cyls = detect_cylinders(mesh)
        refine_extents(mesh, cyls)
        cyls = [c for c in cyls if c["r"] * 2 * mm >= MIN_FEATURE_DIA_MM]
        syms, center = detect_symmetries(mesh)
        holes = sorted([c for c in cyls if c["kind"] == "hole"], key=lambda c: c["r"])
        pegs = sorted([c for c in cyls if c["kind"] == "peg"], key=lambda c: -c["depth"])

        db.execute("DELETE FROM PartTypeFeatures WHERE partTypeId=? AND source='auto'", (t["id"],))
        db.execute("DELETE FROM PartTypeSymmetries WHERE partTypeId=? AND source='auto'", (t["id"],))
        for prefix, feats in (("H", holes), ("P", pegs)):
            for i, c in enumerate(feats):
                cx, cy, cz = (np.asarray(c["c"]) * mm).tolist()
                dx, dy, dz = np.asarray(c["d"], dtype=float).tolist()
                db.execute(
                    "INSERT INTO PartTypeFeatures VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (str(uuidlib.uuid4()), t["id"], f"{prefix}{i+1}", c["kind"],
                     round(cx, 4), round(cy, 4), round(cz, 4), round(dx, 6), round(dy, 6), round(dz, 6),
                     round(c["r"] * 2 * mm, 3), round(c["depth"] * mm, 3), "auto"))
        for s in syms:
            ax = s["axis"]; cc = (np.asarray(center) * mm).tolist()
            db.execute("INSERT INTO PartTypeSymmetries VALUES (NULL,?,?,?,?,?,?,?,?,?)",
                       (t["id"], ax[0], ax[1], ax[2], round(cc[0], 4), round(cc[1], 4), round(cc[2], 4), s["deg"], "auto"))
        db.commit()
        print(f"{t['name'][:58]:58s} holes {len(holes):2d}  pegs {len(pegs):2d}  sym {len(syms)}  "
              f"[{', '.join('⌀%.1f' % (h['r']*2*mm) for h in holes[:6])}]")
        del mesh; gc.collect()


# ---------------------------------------------------------------- manifest
def cmd_manifest(a):
    db = sqlite3.connect(a.db)
    S = a.unit_scale
    out_dir = pathlib.Path(a.out).parent
    out_dir.mkdir(parents=True, exist_ok=True)
    parts = []
    for t in part_types(db, a.models):
        if not (t["file"] and t["key"]):
            continue
        mesh, mm = load_mesh(t["file"])
        bmin, bmax = mesh.bounds
        off = np.array([(bmin[0] + bmax[0]) / 2, bmin[1], (bmin[2] + bmax[2]) / 2])

        def X(p_mm):   # model frame (mm) -> simulator local units
            return [round(float(v), 4) for v in (np.asarray(p_mm) / mm - off) * S]

        feats = db.execute("SELECT name, kind, centerX, centerY, centerZ, axisX, axisY, axisZ, diameter, depth "
                           "FROM PartTypeFeatures WHERE partTypeId=? ORDER BY kind DESC, id", (t["id"],)).fetchall()
        syms = db.execute("SELECT axisX, axisY, axisZ, centerX, centerY, centerZ, degrees "
                          "FROM PartTypeSymmetries WHERE partTypeId=?", (t["id"],)).fetchall()
        def fx(rows, kind):
            return [{"id": n, "c": X([cx, cy, cz]), "d": [round(dx, 4), round(dy, 4), round(dz, 4)],
                     "r": round(dia / 2 / mm * S, 4), "depth": round(dep / mm * S, 4)}
                    for n, k, cx, cy, cz, dx, dy, dz, dia, dep in rows if k == kind]
        sym_center = X([syms[0][3], syms[0][4], syms[0][5]]) if syms else X((np.asarray(mesh.centroid) * mm).tolist())
        if a.copy_glb:
            shutil.copy(t["file"], out_dir / f"{t['key']}.glb")
        parts.append({
            "key": t["key"], "file": f"{t['key']}.glb", "label": t["label"],
            "models": [t["model"]], "partTypeUuid": t["uuid"], "name": t["name"],
            "offset": [round(float(v), 5) for v in off],
            "bbox": {"min": X((bmin * mm).tolist()), "max": X((bmax * mm).tolist())},
            "sym": [{"axis": [ax, ay, az], "deg": deg} for ax, ay, az, _, _, _, deg in syms],
            "sym_center": sym_center,
            "holes": fx(feats, "hole"), "pegs": fx(feats, "peg"),
        })
        print(f"  {t['key']:24s} holes {len(parts[-1]['holes']):2d} pegs {len(parts[-1]['pegs']):2d}")
        del mesh; gc.collect()

    manifest = {"unitScale": S, "source": pathlib.Path(a.db).name, "parts": parts}
    if a.kit:
        manifest["kit"] = json.load(open(a.kit))
    if a.answer:
        manifest["answer"] = json.load(open(a.answer))
    pathlib.Path(a.out).write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {a.out}: {len(parts)} part types" + (f", kit of {len(manifest['kit'])} parts" if a.kit else ""))


# ---------------------------------------------------------------- answer
TRAY_JUMP_MM = 100.0   # a first waypoint this far from the next one is the staging tray, not an approach


MATE_ANGLE_DEG = 5.0        # feature axes parallel within this
MATE_AXIS_MM = 1.5          # axis-to-axis distance
MATE_PEG_OVER_MM = 0.6      # a peg may be drawn this much wider than its hole (motor mounts: 3.0 in 2.5)
MATE_PEG_UNDER_MM = 1.5     # or this much narrower
MATE_HOLE_HOLE_MM = 1.0     # hole-on-hole diameter difference
CONTACT_MM = 2.0            # bounding boxes closer than this touch


def pose_matrix(v):
    """(x,y,z,roll,pitch,yaw) mm -> 4x4, R = Rx*Ry*Rz (three.js XYZ)."""
    x, y, z, r, p, w = v
    cr, sr, cp, sp, cw, sw = np.cos(r), np.sin(r), np.cos(p), np.sin(p), np.cos(w), np.sin(w)
    Rx = np.array([[1, 0, 0], [0, cr, -sr], [0, sr, cr]])
    Ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]])
    Rz = np.array([[cw, -sw, 0], [sw, cw, 0], [0, 0, 1]])
    M = np.eye(4); M[:3, :3] = Rx @ Ry @ Rz; M[:3, 3] = [x, y, z]
    return M


def matrix_pose(M):
    """4x4 -> (x,y,z,roll,pitch,yaw) with R = Rx*Ry*Rz."""
    R = M[:3, :3]
    p = np.arcsin(np.clip(R[0, 2], -1, 1))
    if abs(R[0, 2]) < 0.9999999:
        r = np.arctan2(-R[1, 2], R[2, 2]); w = np.arctan2(-R[0, 1], R[0, 0])
    else:
        r = np.arctan2(R[2, 1], R[1, 1]); w = 0.0
    return (round(float(M[0, 3]), 3), round(float(M[1, 3]), 3), round(float(M[2, 3]), 3),
            round(float(r), 4), round(float(p), 4), round(float(w), 4))


def compute_mates(db, types, parts, part_ids, final):
    """For every part at its final pose: which other parts it is assembled to.

    kind 'feature' = a hole/peg of this part is coaxial with a compatible feature
    of the other part (axes parallel, on the same line, diameters compatible,
    axial extents overlapping) -- screws in holes, nuts on shafts, plate on plate.
    kind 'contact' = no such feature pair, but the bounding boxes touch -- arms
    in the X-Lock slots, motors on arm tips, whose mating faces are not cylinders.
    'rel' = this part's pose in the mate's frame (inv(P_mate) * P_part), the
    quantity the simulator compares at runtime; independent of where on the
    table the pair sits."""
    feats, bboxes = {}, {}
    for tid, t in types.items():
        feats[tid] = db.execute("SELECT name, kind, centerX, centerY, centerZ, axisX, axisY, axisZ, diameter, depth "
                                "FROM PartTypeFeatures WHERE partTypeId=?", (tid,)).fetchall()
        mesh, mm = load_mesh(t["file"])
        bboxes[tid] = np.asarray(mesh.bounds) * mm
    live = [pid for pid in part_ids if parts[pid]["type"] in types]
    world = {}
    for pid in live:
        M = pose_matrix(final[pid]); R, tt = M[:3, :3], M[:3, 3]
        fw = []
        for n, k, cx, cy, cz, ax, ay, az, dia, dep in feats[parts[pid]["type"]]:
            c = R @ np.array([cx, cy, cz]) + tt; d = R @ np.array([ax, ay, az]); d /= np.linalg.norm(d)
            fw.append(dict(name=n, kind=k, c=c, d=d, dia=dia, depth=dep or 0.0))
        b = bboxes[parts[pid]["type"]]
        corners = np.array([[x, y, z] for x in (b[0][0], b[1][0]) for y in (b[0][1], b[1][1]) for z in (b[0][2], b[1][2])])
        wc = (R @ corners.T).T + tt
        world[pid] = dict(M=M, feats=fw, aabb=(wc.min(0), wc.max(0)))
    cos_min = np.cos(np.radians(MATE_ANGLE_DEG))

    def feature_pairs(a, b):
        out = []
        for fa in a["feats"]:
            for fb in b["feats"]:
                kinds = (fa["kind"], fb["kind"])
                if kinds == ("peg", "peg"):
                    continue
                if abs(float(fa["d"] @ fb["d"])) < cos_min:
                    continue
                v = fa["c"] - fb["c"]
                if np.linalg.norm(v - (v @ fb["d"]) * fb["d"]) > MATE_AXIS_MM:
                    continue
                if kinds == ("hole", "hole"):
                    if abs(fa["dia"] - fb["dia"]) > MATE_HOLE_HOLE_MM:
                        continue
                else:
                    peg, hole = (fa, fb) if fa["kind"] == "peg" else (fb, fa)
                    if not (hole["dia"] - MATE_PEG_UNDER_MM <= peg["dia"] <= hole["dia"] + MATE_PEG_OVER_MM):
                        continue
                ta, tb = float(fa["c"] @ fb["d"]), float(fb["c"] @ fb["d"])
                if (ta - fa["depth"] / 2) > (tb + fb["depth"] / 2) or (tb - fb["depth"] / 2) > (ta + fa["depth"] / 2):
                    continue            # stacked along one axis without overlapping
                out.append([fa["name"], fb["name"]])
        return out

    def touching(a, b):
        return bool(np.all(a["aabb"][0] - CONTACT_MM <= b["aabb"][1]) and np.all(b["aabb"][0] - CONTACT_MM <= a["aabb"][1]))

    mates = {}
    for pa in live:
        lst = []
        for pb in live:
            if pb == pa:
                continue
            pairs = feature_pairs(world[pa], world[pb])
            if pairs:
                kind = "feature"
            elif touching(world[pa], world[pb]):
                kind = "contact"
            else:
                continue
            rel = matrix_pose(np.linalg.inv(world[pb]["M"]) @ world[pa]["M"])
            lst.append(dict(pid=pb, kind=kind, features=pairs, rel=rel))
        lst.sort(key=lambda m: (m["kind"] != "feature", -len(m["features"])))
        mates[pa] = lst
    return mates


def cmd_answer(a):
    """The reference assembly for the simulator's Answer animation and Checks,
    straight from Step3DPaths / StepRequirements / StepParts.

    Steps = the graph steps in which some part moves. Their order is the
    animation's own chronology: sort by how many parts are already installed
    when the step starts, honouring StepRequirements. Each moving part keeps
    its in-step approach -> installed waypoints (the far staging-tray point
    is dropped). Parts that never move (motor screws, grommets) appear at the
    step that mentions them, or right after the step they depend on."""
    db = sqlite3.connect(a.db)
    types = {t["id"]: t for t in part_types(db, a.models) if t["file"]}
    parts = {pid: dict(uuid=u, name=nm, type=ty) for pid, u, nm, ty in db.execute("SELECT id, uuid, name, type FROM Parts")}
    steps = {sid: dict(uuid=u, name=nm) for sid, u, nm in db.execute("SELECT id, uuid, name FROM Steps")}

    paths = {}
    for sid, pid, t, x, y, z, r, p_, yw in db.execute(
            "SELECT stepId, partId, stepTime, x, y, z, roll, pitch, yaw FROM Step3DPaths ORDER BY stepId, partId, stepTime"):
        paths.setdefault((sid, pid), []).append((t, (round(x, 3), round(y, 3), round(z, 3), round(r, 4), round(p_, 4), round(yw, 4))))
    path_steps = sorted({sid for sid, _ in paths})
    part_ids = sorted({pid for _, pid in paths} & set(parts))

    def moved(seq):
        return seq[0][1] != seq[-1][1]

    moving = {sid: [pid for pid in part_ids if (sid, pid) in paths and moved(paths[(sid, pid)])] for sid in path_steps}
    moving = {sid: v for sid, v in moving.items() if v}
    if any(sum(pid in v for v in moving.values()) > 1 for pid in part_ids):
        print("warning: a part moves in more than one step; taking the last", file=sys.stderr)

    # final pose: where a part ends its moving step; a static part's constant pose
    final = {}
    for pid in part_ids:
        home = [sid for sid, v in moving.items() if pid in v]
        sid = home[-1] if home else next(s for s in path_steps if (s, pid) in paths)
        final[pid] = paths[(sid, pid)][-1][1]
    installed_at_start = {sid: sum(1 for pid in part_ids if (sid, pid) in paths and paths[(sid, pid)][0][1] == final[pid])
                          for sid in moving}

    # prerequisites among moving steps (transitive closure of StepRequirements)
    req = {}
    for sid, rid in db.execute("SELECT stepId, requirementId FROM StepRequirements"):
        req.setdefault(sid, set()).add(rid)
    def ancestors(sid, seen=None):
        seen = set() if seen is None else seen
        for r in req.get(sid, ()):
            if r not in seen:
                seen.add(r); ancestors(r, seen)
        return seen
    anc = {sid: ancestors(sid) & set(moving) for sid in moving}

    # order: Kahn over the moving steps, ready ones by installed count then id
    remaining = set(moving); order = []
    while remaining:
        ready = [sid for sid in remaining if not (anc[sid] & remaining)]
        ready.sort(key=lambda sid: (installed_at_start[sid], sid))
        order.append(ready[0]); remaining.remove(ready[0])
    index = {sid: i for i, sid in enumerate(order)}

    # static parts: the earliest answer step that lists them, else the step
    # right after the (non-animated) step that lists them
    step_parts = {}
    for sid, pid in db.execute("SELECT stepId, partId FROM StepParts"):
        step_parts.setdefault(pid, set()).add(sid)
    def static_step(pid):
        listed = step_parts.get(pid, set())
        hits = sorted(index[s] for s in listed if s in index)
        if hits:
            return hits[0]
        for s in listed:               # e.g. "Attach Motor to Arm (A) with Screw" -> after "Position Motor on Arm (A)"
            before = sorted(index[x] for x in ancestors(s) if x in index)
            if before:
                return before[-1]
        return 0

    def pose_dict(v):
        return {"x": v[0], "y": v[1], "z": v[2], "roll": v[3], "pitch": v[4], "yaw": v[5]}
    def trimmed(seq):
        pts = [v for _, v in seq]
        out = [pts[0]]
        for v in pts[1:]:
            if v != out[-1]:
                out.append(v)
        if len(out) > 1 and np.linalg.norm(np.array(out[0][:3]) - np.array(out[1][:3])) > TRAY_JUMP_MM:
            out = out[1:]
        return out

    mates = compute_mates(db, types, parts, part_ids, final)

    out_parts = []
    for pid in part_ids:
        t = types.get(parts[pid]["type"])
        if not t:
            continue
        home = [sid for sid, v in moving.items() if pid in v]
        if home:
            step_i, path = index[home[-1]], trimmed(paths[(home[-1], pid)])
        else:
            step_i, path = static_step(pid), [final[pid]]
        out_parts.append({"id": parts[pid]["uuid"], "key": t["key"], "name": parts[pid]["name"],
                          "step": step_i, "path": [pose_dict(v) for v in path],
                          "mates": [{"id": parts[m["pid"]]["uuid"], "kind": m["kind"], "features": m["features"],
                                     "rel": pose_dict(m["rel"])} for m in mates.get(pid, [])]})
    # The motor shafts face downward in this reference assembly. Nuts approach
    # from underneath (+Y motion), without changing the installed scoring pose.
    for part in out_parts:
        if part['key'] == 'motor_nut_m5' and len(part['path']) > 1:
            seated = part['path'][-1]
            start = dict(seated)
            start['y'] = round(seated['y'] - 36.0, 4)
            part['path'] = [start, seated]
    out_parts.sort(key=lambda d: (d["step"], d["name"]))      # the animation scheduler walks parts step by step
    out_steps = [{"i": i, "id": steps[sid]["uuid"], "name": steps[sid]["name"],
                  "requires": sorted(index[x] for x in anc[sid])} for i, sid in enumerate(order)]
    answer = {"source": pathlib.Path(a.db).name, "steps": out_steps, "parts": out_parts}
    pathlib.Path(a.out).write_text(json.dumps(answer, ensure_ascii=False, indent=1), encoding="utf-8")
    skipped = len(part_ids) - len(out_parts)
    print(f"answer: {len(out_steps)} steps, {len(out_parts)} parts ({skipped} without a model skipped) -> {a.out}")
    for st in out_steps:
        names = [p["name"] for p in out_parts if p["step"] == st["i"]]
        print(f"  {st['i']+1:2d}. {st['name'][:52]:52s} {', '.join(names)[:60]}")


# ---------------------------------------------------------------- import / export
def _unit(v, what):
    v = [float(x) for x in v]
    n = float(np.linalg.norm(v))
    if n < 1e-9:
        raise ValueError(f"{what}: axis is zero")
    return [x / n for x in v]


def validate_entry(e, i):
    """Structural check of one part-type entry; raises ValueError with a useful message."""
    where = f"entry {i} ({e.get('name') or e.get('partType') or e.get('model') or '?'})"
    if not (e.get("partType") or e.get("model")):
        raise ValueError(f"{where}: needs 'partType' (PartTypes.uuid) or 'model' (model uuid)")
    for j, f in enumerate(e.get("features", [])):
        w = f"{where} feature {j} ({f.get('name', '?')})"
        for k in ("name", "kind", "center", "axis", "diameter"):
            if k not in f:
                raise ValueError(f"{w}: missing '{k}'")
        if f["kind"] not in ("hole", "peg"):
            raise ValueError(f"{w}: kind must be 'hole' or 'peg'")
        if len(f["center"]) != 3 or len(f["axis"]) != 3:
            raise ValueError(f"{w}: center and axis must have 3 numbers")
        if not float(f["diameter"]) > 0:
            raise ValueError(f"{w}: diameter must be > 0 mm")
        _unit(f["axis"], w)
    for j, sy in enumerate(e.get("symmetries", [])):
        w = f"{where} symmetry {j}"
        for k in ("axis", "center", "degrees"):
            if k not in sy:
                raise ValueError(f"{w}: missing '{k}'")
        if not 0 < float(sy["degrees"]) < 360:
            raise ValueError(f"{w}: degrees must be in (0, 360)")
        _unit(sy["axis"], w)


def resolve_part_type(db, e):
    if e.get("partType"):
        row = db.execute("SELECT id, name FROM PartTypes WHERE uuid=?", (e["partType"],)).fetchone()
    else:
        bare = e["model"].replace("-", "").lower()
        row = next((r for r in db.execute("SELECT id, name, model FROM PartTypes")
                    if (r[2] or "").replace("-", "").lower() == bare), None)
    if not row:
        raise ValueError(f"no PartTypes row for {e.get('partType') or e.get('model')}")
    return row[0], row[1]


def cmd_import(a):
    db = sqlite3.connect(a.db)
    db.executescript(SCHEMA)
    data = json.load(open(a.file, encoding="utf-8"))
    entries = data if isinstance(data, list) else [data]
    for i, e in enumerate(entries):
        validate_entry(e, i)
    for e in entries:
        pid, pname = resolve_part_type(db, e)
        db.execute("DELETE FROM PartTypeFeatures WHERE partTypeId=?", (pid,))
        db.execute("DELETE FROM PartTypeSymmetries WHERE partTypeId=?", (pid,))
        for f in e.get("features", []):
            ax = _unit(f["axis"], f["name"])
            db.execute("INSERT INTO PartTypeFeatures VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (f.get("uuid") or str(uuidlib.uuid4()), pid, f["name"], f["kind"],
                        *[float(x) for x in f["center"]], *ax,
                        float(f["diameter"]), float(f.get("depth", 0.0)), "contributor"))
        for sy in e.get("symmetries", []):
            ax = _unit(sy["axis"], "symmetry")
            db.execute("INSERT INTO PartTypeSymmetries VALUES (NULL,?,?,?,?,?,?,?,?,?)",
                       (pid, *ax, *[float(x) for x in sy["center"]], float(sy["degrees"]), "contributor"))
        print(f"  {pname[:58]:58s} features {len(e.get('features', [])):2d}  symmetries {len(e.get('symmetries', []))}")
    db.commit()
    print(f"imported {len(entries)} part types from {a.file}")


def cmd_export(a):
    db = sqlite3.connect(a.db)
    out = []
    for pid, puuid, name, model in db.execute("SELECT id, uuid, name, model FROM PartTypes ORDER BY id"):
        feats = db.execute("SELECT uuid, name, kind, centerX, centerY, centerZ, axisX, axisY, axisZ, diameter, depth "
                           "FROM PartTypeFeatures WHERE partTypeId=? ORDER BY kind DESC, id", (pid,)).fetchall()
        syms = db.execute("SELECT axisX, axisY, axisZ, centerX, centerY, centerZ, degrees "
                          "FROM PartTypeSymmetries WHERE partTypeId=? ORDER BY id", (pid,)).fetchall()
        if not feats and not syms:
            continue
        out.append({
            "partType": puuid, "model": model, "name": name,
            "features": [{"uuid": u, "name": n, "kind": k, "center": [cx, cy, cz], "axis": [ax, ay, az],
                          "diameter": dia, "depth": dep} for u, n, k, cx, cy, cz, ax, ay, az, dia, dep in feats],
            "symmetries": [{"axis": [ax, ay, az], "center": [cx, cy, cz], "degrees": deg}
                           for ax, ay, az, cx, cy, cz, deg in syms],
        })
    pathlib.Path(a.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"exported {len(out)} part types -> {a.out}")


# ---------------------------------------------------------------- show
def cmd_show(a):
    db = sqlite3.connect(a.db)
    q = "SELECT id, name FROM PartTypes" + (" WHERE name LIKE ?" if a.name else "")
    for pid, name in db.execute(q, (f"%{a.name}%",) if a.name else ()):
        feats = db.execute("SELECT name, kind, diameter, depth, centerX, centerY, centerZ, source FROM PartTypeFeatures "
                           "WHERE partTypeId=? ORDER BY kind DESC, id", (pid,)).fetchall()
        if not feats: continue
        print(f"\n{name}")
        for n, k, dia, dep, cx, cy, cz, src in feats:
            print(f"  {n:4s} {k:4s} ⌀{dia:5.2f} depth {dep:6.2f}  at ({cx:7.2f}, {cy:7.2f}, {cz:7.2f}) mm  [{src}]")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("detect");   d.add_argument("db"); d.add_argument("models"); d.add_argument("--only")
    m = sub.add_parser("manifest"); m.add_argument("db"); m.add_argument("models"); m.add_argument("--out", required=True)
    m.add_argument("--unit-scale", type=float, default=DEFAULT_UNIT_SCALE); m.add_argument("--copy-glb", action="store_true")
    m.add_argument("--kit", help="kit layout json (from scene_from_db.py --layout kit) to embed as manifest.kit")
    m.add_argument("--answer", help="reference assembly json (from `answer`) to embed as manifest.answer")
    w = sub.add_parser("answer");   w.add_argument("db"); w.add_argument("models"); w.add_argument("--out", required=True)
    s = sub.add_parser("show");     s.add_argument("db"); s.add_argument("name", nargs="?")
    i = sub.add_parser("import");   i.add_argument("db"); i.add_argument("file")
    x = sub.add_parser("export");   x.add_argument("db"); x.add_argument("--out", required=True)
    a = ap.parse_args()
    {"detect": cmd_detect, "manifest": cmd_manifest, "show": cmd_show,
     "import": cmd_import, "export": cmd_export, "answer": cmd_answer}[a.cmd](a)
