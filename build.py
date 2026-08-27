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


def inline_script(m):
    content = (root / m.group(1)).read_text(encoding="utf-8")
    # 防止库代码中的 "</script>" 提前终止内联脚本
    content = content.replace("</script>", "<\\/script>")
    return "<script>\n" + content + "\n</script>"


def inline_style(m):
    return "<style>\n" + (root / m.group(1)).read_text(encoding="utf-8") + "\n</style>"


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
