# The assembly bench — our branch

## Where this code came from

Upstream: **https://github.com/boweili666/kitbash-assembly-bench.git**
(bowei's own repository; 64 of the commits in this history are his.)

| | |
|---|---|
| Last commit that is his | **`ca69f1e`** — "Rebuild the bundles", boweili666, 2026-09-25 |
| First commit that is ours | **`eae559c`** — "Steps list: a jump changes the build, so the host is told" |

His history is **not** carried on this branch. The first commit here is his
tree at `ca69f1e` with no parent; fetch his repository at that id if you ever
need what came before. Everything after it is ours, with its own history.

## What we changed

Measured against `ca69f1e`: **10 tracked files changed, 4 new, +938 / -81**,
excluding built bundles. The largest new file is `src/marks.js` (533 lines),
the three-colour marking machine, which has no counterpart upstream.

Almost all of it exists so that something *outside* the bench can watch it and
point at things in it:

- the `kb:*` postMessage bridge, and the state report it sends
- three marks (yellow arrow / green holes / red) and the `kb:marks` receipt
- the step list, and a jump that reports its new state (`sceneSeated`)
- part name tags, error text off by default, camera no longer flying into holes
- judgement fixes: propeller variants are no longer interchangeable poses, and
  a flipped propeller is rejected

## The demo pane

`mini-simulator/` is the stripped second build that plays one step beside the
chat. It was developed in a different repository (the `moonshot` monorepo, at
`wenhel-dev-patchs/feature-mini-simulator/`) and the files were copied here;
its history did not come with them. Source commit is recorded in
`mini-simulator/ORIGIN.txt`.

It is a separate build on purpose: the trainee's bench keeps its toolbar,
guide, play bar and arrows, and the demo must show none of them.

## Building

```bash
KB_NODE_PATH=<a checkout of aristos_frontend>/node_modules python build.py
```

`KB_NODE_PATH` is not optional -- without it the comment stripping is silently
skipped and the bundle differs.

## Where this branch lives

Pushed to **git@gitlab.com:wenhel-cmu/aristos-dev.git**, which is where all of our work on this system now
lives. Four branches share that repository, one per upstream project. They have
no common ancestor with each other -- that is expected: one repository is being
used as one place to find everything, not as one project.

| Branch | What |
|---|---|
| `wenhel/simulator` | the 3D assembly bench, plus the demo pane |
| `wenhel/gin-dev` | the ARISTOS backend (the AI tutor) |
| `wenhel/aristos_frontend` | the React web app |
| `wenhel/workflow` | the task-graph server |
| `wenhel/dev-nginx` | the host's URL table, for the record |

**Development happens here from now on. Nothing is pushed back upstream.**
