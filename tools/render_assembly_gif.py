#!/usr/bin/env python3
"""Render the reference assembly as a standalone GIF.

Replays ``assets/parts/answer_poses.json`` — the same reference build the bench
scores against — part by part along its real approach path, offscreen through
pyrender/EGL. Part colours follow the SDG palette used by the sibling animation
project (purple anodised aluminium, graphite carbon, steel fasteners) so the
families stay apart at GIF resolution; the part in flight is amber until it lands.

Usage::

    python tools/render_assembly_gif.py --out renders/assembly.gif
"""

import argparse
import json
import os

os.environ.setdefault("PYOPENGL_PLATFORM", "egl")

import numpy as np  # noqa: E402
import pyrender  # noqa: E402
import trimesh  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402
from scipy.spatial.transform import Rotation, Slerp  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PARTS = os.path.join(ROOT, "assets", "parts")

PURPLE = (0.40, 0.16, 0.62)
GRAPHITE = (0.11, 0.12, 0.14)
STEEL = (0.66, 0.69, 0.74)
ACCENT = (0.98, 0.64, 0.13)  # the part currently travelling
BG = (242, 243, 245)

PART_COLORS = {
    "aluminum_x_lock": PURPLE,
    "aluminum_arm_wedge_5mm": PURPLE,
    "knurled_standoff": PURPLE,
    "split_rear_plate": GRAPHITE,
    "split_front_plate": GRAPHITE,
    "arm_5in": GRAPHITE,
}

# Timing, in seconds. Tighter than the in-app ghost playback (answer.js) — a GIF
# has to pay for every frame it holds.
TRAVEL, GAP, STEP_GAP, LEAD, TAIL = 0.30, 0.04, 0.10, 0.35, 1.30

AZ0, AZ_SWEEP, EL0 = 26.0, 78.0, 26.0  # camera orbit through the build


def orbit_dir(az, el):
    return np.array([np.sin(az) * np.cos(el), np.sin(el), np.cos(az) * np.cos(el)])


def bake_parts():
    """key -> Trimesh in editor units, matching parts.js `bake()`."""
    manifest = json.load(open(os.path.join(PARTS, "manifest.json")))
    us = manifest["unitScale"]
    out = {}
    for spec in manifest["parts"]:
        loaded = trimesh.load(os.path.join(PARTS, spec["file"]), process=False)
        if isinstance(loaded, trimesh.Scene):
            pieces = []
            for node in loaded.graph.nodes_geometry:
                transform, geom_name = loaded.graph[node]
                piece = loaded.geometry[geom_name].copy()
                piece.apply_transform(transform)
                pieces.append(piece)
            mesh = trimesh.util.concatenate(pieces)
        else:
            mesh = loaded.copy()
        mesh.vertices = (mesh.vertices - np.array(spec["offset"], float)) * us
        out[spec["key"]] = mesh
    return out


def material(color, accent=False):
    rgb = ACCENT if accent else color
    return pyrender.MetallicRoughnessMaterial(
        baseColorFactor=(*rgb, 1.0),
        metallicFactor=0.25 if not accent else 0.1,
        roughnessFactor=0.55,
        smooth=False,
    )


def pose_matrix(p, e):
    m = np.eye(4)
    m[:3, :3] = Rotation.from_euler("XYZ", e).as_matrix()  # three.js Euler order 'XYZ'
    m[:3, 3] = p
    return m


def look_at(eye, target, up=(0.0, 1.0, 0.0)):
    eye, target = np.asarray(eye, float), np.asarray(target, float)
    forward = eye - target
    forward /= np.linalg.norm(forward)
    right = np.cross(np.asarray(up, float), forward)
    right /= np.linalg.norm(right)
    true_up = np.cross(forward, right)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = right, true_up, forward, eye
    return m


def ease(u):
    """Ease in/out — a part accelerates off the shelf and settles into its hole."""
    return 3 * u * u - 2 * u * u * u


def build_timeline(items):
    """Start time per part: sequential, with a beat between assembly steps."""
    t, last_step = LEAD, None
    for it in items:
        if last_step is not None and it["step"] != last_step:
            t += STEP_GAP
        last_step = it["step"]
        it["t0"] = t
        t += TRAVEL + GAP
    return t + TAIL


def font(size, bold=False):
    name = "Roboto-Medium.ttf" if bold else "Roboto-Regular.ttf"
    path = "/usr/share/fonts/truetype/roboto/unhinted/RobotoTTF/" + name
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def caption(img, items, steps, now, total, width, height):
    draw = ImageDraw.Draw(img)
    done = [it for it in items if now >= it["t0"]]
    step_i = done[-1]["step"] if done else 0
    label = steps[step_i]["label"]
    installed = sum(1 for it in items if now >= it["t0"] + TRAVEL)

    draw.text((18, 14), "Frame Bottom — reference assembly", (44, 48, 56), font=font(15, True))
    body = font(13)
    counter = f"{installed}/{len(items)} parts"
    draw.text((width - 18, height - 44), counter, (130, 136, 146), font=body, anchor="ra")
    room = width - 36 - draw.textlength(counter, font=body) - 16
    text = f"Step {step_i + 1}/{len(steps)}  ·  {label}"
    while draw.textlength(text, font=body) > room and len(label) > 8:
        label = label[:-2]
        text = f"Step {step_i + 1}/{len(steps)}  ·  {label.rstrip()}…"
    draw.text((18, height - 44), text, (58, 63, 72), font=body)
    y = height - 16
    draw.line([(18, y), (width - 18, y)], (214, 217, 222), 3)
    frac = min(1.0, max(0.0, (now - LEAD) / max(total - LEAD - TAIL, 1e-6)))
    if frac > 0:
        draw.line([(18, y), (18 + frac * (width - 36), y)], (98, 63, 190), 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "renders", "assembly.gif"))
    ap.add_argument("--width", type=int, default=560)
    ap.add_argument("--height", type=int, default=400)
    ap.add_argument("--fps", type=int, default=20)
    ap.add_argument("--ss", type=int, default=2, help="supersampling factor")
    ap.add_argument("--frames", type=int, default=0, help="debug: stop after N frames")
    ap.add_argument("--no-labels", action="store_true")
    args = ap.parse_args()

    meshes = bake_parts()
    data = json.load(open(os.path.join(PARTS, "answer_poses.json")))
    items = []
    for d in data["parts"]:
        start, end = d["path"][0], d["path"][-1]
        rots = Rotation.from_euler("XYZ", [start["e"], end["e"]])
        items.append(
            {
                "key": d["key"],
                "name": d["name"],
                "step": d["step"],
                "p0": np.array(start["p"], float),
                "p1": np.array(end["p"], float),
                "slerp": Slerp([0.0, 1.0], rots),
                "mesh": meshes[d["key"]],
                "color": PART_COLORS.get(d["key"], STEEL),
            }
        )
    total = build_timeline(items)

    # Frame the camera on the finished build, so nothing drifts as parts land.
    final = np.vstack(
        [
            trimesh.transform_points(
                it["mesh"].vertices,
                pose_matrix(it["p1"], it["slerp"]([1.0]).as_euler("XYZ")[0]),
            )
            for it in items
        ]
    )
    lo, hi = final.min(axis=0), final.max(axis=0)
    center = (lo + hi) / 2.0
    corners = np.array([[x, y, z] for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])

    scene = pyrender.Scene(bg_color=[0, 0, 0, 0], ambient_light=[0.34, 0.34, 0.37])
    for it in items:
        base = pyrender.Mesh.from_trimesh(it["mesh"], material=material(it["color"]), smooth=False)
        hot = pyrender.Mesh.from_trimesh(it["mesh"], material=material(it["color"], True), smooth=False)
        base.is_visible = hot.is_visible = False
        it["node"] = scene.add(base)
        it["hot_node"] = scene.add(hot)
        it["base_mesh"], it["hot_mesh"] = base, hot

    yfov = 0.62
    aspect = args.width / args.height
    tan_y = np.tan(yfov / 2.0)
    tan_x = tan_y * aspect
    # One distance for the whole clip — the frame is fitted at the tightest
    # azimuth of the orbit, so the build never grows or drifts out of shot.
    dist = 0.0
    for a in np.linspace(AZ0, AZ0 + AZ_SWEEP, 24):
        eye_dir = orbit_dir(np.radians(a), np.radians(EL0))
        right = np.cross([0.0, 1.0, 0.0], eye_dir)
        right /= np.linalg.norm(right)
        up = np.cross(eye_dir, right)
        rel = corners - center
        need = np.maximum(np.abs(rel @ right) / tan_x, np.abs(rel @ up) / tan_y) + rel @ eye_dir
        dist = max(dist, float(need.max()))
    dist *= 1.06
    cam = pyrender.PerspectiveCamera(yfov=yfov, aspectRatio=aspect)
    cam_node = scene.add(cam, pose=np.eye(4))
    key = scene.add(pyrender.DirectionalLight(intensity=3.6), pose=np.eye(4))
    fill = scene.add(pyrender.DirectionalLight(intensity=1.5), pose=np.eye(4))
    rim = scene.add(pyrender.DirectionalLight(intensity=1.1), pose=np.eye(4))

    w, h = args.width * args.ss, args.height * args.ss
    renderer = pyrender.OffscreenRenderer(w, h)
    n_frames = int(round(total * args.fps))
    if args.frames:
        n_frames = min(n_frames, args.frames)
    frames = []

    for f in range(n_frames):
        now = f / args.fps
        for it in items:
            u = (now - it["t0"]) / TRAVEL
            visible = u >= 0.0
            travelling = 0.0 <= u < 1.0
            it["base_mesh"].is_visible = visible and not travelling
            it["hot_mesh"].is_visible = travelling
            if not visible:
                continue
            k = ease(min(max(u, 0.0), 1.0))
            pose = np.eye(4)
            pose[:3, :3] = it["slerp"]([k]).as_matrix()[0]
            pose[:3, 3] = it["p0"] + (it["p1"] - it["p0"]) * k
            scene.set_pose(it["node"], pose)
            scene.set_pose(it["hot_node"], pose)

        # A slow orbit through the build, plus a last quarter turn while it holds.
        prog = min(now / max(total, 1e-6), 1.0)
        eye = center + dist * orbit_dir(np.radians(AZ0 + AZ_SWEEP * prog), np.radians(EL0))
        cam_pose = look_at(eye, center)
        scene.set_pose(cam_node, cam_pose)
        offset = eye - center
        swung = Rotation.from_euler("y", np.radians(35)).as_matrix() @ offset
        scene.set_pose(key, look_at(center + swung + np.array([0.0, dist * 0.5, 0.0]), center))
        scene.set_pose(fill, look_at(center - offset * 0.8 + np.array([0.0, dist * 0.2, 0.0]), center))
        scene.set_pose(rim, look_at(center - offset - np.array([0.0, dist * 0.3, 0.0]), center))

        color, _ = renderer.render(scene, flags=pyrender.RenderFlags.RGBA)
        img = Image.fromarray(color, "RGBA").resize((args.width, args.height), Image.LANCZOS)
        flat = Image.new("RGB", img.size, BG)
        flat.paste(img, (0, 0), img)
        if not args.no_labels:
            caption(flat, items, data["steps"], now, total, args.width, args.height)
        frames.append(flat)
        if f % 20 == 0:
            print(f"frame {f + 1}/{n_frames}", flush=True)

    renderer.delete()

    # One shared palette, taken from frames spread across the build, so colours
    # don't shift between frames and the GIF stays compressible.
    probe = Image.new("RGB", (args.width, args.height * 6), BG)
    for i in range(6):
        probe.paste(frames[min(len(frames) - 1, int(len(frames) * (i + 1) / 7))], (0, args.height * i))
    palette = probe.quantize(colors=255, method=Image.MEDIANCUT)
    quant = [fr.quantize(palette=palette, dither=Image.Dither.NONE) for fr in frames]

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    quant[0].save(
        args.out,
        save_all=True,
        append_images=quant[1:],
        duration=int(round(1000 / args.fps)),
        loop=0,
        optimize=True,
        disposal=1,
    )
    size = os.path.getsize(args.out) / 1e6
    print(f"{args.out}  {len(quant)} frames  {args.width}x{args.height}  {size:.1f} MB")


if __name__ == "__main__":
    main()
