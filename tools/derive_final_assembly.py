#!/usr/bin/env python3
"""把参考装配补成整机 —— ARISTOS 只采到 53 个零件的位姿,剩下的按配合关系算出来。

任务图库(task_graphs.db)里 353 个步骤只有 52 个带 Step3DPaths,而且每一帧都是同样
的 53 个零件:螺旋桨、顶板、相机板、第 5/6 根立柱、配套的 M3x6 螺丝从头到尾没有位姿。
步骤名字倒是都在("Place Propeller on Motor Shaft (A)"、"Place Top Plate on Top of
Frame"、"Feed Screw through Top Plate and into Standoff (A)"……),只是没人采。

这里按零件自己的孔/销特征把这些位置算出来,附到 answer 后面,并标 derived: true。
算的依据(都能在装好的 53 件上量到):

  顶板      6 个孔对上 6 根立柱的自由端,最小二乘拟合(只剩绕 Y 的 0/180 和 XZ 平移)
  立柱 E/F  后板上空着的那对 M3 孔,朝向和长度照抄已装好的 4 根
  M3x6 螺丝 8 颗:6 颗从顶板拧进立柱,2 颗从顶板拧进相机板
  相机板    竖着站在顶板和前板之间(局部 Z 朝上),H3 对准顶板的前面那对孔,
            M2 相机孔朝向机身中线
  螺旋桨    桨毂孔套在电机轴上,贴着电机最外侧的端面 —— 这个模型的轴整根缩在
            桨座里,露不出来,所以贴端面是唯一站得住的位置;螺母(ARISTOS 采的)
            在桨座内侧,和桨不打架,原始位姿一个都没动

正反桨落在哪条对角线,数据里没有说法,所以 check.js 把 propeller_cw / propeller_ccw
当成可互换的同一种零件(和 M3x16 杯头/盘头一样),两种装法都算对。

用法:
    python3 tools/derive_final_assembly.py            # 写回 assets/parts/manifest.json
    python3 tools/derive_final_assembly.py --dry-run  # 只打印,不写
"""
import argparse, itertools, json, math, pathlib, uuid
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / 'assets' / 'parts' / 'manifest.json'
ANSWER = ROOT / 'assets' / 'parts' / 'answer_poses_full.json'


# ---------------------------------------------------------------- 位姿换算
def rot(rpy):
    """XYZ 欧拉角 -> 旋转矩阵(R = Rx·Ry·Rz,和 parts.js / step_3d_paths 一致)"""
    rx, ry, rz = rpy
    cx, sx, cy, sy, cz, sz = (math.cos(rx), math.sin(rx), math.cos(ry),
                              math.sin(ry), math.cos(rz), math.sin(rz))
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rx @ Ry @ Rz


def euler_of(R):
    """旋转矩阵 -> XYZ 欧拉角"""
    sy = float(np.clip(R[0, 2], -1.0, 1.0))
    ry = math.asin(sy)
    if abs(sy) < 0.999999:
        rx = math.atan2(-R[1, 2], R[2, 2])
        rz = math.atan2(-R[0, 1], R[0, 0])
    else:                                   # 万向节锁:把转动都归到 rx
        rx = math.atan2(R[2, 1], R[1, 1])
        rz = 0.0
    return [rx, ry, rz]


class Kit:
    """零件库 + 已有的参考装配,统一换算到场景单位"""

    def __init__(self, manifest):
        self.S = manifest['unitScale']
        self.K = self.S / 1000.0                   # 单位 / 毫米
        self.spec = {p['key']: p for p in manifest['parts']}
        self.answer = manifest['answer']
        self.manifest = manifest

    def frame(self, key, pose):
        """GLB 原点位姿(mm, rpy) -> 节点位置(单位)+ 朝向"""
        R = rot([pose.get('roll', 0), pose.get('pitch', 0), pose.get('yaw', 0)])
        off = np.array(self.spec[key]['offset']) * self.S
        p = np.array([pose.get('x', 0), pose.get('y', 0), pose.get('z', 0)]) * self.K + R @ off
        return p, R

    def pose(self, key, p, R):
        """节点位置 + 朝向 -> GLB 原点位姿(写回 answer 用)"""
        off = np.array(self.spec[key]['offset']) * self.S
        o = (p - R @ off) / self.K
        e = euler_of(R)
        return {'x': round(float(o[0]), 4), 'y': round(float(o[1]), 4), 'z': round(float(o[2]), 4),
                'roll': round(e[0], 6), 'pitch': round(e[1], 6), 'yaw': round(e[2], 6)}

    def feature(self, key, fid):
        for kind in ('holes', 'pegs'):
            for f in self.spec[key].get(kind, []):
                if f['id'] == fid:
                    return f
        raise KeyError(f'{key} has no feature {fid}')

    def placed(self):
        """参考装配里每个零件的最终位置"""
        for d in self.answer['parts']:
            p, R = self.frame(d['key'], d['path'][-1])
            yield d, p, R

    def of_key(self, key):
        return [(d, p, R) for d, p, R in self.placed() if d['key'] == key]

    def world_feature(self, key, p, R, fid):
        f = self.feature(key, fid)
        c = p + R @ np.array(f['c'])
        d = R @ np.array(f['d'])
        return c, d / np.linalg.norm(d), f['r'], f['depth']


def basis(x_img, y_img):
    """给定局部 X / Y 轴的世界方向,补出右手正交基(列 = 局部轴的像)"""
    a = np.array(x_img, float); a /= np.linalg.norm(a)
    b = np.array(y_img, float); b -= a * (a @ b); b /= np.linalg.norm(b)
    return np.column_stack([a, b, np.cross(a, b)])


# ---------------------------------------------------------------- 各零件怎么摆
def standoff_ends(kit):
    """已装好的 4 根立柱:自由端的位置和轴向(轴指向自由端)"""
    out = []
    for d, p, R in kit.of_key('knurled_standoff'):
        c, dir_, r, depth = kit.world_feature('knurled_standoff', p, R, 'H1')
        out.append({'name': d['name'], 'end': c + dir_ * depth / 2, 'dir': dir_,
                    'root': c - dir_ * depth / 2, 'p': p, 'R': R, 'depth': depth})
    return sorted(out, key=lambda s: (s['end'][0] < 0, s['end'][2]))


def extra_standoffs(kit, ref):
    """第 5/6 根立柱:后板上空着的那对 M3 孔,姿态照抄已装好的那几根"""
    used = [np.array(s['root']) for s in ref]
    (d, p, R), = kit.of_key('split_rear_plate')
    free = []
    for f in kit.spec['split_rear_plate'].get('holes', []):
        c, dir_, r, depth = kit.world_feature('split_rear_plate', p, R, f['id'])
        if min(np.linalg.norm(c - u) for u in used) < 0.15:
            continue
        free.append((f['id'], c, dir_))
    # 顶板最后那对孔(局部 z 最大)该落在哪 —— 取后板上最靠后的那对孔
    free.sort(key=lambda t: -t[1][2])
    picked = free[:2]
    out = []
    for i, (fid, c, dir_) in enumerate(sorted(picked, key=lambda t: -t[1][0])):
        R = ref[0]['R']                                  # 和其他立柱同姿态
        axis = ref[0]['dir']                             # 指向自由端(向下)
        depth = ref[0]['depth']
        root = np.array([c[0], ref[0]['root'][1], c[2]])  # 贴着板面,和其他几根同高
        p = root + axis * depth / 2 - R @ np.array(kit.feature('knurled_standoff', 'H1')['c'])
        out.append({'name': f'Standoff #{5 + i}', 'p': p, 'R': R,
                    'end': root + axis * depth, 'dir': axis, 'root': root, 'depth': depth,
                    'plate_hole': fid})
    return out


def top_plate(kit, standoffs):
    """顶板:6 个孔对 6 根立柱的自由端。只剩绕 Y 的 0/180 和 XZ 平移可选"""
    spec = kit.spec['top_plate']
    holes = {h['id']: np.array(h['c']) for h in spec['holes']}
    axis = standoffs[0]['dir']                            # 立柱指向自由端
    ends = np.array([s['end'] for s in standoffs])
    ids = ['H1', 'H2', 'H5', 'H6', 'H3', 'H4']            # 6 个立柱孔(H7/H8 给相机板)
    best = None
    for flip in (1, -1):                                  # 绕 Y 转 0 / 180
        R = np.diag([flip, 1.0, flip]).astype(float)
        P = np.array([R @ holes[i] for i in ids])
        for perm in itertools.permutations(range(len(ends))):
            Q = ends[list(perm)]
            t = (Q - P).mean(axis=0)
            res = np.linalg.norm(P + t - Q, axis=1)
            if best is None or res.max() < best['res'].max():
                best = {'R': R, 't': t, 'res': res, 'order': perm, 'ids': ids}
    # Y 方向单独定:孔口(朝立柱那一面)正好贴住立柱端面
    hole_depth = kit.feature('top_plate', 'H1')['depth']
    t = best['t'].copy()
    t[1] = (ends[:, 1].mean() - (best['R'] @ holes['H1'])[1]) + axis[1] * hole_depth / 2
    best['t'] = t
    best['holes_world'] = {i: best['R'] @ holes[i] + t for i in holes}
    return best


def screw_into(kit, key, hole_c, axis, plate_half=0.0, flush=False):
    """一颗螺丝拧进 hole_c:沿 axis 往里走,头留在外面贴着受件表面

    朝向按零件自己的两个销定:小的那个是杆(P1),大的是头(P2),从杆指向头的方向
    就是"往外",所以它要对到 -axis 上 —— 这一步之前弄反了,螺丝头埋进了立柱里。
    位置按"头的下沿压在受件外表面上"摆,和 ARISTOS 采到的那些螺丝是一个装法。
    """
    pegs = kit.spec[key]['pegs']
    shaft = min(pegs, key=lambda f: f['r'])
    head = max(pegs, key=lambda f: f['r'])
    pd = np.array(shaft['d'], float); pd /= np.linalg.norm(pd)
    if (np.array(head['c']) - np.array(shaft['c'])) @ pd < 0:
        pd = -pd                                   # pd 一律指向头那一侧
    R = basis_for_axis(pd, -np.asarray(axis, float))
    # 盘头压在板面上,量到头的下沿;沉头整个陷进锥孔,量到头顶
    seat = float(np.array(head['c']) @ pd) + (head['depth'] / 2 if flush else -head['depth'] / 2)
    face = np.asarray(hole_c, float) - np.asarray(axis, float) * plate_half
    p = face - R @ (pd * seat)
    return p, R


def basis_for_axis(local_dir, world_dir):
    """把零件的局部轴转到世界轴上,绕该轴的自转随便取一个稳定值"""
    a = np.array(local_dir, float); a /= np.linalg.norm(a)
    b = np.array(world_dir, float); b /= np.linalg.norm(b)
    v = np.cross(a, b); s = np.linalg.norm(v); c = float(a @ b)
    if s < 1e-9:
        return np.eye(3) if c > 0 else rot([math.pi, 0, 0]) if abs(a[0]) < .9 else rot([0, math.pi, 0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / (s * s))


def camera_plates(kit, plate):
    """相机板:竖在顶板和前板之间,H3 对准顶板前面那对孔,M2 相机孔朝机身中线"""
    out = []
    for key, hid in (('camera_plate_right', 'H7'), ('camera_plate_left', 'H8')):
        spec = kit.spec[key]
        h3 = kit.feature(key, 'H3')
        target = plate['holes_world'][hid]               # 顶板上那个孔的中心
        up = np.array([0.0, 1.0, 0.0])
        if plate['t'][1] > 0:                            # 顶板在上面时相机板朝下站
            up = -up
        inward = np.array([-1.0, 0.0, 0.0]) if target[0] > 0 else np.array([1.0, 0.0, 0.0])
        # 局部 Z 朝 up(板子立起来),局部 Y 朝机身中线(相机螺丝往里拧)
        z_img = up
        y_img = inward - z_img * (inward @ z_img)
        y_img /= np.linalg.norm(y_img)
        x_img = np.cross(y_img, z_img)
        R = np.column_stack([x_img, y_img, z_img])
        # H3 的轴线穿过顶板的孔;板子底面贴住顶板的表面(孔心在板厚中间,要再让开半个板厚)
        zmin = spec['bbox']['min'][2]
        face = target[1] + up[1] * kit.feature('top_plate', plate['ids'][0])['depth'] / 2
        p = target - R @ np.array(h3['c'])
        bottom = (R @ np.array([0, 0, zmin]))[1] + p[1]
        p[1] += face - bottom
        # 前板上和这个通孔同轴的那个孔 —— 下面那颗螺丝从那里拧进来
        (fd, fp, fR), = kit.of_key('split_front_plate')
        h3w = p + R @ np.array(h3['c'])
        best = None
        for f in kit.spec['split_front_plate']['holes']:
            fc = fp + fR @ np.array(f['c'])
            d = math.hypot(fc[0] - h3w[0], fc[2] - h3w[2])
            if best is None or d < best[0]:
                best = (d, f['id'])
        out.append({'key': key, 'p': p, 'R': R, 'hole': hid, 'front_hole': best[1],
                    'name': 'Left Camera Plate' if 'left' in key else 'Right Camera Plate'})
    return out


def propellers(kit):
    """螺旋桨:桨毂孔套上电机轴,桨毂内侧贴住螺母

    电机网格沿轴最外的点是 M5 螺纹轴的尖(露出外壳约 13.5 mm),以前贴着它放,
    桨毂就挂在轴尖外面,和螺母之间空出一截螺纹。ARISTOS 采到的螺母紧挨着电机外壳端面
    (采集的位姿不改),所以桨毂内侧面贴住螺母外侧面 —— 桨整个套在螺纹轴上,两者贴紧。
    没有对应螺母时,贴电机外壳端面(轴以外、半径比轴大的那部分网格最外的面)。
    """
    import trimesh

    def world_verts(key, p, R):
        mesh = trimesh.load(str(ROOT / 'assets' / 'parts' / kit.spec[key]['file']), force='mesh')
        v = np.asarray(mesh.vertices) * kit.S - np.array(kit.spec[key]['offset']) * kit.S
        return (R @ v.T).T + p

    out = []
    motors = sorted(kit.of_key('motor_2207'), key=lambda t: t[0]['name'])
    nuts = {d['name']: (d, p, R) for d, p, R in kit.placed() if d['name'].startswith('Propeller Nut #')}
    keys = ['propeller_cw', 'propeller_ccw', 'propeller_ccw', 'propeller_cw']  # 对角同向
    for i, (d, p, R) in enumerate(motors):
        shaft_c, axis, r, depth = kit.world_feature('motor_2207', p, R, 'P2')
        nut = nuts.get(f'Propeller Nut #{i + 1}')
        if nut:
            face = float(np.max(world_verts(nut[0]['key'], nut[1], nut[2]) @ axis))   # 螺母外侧面
        else:
            w = world_verts('motor_2207', p, R)
            rel = w - shaft_c
            radial = np.linalg.norm(rel - np.outer(rel @ axis, axis), axis=1)
            face = float(np.max((w @ axis)[radial > r * 1.5]))                          # 电机外壳端面
        key = keys[i]
        bore = kit.feature(key, 'H1')
        bd = np.array(bore['d'], float); bd /= np.linalg.norm(bd)
        Rp = basis_for_axis(bd, axis)                    # 桨毂轴 -> 电机轴
        bore_c = np.array(bore['c'])
        # 桨毂孔心落在轴线上,轴向位置让桨毂内侧面正好贴住电机端面
        target = shaft_c + axis * (face + bore['depth'] / 2 - shaft_c @ axis)
        pos = target - Rp @ bore_c
        # 按桨自己的网格校正:有的桨(反转桨)桨毂比孔特征多伸出一点,网格最里面那一面才该贴住
        inner = float(np.min(world_verts(key, pos, Rp) @ axis))
        pos = pos + axis * (face - inner)
        out.append({'key': key, 'p': pos, 'R': Rp, 'motor': d['name'],
                    'name': f'Propeller #{i + 1}'})
    return out


# ---------------------------------------------------------------- 组装成 answer
def approach(pose, axis, kit, mm=36.0):
    """接近位姿:沿装配方向往外退 36 mm,和 ARISTOS 采的那些轨迹长度差不多"""
    out = dict(pose)
    out['x'] -= float(axis[0]) * mm / 1.0
    out['y'] -= float(axis[1]) * mm / 1.0
    out['z'] -= float(axis[2]) * mm / 1.0
    return out


def build(kit):
    """算出补充零件的位姿,并把配合关系(mates)双向挂好"""
    ref = standoff_ends(kit)
    extra = extra_standoffs(kit, ref)
    allstands = ref + extra
    plate = top_plate(kit, allstands)
    cams = camera_plates(kit, plate)
    props = propellers(kit)

    step0 = len(kit.answer['steps'])
    steps, parts = [], []
    frames = {}                       # 零件名 -> (id, key, p, R),算 mates 的相对位姿要用
    for d, p_, R_ in kit.placed():
        frames[d['name']] = (d['id'], d['key'], p_, R_)
    existing = {d['name']: d for d in kit.answer['parts']}

    def add_step(name):
        steps.append({'i': step0 + len(steps), 'id': str(uuid.uuid4()), 'name': name,
                      'requires': [], 'derived': True})
        return steps[-1]['i']

    # 零件实例 id 用任务图里的 Parts.uuid(料盘里同名的那件),不要自己编:
    # 宿主(ARISTOS)收到的装配状态、最终位姿都按这个 id 对零件
    kit_ids = {o['name']: o['id'] for o in kit.manifest['kit']}

    def add_part(key, name, step, p, R, axis):
        pose = kit.pose(key, p, R)
        d = {'id': kit_ids.get(name) or str(uuid.uuid4()), 'key': key, 'name': name, 'step': step,
             'derived': True, 'mates': [], 'path': [approach(pose, axis, kit), pose]}
        parts.append(d)
        frames[name] = (d['id'], key, p, R)
        return d

    def mate(a_name, b_name, features=None, kind='feature'):
        """双向挂上配合关系 —— 判定器靠它知道一个零件该和谁比"""
        ia, ka, pa, Ra = frames[a_name]
        ib, kb, pb, Rb = frames[b_name]
        a = existing.get(a_name) or next(x for x in parts if x['name'] == a_name)
        b = existing.get(b_name) or next(x for x in parts if x['name'] == b_name)
        pairs = [list(f) for f in (features or [])]
        a.setdefault('mates', []).append(
            {'id': ib, 'kind': kind, 'features': pairs, 'rel': rel_pose(kit, ka, pa, Ra, pb, Rb)})
        b.setdefault('mates', []).append(
            {'id': ia, 'kind': kind, 'features': [[y, x] for x, y in pairs],
             'rel': rel_pose(kit, kb, pb, Rb, pa, Ra)})

    # 零件和步骤的对应不靠猜:任务图 StepParts 写死了每一步用哪颗螺丝
    #   立柱 E/F  在后板那端各一颗 M3x6 盘头(Standoff Screw #5/#6)
    #   顶板->立柱 A/B 用盘头(#7/#8),C/D/E/F 用沉头(#9-#12)—— 沉头在 ARISTOS
    #                  那边 model=TODO_MODEL,没有网格,这四颗只能留空
    #   相机板    上下各一颗盘头:上面穿顶板、下面穿前板,进的是同一个通孔 H3
    # 九颗盘头正好用完(采集的 Center X-Lock Screw 占掉第一颗)
    letter_of = {}
    for st in allstands:
        letter_of[st['name']] = 'ABCDEF'[int(st['name'].split('#')[1]) - 1]
    (rear, rp, rR), = kit.of_key('split_rear_plate')
    (front, fp, fR), = kit.of_key('split_front_plate')

    # 1) 第 5/6 根立柱:拧在后板空着的那对孔上,各配一颗盘头
    for i, s in enumerate(extra):
        letter = letter_of[s['name']]
        si = add_step(f'Attach Knurled Standoff to Frame Bottom ({letter})')
        add_part('knurled_standoff', s['name'], si, s['p'], s['R'], -s['dir'])   # 从下往上怼到板子上
        mate(s['name'], 'Split Rear Plate', [['H1', s['plate_hole']]])
        hole = kit.feature('split_rear_plate', s['plate_hole'])
        hc = rp + rR @ np.array(hole['c'])
        sp, sR = screw_into(kit, 'screw_m3x6_pan', hc, s['dir'], hole['depth'] / 2)
        sname = f'Standoff Screw #{5 + i}'
        add_part('screw_m3x6_pan', sname, si, sp, sR, s['dir'])
        mate(sname, 'Split Rear Plate', [['P1', s['plate_hole']]])
        mate(sname, s['name'], [['P1', 'H1']])

    # 2) 顶板:压在 6 根立柱的自由端上
    si = add_step('Place Top Plate on Top of Frame')
    add_part('top_plate', 'Top Plate', si, plate['t'], plate['R'], -allstands[0]['dir'])   # 托到立柱端面上
    order = list(plate['order'])
    for n, idx in enumerate(order):
        mate('Top Plate', allstands[idx]['name'], [[plate['ids'][n], 'H1']])

    # 3) 顶板拧进立柱:任务图里 A/B 是盘头(#7/#8)、C-F 是沉头(#9-#12)。
    #    沉头上游没有模型,我们不再单独做:六颗一律用 M3×6 盘头,头压在顶板面上
    for n, idx in enumerate(order):
        s = allstands[idx]
        hid = plate['ids'][n]
        letter = letter_of[s['name']]
        si = add_step(f'Feed Screw through Top Plate and into Standoff ({letter})')
        half = kit.feature('top_plate', hid)['depth'] / 2
        skey = 'screw_m3x6_pan'
        sname = 'Standoff Screw #' + str(7 + 'ABCDEF'.index(letter))
        sp, sR = screw_into(kit, skey, plate['holes_world'][hid], -s['dir'], half)
        add_part(skey, sname, si, sp, sR, -s['dir'])
        mate(sname, 'Top Plate', [['P1', hid]])
        mate(sname, s['name'], [['P1', 'H1']])

    # 4) 相机板:竖在顶板和前板之间,上下各一颗螺丝
    for c in cams:
        side = 'Left' if 'left' in c['key'] else 'Right'
        si = add_step(f'Place {side} Camera Plate')
        # 相机板从机头方向推进去:上下都被顶板和前板夹着,从上或从下都会穿模
        add_part(c['key'], c['name'], si, c['p'], c['R'], np.array([0.0, 0.0, 1.0]))
        mate(c['name'], 'Top Plate', [['H3', c['hole']]])
        mate(c['name'], 'Split Front Plate', kind='contact')

        # 下面那颗:穿前板拧进相机板的通孔(前板在这个坐标系里位于相机板上方)
        si = add_step(f'Attach {side} Camera Plate to Split Front Plate')
        fid = c['front_hole']
        fh = kit.feature('split_front_plate', fid)
        fc = fp + fR @ np.array(fh['c'])
        ins = np.array([0.0, -1.0, 0.0])
        sp, sR = screw_into(kit, 'screw_m3x6_pan', fc, ins, fh['depth'] / 2)
        lower = f'M3x6 {side} Camera Plate Lower Screw'
        add_part('screw_m3x6_pan', lower, si, sp, sR, ins)
        mate(lower, 'Split Front Plate', [['P1', fid]])
        mate(lower, c['name'], [['P1', 'H3']])

        # 上面那颗:穿顶板拧进同一个通孔的另一头
        si = add_step(f'Feed Screw through Top Plate and into {side} Camera Plate')
        axis = np.array([0.0, 1.0, 0.0]) if plate['t'][1] < 0 else np.array([0.0, -1.0, 0.0])
        half = kit.feature('top_plate', c['hole'])['depth'] / 2
        sp, sR = screw_into(kit, 'screw_m3x6_pan', plate['holes_world'][c['hole']], axis, half)
        upper = f'M3x6 {side} Camera Plate Upper Screw'
        add_part('screw_m3x6_pan', upper, si, sp, sR, axis)
        mate(upper, 'Top Plate', [['P1', c['hole']]])
        mate(upper, c['name'], [['P1', 'H3']])

    # 5) 螺旋桨:套在电机轴上
    for i, pr in enumerate(props):
        si = add_step(f'Place Propeller on Motor Shaft ({"ABCD"[i]})')
        # 桨装在电机外侧,是从外面往电机端面上推,不是从电机那头穿过来
        add_part(pr['key'], pr['name'], si, pr['p'], pr['R'], np.array([0.0, 1.0, 0.0]))
        mate(pr['name'], pr['motor'], [['H1', 'P2']])

    return steps, parts, {'plate_residual_mm': plate['res'] / kit.K}


def rel_pose(kit, key, p, R, p_other, R_other):
    """这个零件在配合件坐标系里的位姿(mm),和 features_db.py 写出来的一个格式"""
    Rr = R_other.T @ R
    t = R_other.T @ (p - p_other) / kit.K
    e = euler_of(Rr)
    return {'x': round(float(t[0]), 3), 'y': round(float(t[1]), 3), 'z': round(float(t[2]), 3),
            'roll': round(e[0], 4), 'pitch': round(e[1], 4), 'yaw': round(e[2], 4)}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dry-run', action='store_true', help='只打印结果,不写文件')
    a = ap.parse_args()

    manifest = json.loads(MANIFEST.read_text())
    kit = Kit(manifest)
    before = len(kit.answer['parts'])
    # 重跑时先把上次推的去掉
    kit.answer['steps'] = [s for s in kit.answer['steps'] if not s.get('derived')]
    derived_ids = {p['id'] for p in kit.answer['parts'] if p.get('derived')}
    kit.answer['parts'] = [p for p in kit.answer['parts'] if not p.get('derived')]
    for p in kit.answer['parts']:        # 原始零件上指向推导件的配合关系也一起清掉
        if p.get('mates'):
            p['mates'] = [m for m in p['mates'] if m['id'] not in derived_ids]

    steps, parts, info = build(kit)
    print(f'参考装配 {len(kit.answer["parts"])} 件 / {len(kit.answer["steps"])} 步'
          f'  ->  补 {len(parts)} 件 / {len(steps)} 步')
    for s in steps:
        names = [p['name'] for p in parts if p['step'] == s['i']]
        print(f'  {s["i"]:>3} {s["name"]:<52} {", ".join(names)}')
    res = info['plate_residual_mm']
    print(f'顶板孔位残差: 最大 {res.max():.2f} mm, 平均 {res.mean():.2f} mm')
    for m in info.get('missing', []):
        print(f'缺模型,未放置: {m}')

    if a.dry_run:
        return
    kit.answer['steps'].extend(steps)
    kit.answer['parts'].extend(parts)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')))
    ANSWER.write_text(json.dumps(kit.answer, ensure_ascii=False, indent=1))
    print(f'写回 {MANIFEST.relative_to(ROOT)}({before} -> {len(kit.answer["parts"])} 件)'
          f' 和 {ANSWER.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
