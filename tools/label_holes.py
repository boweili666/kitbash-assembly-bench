#!/usr/bin/env python3
"""检测零件 GLB 中的圆柱特征并打标签,生成 assets/parts/manifest.json。

方法:对每个候选轴向,取法线近似垂直于该轴的三角面(圆柱侧壁),
按面邻接聚类,把每簇质心投影到垂直平面上做最小二乘圆拟合;
拟合残差小、弧度覆盖足够即判定为圆柱面 —— 法线朝内是孔(hole),
朝外是销/柱(peg)。孔标 H1..Hn,销标 P1..Pn。

坐标统一换算到编辑器单位:所有零件共用一个 unitScale(保持相对尺寸),
并各自平移到「XZ 包围盒中心、底面落地」。manifest 中的坐标即最终局部坐标。
"""
import json
import pathlib

import numpy as np
import trimesh

ROOT = pathlib.Path(__file__).resolve().parent.parent
PARTS = ROOT / "assets" / "parts"
TARGET_MAX = 3.0          # 最大零件(机臂)在编辑器里的目标尺寸
MIN_FACES = 12            # 圆柱面簇的最小三角面数
FIT_TOL = 0.20            # 圆拟合相对残差上限(容纳低模螺纹)
ARC_BINS, ARC_MIN = 12, 8  # 弧度覆盖:12 扇区至少占 9(≈270°)

LABELS = {
    "aluminum_x_lock": "X-Lock",
    "knurled_standoff": "Standoff",
    "split_rear_plate": "Rear Plate",
    "split_front_plate": "Front Plate",
    "arm_5in": "Arm",
    "aluminum_arm_wedge_5mm": "Arm Wedge",
    "screw_m3x6_pan": "M3×6",
    "screw_m3x16_pan": "M3×16",
    "screw_m3x16_socket_cap": "M3×16 Cap",
    "screw_m3x22_pan": "M3×22",
}


def fit_circle(xy):
    """Kasa 最小二乘圆拟合 → (center2, r, rms)"""
    A = np.c_[2 * xy, np.ones(len(xy))]
    b = (xy ** 2).sum(axis=1)
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    c = sol[:2]
    r = float(np.sqrt(sol[2] + (c ** 2).sum()))
    rms = float(np.sqrt(((np.linalg.norm(xy - c, axis=1) - r) ** 2).mean()))
    return c, r, rms


def detect_cylinders(mesh):
    """返回 [{kind, c(3), d(3), r, depth}](网格原始坐标系)"""
    fn = mesh.face_normals
    centroids = mesh.triangles_center
    ext = float(mesh.extents.max())

    # 候选轴向:包围盒三轴 + 惯性主轴
    dirs = [np.eye(3)[i] for i in range(3)]
    try:
        pca = np.linalg.svd(mesh.vertices - mesh.vertices.mean(0), full_matrices=False)[2]
        dirs += [v for v in pca]
    except Exception:
        pass
    uniq = []
    for d in dirs:
        d = d / np.linalg.norm(d)
        if not any(abs(d @ u) > 0.99 for u in uniq):
            uniq.append(d)

    found = []
    adj = mesh.face_adjacency
    for d in uniq:
        mask = np.abs(fn @ d) < 0.5   # 放宽以容纳螺纹面
        if mask.sum() < MIN_FACES:
            continue
        sel = np.where(mask)[0]
        remap = -np.ones(len(fn), dtype=int)
        remap[sel] = np.arange(len(sel))
        edges = adj[mask[adj].all(axis=1)]
        comps = trimesh.graph.connected_components(
            remap[edges], min_len=MIN_FACES, nodes=np.arange(len(sel)))
        u = np.array([d[1] - d[2], d[2] - d[0], d[0] - d[1]])
        u = u / np.linalg.norm(u)
        v = np.cross(d, u)
        for comp in comps:
            faces = sel[comp]
            pts = centroids[faces]
            xy = np.c_[pts @ u, pts @ v]
            c2, r, rms = fit_circle(xy)
            if r < ext * 1e-3 or r > ext * 0.35 or rms > r * FIT_TOL:
                continue
            dist = np.linalg.norm(xy - c2, axis=1)
            if np.percentile(dist, 95) - np.percentile(dist, 5) > 0.5 * r:
                continue  # 径向散布过大:锥面/混合面,不是圆柱
            ang = np.arctan2(xy[:, 1] - c2[1], xy[:, 0] - c2[0])
            if len(set(((ang + np.pi) / (2 * np.pi) * ARC_BINS).astype(int) % ARC_BINS)) < ARC_MIN:
                continue
            radial = (xy - c2)
            radial /= np.linalg.norm(radial, axis=1, keepdims=True)
            n2 = np.c_[fn[faces] @ u, fn[faces] @ v]
            inward = float((radial * n2).sum(axis=1).mean())
            t = pts @ d
            c3 = u * c2[0] + v * c2[1] + d * (t.min() + t.max()) / 2
            found.append({
                "kind": "hole" if inward < 0 else "peg",
                "c": c3, "d": d.copy(), "r": r,
                "depth": float(t.max() - t.min()),
                "n": len(faces),
            })

    # 后备通道:回转体(螺丝等)—— 螺纹把邻接聚类切碎,但所有侧壁点同轴心;
    # 仅在主通道一无所获时启用,按半径分带后逐带拟合
    if not found:
        fallback = []
        for d in uniq:
            mask = np.abs(fn @ d) < 0.6
            if mask.sum() < 60:
                continue
            faces = np.where(mask)[0]
            pts = centroids[faces]
            u = np.array([d[1] - d[2], d[2] - d[0], d[0] - d[1]])
            u = u / np.linalg.norm(u)
            v = np.cross(d, u)
            xy = np.c_[pts @ u, pts @ v]
            c2 = np.median(xy, axis=0)
            radii = np.linalg.norm(xy - c2, axis=1)
            order = np.argsort(radii)
            gaps = np.where(np.diff(radii[order]) > ext * 0.012)[0]
            bands = np.split(order, gaps + 1)
            for band in bands:
                if len(band) < 40:
                    continue
                bf = faces[band]
                bxy = xy[band]
                bc, r, rms = fit_circle(bxy)
                if r < ext * 1e-3 or r > ext * 0.45 or rms > r * 0.25:
                    continue
                ang = np.arctan2(bxy[:, 1] - bc[1], bxy[:, 0] - bc[0])
                if len(set(((ang + np.pi) / (2 * np.pi) * ARC_BINS).astype(int) % ARC_BINS)) < ARC_MIN:
                    continue
                radial = bxy - bc
                radial /= np.linalg.norm(radial, axis=1, keepdims=True)
                n2 = np.c_[fn[bf] @ u, fn[bf] @ v]
                inward = float((radial * n2).sum(axis=1).mean())
                t = centroids[bf] @ d
                c3 = u * bc[0] + v * bc[1] + d * (t.min() + t.max()) / 2
                fallback.append({
                    "kind": "hole" if inward < 0 else "peg",
                    "c": c3, "d": d.copy(), "r": r,
                    "depth": float(t.max() - t.min()), "n": len(bf),
                })
        # 回转体只有一根真实轴:按方向分组,只保留点数最多的主导方向,
        # 丢弃其他方向上的幽灵圆柱(如盘头在侧视方向的伪拟合)
        if fallback:
            groups = {}
            for f in fallback:
                key = None
                for k in groups:
                    if abs(f["d"] @ groups[k][0]["d"]) > 0.98:
                        key = k
                        break
                if key is None:
                    key = len(groups)
                    groups[key] = []
                groups[key].append(f)
            best = max(groups.values(), key=lambda g: max(f["depth"] for f in g))
            found.extend(best)

    # 去重:轴平行且同轴、半径相近的只留面数最多的
    found.sort(key=lambda f: -f["n"])
    kept = []
    for f in found:
        dup = False
        for k in kept:
            if abs(f["d"] @ k["d"]) > 0.98 and abs(f["r"] - k["r"]) < 0.35 * k["r"]:
                perp = (f["c"] - k["c"]) - k["d"] * ((f["c"] - k["c"]) @ k["d"])
                if np.linalg.norm(perp) < max(f["r"], k["r"]) * 0.6:
                    dup = True
                    break
        if not dup:
            kept.append(f)
    return kept


def main():
    files = sorted(PARTS.glob("*.glb"))
    meshes = {f.stem: trimesh.load(f, force="mesh") for f in files}
    global_max = max(float(m.extents.max()) for m in meshes.values())
    scale = TARGET_MAX / global_max
    print(f"最大零件尺寸 {global_max:.2f}(原始单位)→ unitScale = {scale:.5f}\n")

    parts = []
    for key, mesh in meshes.items():
        bmin, bmax = mesh.bounds
        # 平移:XZ 中心归零、底面(Y min)落地;再统一缩放
        off = np.array([(bmin[0] + bmax[0]) / 2, bmin[1], (bmin[2] + bmax[2]) / 2])

        def X(p):  # 原始坐标 → 编辑器局部坐标
            return [round(float(x), 4) for x in (np.asarray(p) - off) * scale]

        cyls = detect_cylinders(mesh)
        holes = sorted([c for c in cyls if c["kind"] == "hole"], key=lambda c: c["r"])
        pegs = sorted([c for c in cyls if c["kind"] == "peg"], key=lambda c: -c["depth"])
        part = {
            "key": key,
            "file": key + ".glb",
            "label": LABELS.get(key, key),
            "offset": [round(float(x), 5) for x in off],
            "bbox": {"min": X(bmin), "max": X(bmax)},
            "holes": [{
                "id": f"H{i+1}", "c": X(h["c"]),
                "d": [round(float(x), 4) for x in h["d"]],
                "r": round(h["r"] * scale, 4),
                "depth": round(h["depth"] * scale, 4),
            } for i, h in enumerate(holes)],
            "pegs": [{
                "id": f"P{i+1}", "c": X(p_["c"]),
                "d": [round(float(x), 4) for x in p_["d"]],
                "r": round(p_["r"] * scale, 4),
                "depth": round(p_["depth"] * scale, 4),
            } for i, p_ in enumerate(pegs)],
        }
        parts.append(part)
        mm = 1.0 if global_max > 1 else 1000.0  # 打印用:原始单位是否 mm
        hs = ", ".join(f"{h['id']}(⌀{2*h['r']/scale*mm:.1f})" for h in part["holes"][:8])
        ps = ", ".join(f"{p_['id']}(⌀{2*p_['r']/scale*mm:.1f})" for p_ in part["pegs"][:5])
        print(f"{key:28s} 孔 {len(part['holes']):2d} [{hs}]")
        print(f"{'':28s} 销 {len(part['pegs']):2d} [{ps}]")

    manifest = {"unitScale": round(scale, 6), "parts": parts}
    out = PARTS / "manifest.json"
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n已写入 {out}({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
