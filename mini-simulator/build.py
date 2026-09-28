#!/usr/bin/env python3
"""把 index.html + vendor + src 打包成 dist/mini-simulator.html(单文件)。

派生自 bowei 台子的 build.py(ca69f1e), 差别:
  - 只产出一个文件(没有 Artifact 版)
  - vendor / assets 不在本目录, 从 BENCH(handle-callbacks)按引用读
  - 只内联 three / OrbitControls / GLTFLoader(没有 TransformControls /
    GLTFExporter:mini 不变换也不导出)
  - src/ 的中文注释剥离后再内联(和主台子同一个 tools/strip_comments.js);
    产物是要交给别人的, 注释留在源码里

剥离器需要 node + typescript。不在就**直接报错**, 不静默跳过 —— 静默跳过
会把中文注释发出去, 而且看日志以为剥了。指一个装了 typescript 的目录:

    KB_NODE_PATH=<...>/aristos_frontend/node_modules python build.py
"""
import base64
import datetime
import json
import os
import pathlib
import re
import shutil
import subprocess

root = pathlib.Path(__file__).parent
BENCH = (root.parent / "feature-simulator-bowei" / "handle-callbacks").resolve()
dist = root / "dist"
dist.mkdir(exist_ok=True)

if not BENCH.exists():
    raise SystemExit(f"bench not found at {BENCH}")

html = (root / "index.html").read_text(encoding="utf-8")


def read(rel: str) -> str:
    """src/ 在本目录, vendor/ 在 bench 那边。"""
    local = root / rel
    path = local if local.exists() else BENCH / rel
    return path.read_text(encoding="utf-8")


def _node_path() -> str:
    """typescript 可能装在哪儿(给注释剥离器用)。"""
    cands = [os.environ.get("KB_NODE_PATH", ""),
             str(BENCH.parents[2] / "gin-dev-latest" / "external" / "aristos_frontend" / "node_modules")]
    try:
        cands.append(subprocess.check_output(["npm", "root", "-g"], text=True,
                                             stderr=subprocess.DEVNULL).strip())
    except Exception:
        pass
    return os.pathsep.join(c for c in cands if c)


def strip_js_comments(rel: str, content: str) -> str:
    """只剥 src/ 下我们自己写的脚本, vendor 原样内联。失败就抛, 不退回原文。"""
    if not rel.startswith("src/"):
        return content
    if not shutil.which("node"):
        raise SystemExit("comment stripping needs `node` on PATH; refusing to ship comments")
    out = subprocess.run(["node", str(BENCH / "tools" / "strip_comments.js"), str(root / rel)],
                         capture_output=True, text=True, timeout=120,
                         env={**os.environ, "NODE_PATH": _node_path()})
    if out.returncode != 0 or not out.stdout.strip():
        raise SystemExit(f"comment stripping failed for {rel}: {out.stderr.strip()[:300]}\n"
                         f"set KB_NODE_PATH to a node_modules that has typescript")
    return out.stdout


def inline_script(m):
    rel = m.group(1)
    content = strip_js_comments(rel, read(rel))
    content = content.replace("</script>", "<\\/script>")
    return "<script>\n" + content + "\n</script>"


def inline_style(m):
    css = re.sub(r"/\*.*?\*/", "", read(m.group(1)), flags=re.S)
    return "<style>\n" + css + "\n</style>"


html = html.replace("window.KB_BUILD = 'dev';",
                    "window.KB_BUILD = 'mini %s';" % datetime.datetime.now().strftime("%Y-%m-%d %H:%M"))

inlined = re.sub(r'<script src="((?:vendor|src)/[^"]+)"></script>', inline_script, html)
inlined = re.sub(r'<link rel="stylesheet" href="(src/[^"]+)">', inline_style, inlined)

# 零件库:manifest(含 kit 与 answer)+ GLB base64, 单文件离线可用
parts_dir = BENCH / "assets" / "parts"
manifest_file = parts_dir / "manifest.json"
if not manifest_file.exists():
    raise SystemExit(f"no parts manifest at {manifest_file}")
manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
embed = {
    "manifest": manifest,
    "files": {f.name: base64.b64encode(f.read_bytes()).decode("ascii")
              for f in sorted(parts_dir.glob("*.glb"))},
}
inlined = inlined.replace("<!-- PARTS_EMBED -->",
                          "<script>window.KB_PARTS_DATA = " + json.dumps(embed) + ";</script>")

out = dist / "mini-simulator.html"
out.write_text(inlined, encoding="utf-8")

answer = manifest.get("answer") or {}
print(f"bench:  {BENCH}")
print(f"parts:  {len(manifest['parts'])} types · kit {len(manifest.get('kit') or [])} · "
      f"answer {len(answer.get('steps') or [])} steps / {len(answer.get('parts') or [])} parts")
print(f"output: {out}  ({out.stat().st_size // 1024 // 1024} MB)")
