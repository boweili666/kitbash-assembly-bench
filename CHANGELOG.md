# Changelog

**Branch:** `wenhel/simulator` on `git@gitlab.com:wenhel-cmu/aristos-dev.git`

## What was taken, and from where

| | |
|---|---|
| Upstream repository | `https://github.com/boweili666/kitbash-assembly-bench.git` (bowei's own) |
| Its head when we took it | **`ca69f1e`** — "Rebuild the bundles", boweili666, 2026-09-25 |
| Taken on | **2026-09-27** |

Upstream history is **not** carried on this branch. The first commit here is
that tree with no parent. To see what came before it, fetch the upstream
repository and look at `ca69f1e`.

## What we changed since

### `44a319f` — a jump on the Steps list tells the host

The bench posted its state to the host only on a `place` event. Seating the
build with the Steps panel moved every part without one, so nothing left the
bench and the tutor still believed the build was where it had been. A jump now
emits `sceneSeated` and the bridge posts the state.

Measured before: 0 `kb:state` after a jump, 1 after an ordinary place.

### `4384c03` — the bench source the demo was built from

Ten tracked files and four new ones (`errshow.js`, `marks.js`, `nametag.js`,
`settings.js`) had never been committed while the live bundle was built from
them. **+938 / -81** against `ca69f1e`, excluding built bundles.

What it contains, by purpose:

| | |
|---|---|
| Host surface | the `kb:*` postMessage bridge, the state report, `state.waiting[]`, issue `kind`/`hostId`/`features` |
| Marks | `marks.js` (533 lines): yellow arrow, green holes, red, and the `kb:marks` receipt |
| On screen | part name tags, error text off by default, camera pulled back instead of pushed into the hole |
| Bench behaviour | tray ordered by step, align warning at level 2, free insert at level 3 |
| Judgement | propellers removed from `SAME` (their two variants' pivots differ by 23.17 mm, so they are not interchangeable poses); `FLIP_MATTERS` rejects a propeller mounted upside down |

### `638e744` — the demo pane, and the README

`mini-simulator/` copied in from the moonshot monorepo without its history
(`mini-simulator/ORIGIN.txt` records the source commit). Its `frameStep()`
occlusion test was changed from full triangle meshes to per-part bounding-box
proxies: the late steps took **1.4-2.7 s** and now take **1-4 ms**, which is
why the step animation used to freeze and skip its motion.

### `8447781` — README ids corrected to this branch's own

## Reproducing the frozen demo

This branch at its tip is what the 2026-09-27 demo (`v1` /
`aitutor.wenhel.com/uav_simulator/`) was built from. The branch
`wenhel/uav_simulator` holds the assembly instructions: which head of each
branch, in what order, and which build commands.
