#!/usr/bin/env python3
"""Hole / peg features as contributor data in the ARISTOS task_graphs.db.

Two tables are added next to PartTypes (see docs/FEATURE_SCHEMA.md):

  PartTypeFeatures    one row per hole or peg of a part type
  PartTypeSymmetries  rotational symmetries of a part type

All geometry is in the part model's own frame (the GLB node origin), in
millimetres -- the same convention as Step3DPaths -- so a feature never has to
know how the simulator rescales or recentres meshes.

Commands
  detect   DB MODELS_DIR            run the mesh detector on every part type that has
                                    a model; replaces rows with source='auto', keeps
                                    rows a contributor entered (source='contributor')
  manifest DB MODELS_DIR --out F    build the simulator's assets/parts/manifest.json
                                    (and copy the GLBs next to it) from the database
  show     DB [NAME]                print the features of matching part types
"""
import argparse, gc, json, pathlib, shutil, sqlite3, sys, uuid as uuidlib
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


def key_for(name):
    for frag, key, label in NAME_KEYS:
        if frag in name:
            return key, label
    return None, None


def model_file(models_dir, model_uuid):
    """The GLB for a model uuid, whether the db wrote it with or without hyphens."""
    bare = model_uuid.replace("-", "").lower()
    for f in pathlib.Path(models_dir).glob("*.glb"):
        if f.stem.replace("-", "").lower() == bare:
            return f
    return None


def part_types(db, models_dir):
    rows = db.execute("SELECT id, uuid, name, model FROM PartTypes ORDER BY id").fetchall()
    out = []
    for pid, puuid, name, model in rows:
        f = model_file(models_dir, model) if model else None
        key, label = key_for(name)
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
    pathlib.Path(a.out).write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {a.out}: {len(parts)} part types" + (f", kit of {len(manifest['kit'])} parts" if a.kit else ""))


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
    s = sub.add_parser("show");     s.add_argument("db"); s.add_argument("name", nargs="?")
    a = ap.parse_args()
    {"detect": cmd_detect, "manifest": cmd_manifest, "show": cmd_show}[a.cmd](a)
