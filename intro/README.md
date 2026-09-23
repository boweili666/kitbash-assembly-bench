# ARISTOS welcome animation

An isolated decorative Three.js scene using the kit's real GLB geometry. It runs only on the first-time / experienced-user welcome screen. It does not run assembly checks, emit simulator events, or capture frames.

Build from the simulator repository:

```sh
python3 tools/build_drone_intro.py
cp dist/drone-intro.html ../aristos/external/aristos_frontend/public/simulator/drone-intro.html
```

The animation uses the manifest answer poses. Since tools/derive_final_assembly.py added propellers, the top plate, camera plates and their screws to that answer, the scene now uses the real poses for all of them; the decorative fallback mounts only run if the answer still lacks propellers or a top plate. A 15-second loop opens the assembly in layers, reassembles it with staggered easing, and follows a closed camera orbit. Materials and geometry are reused across repeated parts.

The host component `DroneWelcome.tsx` resolves this asset beside `SIMULATOR_URL`. It pauses offscreen, in a hidden tab, on user request, and with reduced-motion preferences. Entering either tutorial or assembly unmounts the scene and releases its GPU resources. Unsupported WebGL leaves a readable gradient background and functional entry buttons.
