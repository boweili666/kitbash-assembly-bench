"""把整机装配演示打成一个自带数据的 HTML —— 双击就能看,不依赖仿真台和服务器。

数据和仿真台同源:零件库 manifest 的 parts(网格 + offset)和 answer(44 步轨迹)。
用法:
    python3 tools/build_assembly_show.py
    # -> dist/assembly-show.html
"""
import base64, json, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
PARTS = ROOT / 'assets' / 'parts'

manifest = json.loads((PARTS / 'manifest.json').read_text())
keys = {p['key'] for p in manifest['answer']['parts']}
parts = [p for p in manifest['parts'] if p['key'] in keys]
data = {
    'unitScale': manifest['unitScale'],
    'answer': manifest['answer'],
    'parts': parts,
    'files': {p['file']: base64.b64encode((PARTS / p['file']).read_bytes()).decode() for p in parts},
}

html = (ROOT / 'show' / 'assembly-show.html').read_text()
pieces = {
    'SHOW_CSS': (ROOT / 'show' / 'assembly-show.css').read_text(),
    'SHOW_JS': (ROOT / 'show' / 'assembly-show.js').read_text(),
    'THREE_VENDOR': (ROOT / 'vendor' / 'three.min.js').read_text(),
    'GLTF_VENDOR': (ROOT / 'vendor' / 'GLTFLoader.js').read_text(),
    'SHOW_DATA': 'window.SHOW_DATA=' + json.dumps(data, separators=(',', ':')) + ';',
}
for mark, value in pieces.items():
    html = html.replace('/* ' + mark + ' */', value.replace('</script', '<\\/script'))

(ROOT / 'dist').mkdir(exist_ok=True)
out = ROOT / 'dist' / 'assembly-show.html'
out.write_text(html)
derived = sum(1 for s in manifest['answer']['steps'] if s.get('derived'))
print(f"assembly show: {len(html):,} bytes | {len(manifest['answer']['steps'])} 步"
      f"(采集 {len(manifest['answer']['steps']) - derived} + 推导 {derived})"
      f" | {len(manifest['answer']['parts'])} 件 | {len(parts)} 种零件 -> {out.relative_to(ROOT)}")
