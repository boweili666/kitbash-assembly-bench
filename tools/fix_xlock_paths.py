#!/usr/bin/env python3
"""Re-record the X-Lock steps of step_3d_paths.json the way the build is actually done.

As recorded, steps 1 and 2 ("Feed Screw through Arm Wedge (A)/(B)") put each wedge and its
screw straight at their final spot, floating in the air; step 3 ("Attach Arm Wedge Assembly to
X-Lock (A)") then flies the X-Lock in between them, and step 4 (B) moves nothing.

Re-recorded (the task graph itself is unchanged):
  steps 1, 2  each wedge + screw is assembled on the bench, OFFSET_MM out from its final spot
              along the screw axis (left group -X, right group +X), same orientation
  step 3 (A)  the X-Lock comes from the tray to its final spot, then the left group slides in
              from the bench as one piece
  step 4 (B)  the right group slides in from the bench as one piece
  later steps unchanged: these parts are at their final spots from here on

    python3 tools/fix_xlock_paths.py IN.json OUT.json
"""
import copy, json, sys

OFFSET_MM = 60.0      # bench distance of each wedge group from its final spot
APPROACH_MM = 20.0    # where the slide-in starts its last straight bit

STEP_FEED_A = "65ad97a4-76f9-4ddd-83e6-f2f73070cc21"
STEP_FEED_B = "3b3966f3-e84e-4a2b-a178-7b59e250d52d"
STEP_ATTACH_A = "972c5284-031e-44eb-883f-cc040168dac0"
STEP_ATTACH_B = "92f36455-5ebe-499b-8ef7-e87535890cf8"
X_LOCK = "33ee88b1-9980-4e0b-ade6-1052789ff327"
LEFT = ["92cf9ccb-73e0-4204-a6e7-eef13c3c8260"]       # Left Arm Wedge (+ its screw, found below)
RIGHT = ["cb234cda-1e15-4933-b9cf-9571d4da561f"]      # Right Arm Wedge
FIELDS = ("x", "y", "z", "roll", "pitch", "yaw")


def poses_at(step, k):
    return {p["part_id"]: p for p in step["3d_path"][k]["poses"]}


def moved_in(step):
    a, b = poses_at(step, 0), poses_at(step, -1)
    return [pid for pid in a if any(abs(a[pid][f] - b[pid][f]) > 1e-6 for f in FIELDS)]


def shifted(p, dx):
    q = dict(p); q["x"] = round(p["x"] + dx, 6); return q


def main(src, dst):
    data = json.load(open(src))
    steps = {s["step_id"]: s for s in data["steps"]}
    order = [s["step_id"] for s in data["steps"]]
    for sid in (STEP_FEED_A, STEP_FEED_B, STEP_ATTACH_A, STEP_ATTACH_B):
        assert sid in steps, sid
    # each group = the parts its feed step moves (wedge + screw)
    left = moved_in(steps[STEP_FEED_A]); right = moved_in(steps[STEP_FEED_B])
    assert LEFT[0] in left and RIGHT[0] in right and len(left) == 2 and len(right) == 2, (left, right)
    assert moved_in(steps[STEP_ATTACH_A]) == [X_LOCK] and moved_in(steps[STEP_ATTACH_B]) == []
    final = poses_at(steps[STEP_ATTACH_B], -1)                 # everything is in place after step 4
    side = {pid: -OFFSET_MM for pid in left}; side.update({pid: OFFSET_MM for pid in right})
    i_feed_a, i_feed_b = order.index(STEP_FEED_A), order.index(STEP_FEED_B)
    i_att_a, i_att_b = order.index(STEP_ATTACH_A), order.index(STEP_ATTACH_B)

    def on_bench(pid):
        return shifted(final[pid], side[pid])

    # steps 1, 2: the in-step trajectory of the group shifted out to the bench; a part still lying in
    # the tray (same pose as at the start of the step) stays where it is
    for sid, grp in ((STEP_FEED_A, left), (STEP_FEED_B, right)):
        start = poses_at(steps[sid], 0)
        for k, kf in enumerate(steps[sid]["3d_path"]):
            if k == 0:
                continue
            for p in kf["poses"]:
                pid = p["part_id"]
                if pid in grp and any(abs(p[f] - start[pid][f]) > 1e-6 for f in FIELDS):
                    p.update(shifted(p, side[pid]))
    # between its feed step and its attach step a group waits on the bench
    for i, sid in enumerate(order):
        for kf in steps[sid]["3d_path"]:
            for p in kf["poses"]:
                pid = p["part_id"]
                if pid in left and i_feed_a < i < i_att_a or pid in right and i_feed_b < i < i_att_b:
                    p.update(on_bench(pid))
    # step 3 (A): X-Lock tray -> its recorded approach -> final, then the left group bench -> approach -> final
    a0 = poses_at(steps[STEP_ATTACH_A], 0)
    xl_tray = dict(a0[X_LOCK])
    xl_way = [poses_at(steps[STEP_ATTACH_A], k)[X_LOCK] for k in range(len(steps[STEP_ATTACH_A]["3d_path"]))]
    xl_approach = dict(xl_way[-2]) if len(xl_way) > 2 else dict(final[X_LOCK])
    def frame(t, xl, left_at, right_at):
        poses = []
        for p in steps[STEP_ATTACH_A]["3d_path"][0]["poses"]:
            pid = p["part_id"]
            if pid == X_LOCK: q = dict(xl)
            elif pid in left: q = left_at(pid)
            elif pid in right: q = right_at(pid)
            else: q = dict(p)          # everything else stays where it was at the start of the step
            q["part_id"] = pid; poses.append(q)
        return {"time": t, "poses": poses}
    approach = lambda pid: shifted(final[pid], side[pid] * APPROACH_MM / OFFSET_MM)
    steps[STEP_ATTACH_A]["3d_path"] = [
        frame(0.0, xl_tray, on_bench, on_bench),
        frame(0.2, xl_approach, on_bench, on_bench),
        frame(0.35, final[X_LOCK], on_bench, on_bench),
        frame(0.75, final[X_LOCK], approach, on_bench),
        frame(1.0, final[X_LOCK], lambda pid: dict(final[pid]), on_bench),
    ]
    # step 4 (B): the right group bench -> approach -> final
    b0 = steps[STEP_ATTACH_B]["3d_path"][0]["poses"]
    def frame_b(t, right_at):
        out = []
        for p in b0:
            pid = p["part_id"]
            q = right_at(pid) if pid in right else dict(final[pid]) if pid in left or pid == X_LOCK else dict(p)
            q["part_id"] = pid; out.append(q)
        return {"time": t, "poses": out}
    steps[STEP_ATTACH_B]["3d_path"] = [frame_b(0.0, on_bench), frame_b(0.6, approach),
                                       frame_b(1.0, lambda pid: dict(final[pid]))]
    data["description"] = (data.get("description", "") +
        " | X-Lock steps re-recorded by tools/fix_xlock_paths.py: wedge assemblies built on the bench "
        f"({OFFSET_MM:.0f} mm out) and attached to the X-Lock in steps (A) and (B).")
    json.dump(data, open(dst, "w"), indent=1)
    print(f"left group {left}\nright group {right}\nwritten {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
