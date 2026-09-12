# Kitbash × ARISTOS (gin-dev) integration — parked

Working-tree changes that were applied on top of aristos_frontend `gin-dev`
(`72cc057`) and then reverted on 2026-09-11 at the user's request, so the
frontend stays a pristine gin-dev checkout.

- `TraineeCam.tsx` — Real / Sim source toggle, Live / Edit sim views,
  Expand-to-overlay, Pop out; pulls frames from monitor.py `/frame.jpg` at
  10 fps and emits them on the existing `session-video-frame` socket event.
  `?sim=edit` / `?sim=live` URL shortcut.
- `ProtectedRoute.tsx` + `env.local.example` — dev-only login bypass
  (`VITE_DEMO_NO_AUTH=1`), needed only while the backend predates `user-login`.
- `traineecam_integration.patch` — the whole diff; re-apply with
  `git apply traineecam_integration.patch` inside aristos_frontend.
