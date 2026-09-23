#!/usr/bin/env python3
"""补一个 M3×6 沉头螺丝的模型 —— 任务图里有这个零件,但上游 model=TODO_MODEL。

顶板拧进立柱 C/D/E/F 的那四颗任务图指定成沉头(头沉进板面,电池绑带不刮手),
可是 ARISTOS 没给网格,于是这四步一直空着。这里按 ISO 10642 / DIN 7991 的
标准尺寸车一个出来:

    光杆  Ø3 mm × 4.5 mm
    锥头  90°,Ø6 mm 收到 Ø3 mm,锥高 (6-3)/2 = 1.5 mm
    总长  6 mm(沉头螺丝的长度含头)

原点放在杆尖,+Y 朝头 —— 和零件库里 screw_m3x6_pan 的约定一致。
同时把零件登记进 manifest(parts 条目 + kit 里的 4 个实例),可以重复跑。

用法:
    python3 tools/make_countersunk_screw.py
"""
import json, math, pathlib, uuid
import numpy as np
import trimesh

ROOT = pathlib.Path(__file__).resolve().parents[1]
PARTS = ROOT / 'assets' / 'parts'
KEY = 'screw_m3x6_countersunk'
FILE = KEY + '.glb'
# 固定的一个合法 uuid:kit 里用 /assembly_graph_assets/<uuid>.glb 指过来,
# parts.js 的 keyForModel 只认十六进制的 uuid,别自己编带字母的
MODEL_UUID = 'c0d7e5a1-4f2b-4a11-9d6b-7e3c1a5b90fe'

SHANK_R, SHANK_L = 0.0015, 0.0045      # 米
HEAD_R, HEAD_H = 0.0030, 0.0015
SOCKET_R, SOCKET_D = 0.0011, 0.0009    # 顶上的内六角凹坑


def build_mesh():
    """绕 Y 轴旋成:杆 + 90° 锥头,顶面再挖个内六角的浅坑"""
    profile = [(0.0, 0.0), (SHANK_R, 0.0), (SHANK_R, SHANK_L),
               (HEAD_R, SHANK_L + HEAD_H), (0.0, SHANK_L + HEAD_H)]
    body = trimesh.creation.revolve([(r, y) for r, y in profile], sections=48)
    body.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
    body.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [0, 1, 0]))
    # revolve 绕 Z 转,上面两步把它立到 +Y;拿包围盒兜个底,保证 y 从 0 开始
    body.apply_translation([0, -body.bounds[0][1], 0])
    socket = trimesh.creation.cylinder(radius=SOCKET_R, height=SOCKET_D * 2, sections=6)
    socket.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
    socket.apply_translation([0, SHANK_L + HEAD_H, 0])
    try:
        out = body.difference(socket)
        if out.is_empty or len(out.vertices) < 8:
            raise ValueError('boolean failed')
    except Exception:
        out = body                      # 没有布尔后端就是个平顶,不影响装配
    out.merge_vertices()
    out.fix_normals()
    return out


def register(mesh, manifest):
    S = manifest['unitScale']
    mm = 1000.0 / S
    ent = {
        'key': KEY, 'file': FILE, 'label': 'M3×6 沉头', 'models': [MODEL_UUID],
        'partTypeUuid': None,
        'name': 'Lumenier QAV-S 2 Joshua Bardwell Screw - M3x6mm Countersunk',
        'offset': [0.0, 0.0, 0.0],
        'bbox': {'min': [round(v * S, 4) for v in mesh.bounds[0]],
                 'max': [round(v * S, 4) for v in mesh.bounds[1]]},
        'sym': [{'axis': [0.0, 1.0, 0.0], 'deg': 180.0}],
        'sym_center': [0.0, round((SHANK_L + HEAD_H) / 2 * S, 4), 0.0],
        'holes': [],
        'pegs': [
            {'id': 'P1', 'c': [0.0, round(SHANK_L / 2 * S, 4), 0.0], 'd': [0.0, 1.0, 0.0],
             'r': round(SHANK_R * S, 4), 'depth': round(SHANK_L * S, 4)},
            {'id': 'P2', 'c': [0.0, round((SHANK_L + HEAD_H / 2) * S, 4), 0.0], 'd': [0.0, 1.0, 0.0],
             'r': round(HEAD_R * S, 4), 'depth': round(HEAD_H * S, 4)},
        ],
    }
    parts = [p for p in manifest['parts'] if p['key'] != KEY]
    parts.append(ent)
    manifest['parts'] = parts
    # kit:托盘里放 4 颗(顶板 C/D/E/F 各一)
    kit = [o for o in manifest['kit'] if MODEL_UUID not in (o.get('glb') or '')]
    x0 = min(o['pose']['x'] for o in kit) if kit else 0.0
    z0 = max(o['pose']['z'] for o in kit) if kit else 0.0
    for i in range(4):
        kit.append({'id': str(uuid.uuid4()), 'name': f'Standoff Screw #{9 + i}',
                    'glb': f'/assembly_graph_assets/{MODEL_UUID}.glb',
                    'pose': {'x': round(x0 + 12 * i, 2), 'y': 0.0, 'z': round(z0 + 14, 2),
                             'roll': 0.0, 'pitch': 0.0, 'yaw': 0.0}})
    manifest['kit'] = kit
    return ent, mm


def main():
    mesh = build_mesh()
    mesh.export(PARTS / FILE)
    manifest = json.loads((PARTS / 'manifest.json').read_text())
    ent, mm = register(mesh, manifest)
    (PARTS / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')))
    size = mesh.extents * 1000
    print(f'{FILE}: {len(mesh.vertices)} 顶点, 外形 {size[0]:.1f} × {size[1]:.1f} × {size[2]:.1f} mm')
    print(f"  杆 Ø{SHANK_R * 2000:.1f} × {SHANK_L * 1000:.1f} mm, "
          f"头 Ø{HEAD_R * 2000:.1f} × {HEAD_H * 1000:.1f} mm (90° 锥), 总长 {(SHANK_L + HEAD_H) * 1000:.1f} mm")
    print(f"  登记进 manifest: parts +1 种, kit +4 件 (共 {len(manifest['kit'])} 件)")


if __name__ == '__main__':
    main()
