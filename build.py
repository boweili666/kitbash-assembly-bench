#!/usr/bin/env python3
"""把 index.html + vendor + src 打包成单文件版本。

生成两个产物:
  dist/kitbash-standalone.html  完整单文件(含 doctype,可直接双击打开/分发)
  dist/kitbash-artifact.html    Artifact 发布用(无 doctype/html/head/body 包裹)
"""
import re
import pathlib

root = pathlib.Path(__file__).parent
dist = root / "dist"
dist.mkdir(exist_ok=True)

html = (root / "index.html").read_text(encoding="utf-8")


import os
import shutil
import datetime
import subprocess

def _node_path():
    """Directories where `typescript` may be installed (for the comment stripper)."""
    cands = [os.environ.get("KB_NODE_PATH", ""),
             str(root.parent / "aristos" / "external" / "aristos_frontend" / "node_modules")]
    try:
        cands.append(subprocess.check_output(["npm", "root", "-g"], text=True, stderr=subprocess.DEVNULL).strip())
    except Exception:
        pass
    return os.pathsep.join(c for c in cands if c)

def strip_js_comments(path, content):
    """Our own scripts ship without comments (they are written in Chinese and the
    bundle is what other teams receive). Falls back to the original if the
    TypeScript-based stripper is unavailable."""
    if not path.startswith("src/") or not shutil.which("node"):
        return content
    try:
        out = subprocess.run(["node", str(root / "tools" / "strip_comments.js"), str(root / path)],
                             capture_output=True, text=True, timeout=120,
                             env={**os.environ, "NODE_PATH": _node_path()})
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout
        print(f"warning: comment stripping skipped for {path}: {out.stderr.strip()[:120]}")
    except Exception as e:  # noqa: BLE001
        print(f"warning: comment stripping skipped for {path}: {e}")
    return content

def strip_css_comments(content):
    return re.sub(r"/\*.*?\*/", "", content, flags=re.S)

def inline_script(m):
    content = (root / m.group(1)).read_text(encoding="utf-8")
    content = strip_js_comments(m.group(1), content)
    # 防止库代码中的 "</script>" 提前终止内联脚本
    content = content.replace("</script>", "<\\/script>")
    return "<script>\n" + content + "\n</script>"


def inline_style(m):
    css = strip_css_comments((root / m.group(1)).read_text(encoding="utf-8"))
    return "<style>\n" + css + "\n</style>"


# 版本戳:页面上 KB.build() / 控制台首行都会显示,便于确认跑的是不是最新构建
html = html.replace("window.KB_BUILD = 'dev';",
                    "window.KB_BUILD = '%s';" % datetime.datetime.now().strftime("%Y-%m-%d %H:%M"))

inlined = re.sub(r'<script src="((?:vendor|src)/[^"]+)"></script>', inline_script, html)
inlined = re.sub(r'<link rel="stylesheet" href="(src/[^"]+)">', inline_style, inlined)

# 内嵌零件库(manifest + GLB base64),单文件版本离线可用
import base64
import json

parts_dir = root / "assets" / "parts"
manifest_file = parts_dir / "manifest.json"
if manifest_file.exists():
    embed = {
        "manifest": json.loads(manifest_file.read_text(encoding="utf-8")),
        "files": {
            f.name: base64.b64encode(f.read_bytes()).decode("ascii")
            for f in sorted(parts_dir.glob("*.glb"))
        },
    }
    embed_tag = "<script>window.KB_PARTS_DATA = " + json.dumps(embed) + ";</script>"
else:
    embed_tag = ""
inlined = inlined.replace("<!-- PARTS_EMBED -->", embed_tag)
inlined = re.sub(r"<!--.*?-->\n?", "", inlined, flags=re.S)   # our HTML comments (Chinese) stay out of the bundle

(dist / "kitbash-standalone.html").write_text(inlined, encoding="utf-8")

# Artifact 版:去掉 doctype/html/head/body 包裹,title 与字体链接置顶
body_inner = re.search(r"<body>(.*)</body>", inlined, re.S).group(1)
head_keep = "\n".join(re.findall(
    r'<link rel="preconnect"[^>]*>|<link rel="stylesheet" href="https://fonts[^"]+">', inlined))
style_block = re.search(r"<style>.*?</style>", inlined, re.S).group(0)
artifact = "<title>Kitbash Assembly Bench</title>\n" + head_keep + "\n" + style_block + "\n" + body_inner
(dist / "kitbash-artifact.html").write_text(artifact, encoding="utf-8")

print("standalone:", (dist / "kitbash-standalone.html").stat().st_size, "bytes")
print("artifact:  ", (dist / "kitbash-artifact.html").stat().st_size, "bytes")
