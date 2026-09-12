// Real part-instance UUIDs and installed poses from the aristos assembly graph
// (Frame+ESC+Motors+FC, step_3d_paths.json). mm, Y up, XYZ Euler radians.
import type { ScenePart } from "../../Simulator";

const scene: ScenePart[] = [
  {
    "id": "b4de5507-d10b-4784-bfa2-672125e804d6",
    "name": "Split Rear Plate",
    "glb": "/assembly_graph_assets/3afd0f37-d270-4c5b-8327-e8192f4a7b4f.glb",
    "pose": {
      "x": 0.0,
      "y": 0.0,
      "z": 0.0,
      "roll": -0.0,
      "pitch": 0.0,
      "yaw": -0.0
    }
  },
  {
    "id": "33ee88b1-9980-4e0b-ade6-1052789ff327",
    "name": "Aluminum X-Lock",
    "glb": "/assembly_graph_assets/61b9b0c7-2626-474d-af91-1e9b38c0d570.glb",
    "pose": {
      "x": 0.0,
      "y": 2.0,
      "z": 0.0,
      "roll": -0.0,
      "pitch": 0.0,
      "yaw": -0.0
    }
  },
  {
    "id": "acb493f9-45c0-469c-a7ad-8a0bd429ab00",
    "name": "Split Front Plate",
    "glb": "/assembly_graph_assets/6e6d8d23-fdf0-440a-b675-942ffcb9c776.glb",
    "pose": {
      "x": 0.0,
      "y": 7.0,
      "z": 0.0,
      "roll": -0.0,
      "pitch": 0.0,
      "yaw": -0.0
    }
  },
  {
    "id": "04e26746-c21e-4738-96cf-8bf2b1d7aa38",
    "name": "5-inch Arm #4",
    "glb": "/assembly_graph_assets/241d88c2-e829-4e9f-8c79-fa44329035d6.glb",
    "pose": {
      "x": -90.667,
      "y": 7.0,
      "z": 65.907,
      "roll": -0.0,
      "pitch": -0.96,
      "yaw": 3.142
    }
  },
  {
    "id": "5608b061-50d6-40cb-9b06-fae565a0ede8",
    "name": "5-inch Arm #3",
    "glb": "/assembly_graph_assets/241d88c2-e829-4e9f-8c79-fa44329035d6.glb",
    "pose": {
      "x": -85.373,
      "y": 2.0,
      "z": -72.448,
      "roll": -3.142,
      "pitch": -0.873,
      "yaw": -3.142
    }
  },
  {
    "id": "f521bee8-6351-43c9-aebd-a883d7d0e991",
    "name": "5-inch Arm #2",
    "glb": "/assembly_graph_assets/241d88c2-e829-4e9f-8c79-fa44329035d6.glb",
    "pose": {
      "x": 91.071,
      "y": 6.766,
      "z": -66.188,
      "roll": -3.142,
      "pitch": 0.96,
      "yaw": -0.0
    }
  },
  {
    "id": "5862866f-f049-40fb-94a9-6d3b25d45e9d",
    "name": "5-inch Arm #1",
    "glb": "/assembly_graph_assets/241d88c2-e829-4e9f-8c79-fa44329035d6.glb",
    "pose": {
      "x": 91.071,
      "y": 2.0,
      "z": 65.754,
      "roll": -0.0,
      "pitch": 0.96,
      "yaw": -0.0
    }
  },
  {
    "id": "b4d32b6d-3c56-45c4-9c94-673a5c12273f",
    "name": "Motor #1",
    "glb": "/assembly_graph_assets/fdc19e95-c2d3-4fb7-a51b-fd3babcfba21.glb",
    "pose": {
      "x": 91.0,
      "y": 2.5,
      "z": 65.75,
      "roll": 1.571,
      "pitch": -0.0,
      "yaw": -0.96
    }
  },
  {
    "id": "92cf9ccb-73e0-4204-a6e7-eef13c3c8260",
    "name": "Left Arm Wedge",
    "glb": "/assembly_graph_assets/3989ee7c-49b0-4a91-93fa-8b5faf6ce43c.glb",
    "pose": {
      "x": -21.359,
      "y": 4.5,
      "z": 0.0,
      "roll": 0.0,
      "pitch": -1.571,
      "yaw": 0.0
    }
  },
  {
    "id": "52e5ae62-8d7f-4975-95fd-28611d677d39",
    "name": "Center X-Lock Screw",
    "glb": "/assembly_graph_assets/c85bff8b-b730-495b-9a19-01150ca168a2.glb",
    "pose": {
      "x": 0.0,
      "y": 8.0,
      "z": 0.0,
      "roll": -0.0,
      "pitch": 0.0,
      "yaw": -0.0
    }
  }
];

export default scene;
