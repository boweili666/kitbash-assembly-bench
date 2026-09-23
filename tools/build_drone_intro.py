"""Build the isolated welcome animation. No simulator runtime or screenshot pipeline."""
import argparse, base64, json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,default=root);args=p.parse_args()
source=args.source
manifest=json.loads((source/'assets/parts/manifest.json').read_text())
keys={p['key'] for p in manifest['answer']['parts']}|{'top_plate','propeller_cw','propeller_ccw'}
parts=[p for p in manifest['parts'] if p['key'] in keys]
data={'unitScale':manifest['unitScale'],'answer':manifest['answer'],'parts':parts,'files':{p['file']:base64.b64encode((source/'assets/parts'/p['file']).read_bytes()).decode() for p in parts}}
html=(root/'intro/drone-intro.html').read_text()
for mark,value in {'INTRO_CSS':(root/'intro/drone-intro.css').read_text(),'INTRO_JS':(root/'intro/drone-intro.js').read_text(),'THREE_VENDOR':(source/'vendor/three.min.js').read_text(),'GLTF_VENDOR':(source/'vendor/GLTFLoader.js').read_text(),'INTRO_DATA':'window.DRONE_INTRO_DATA='+json.dumps(data,separators=(',',':'))+';'}.items():html=html.replace('/* '+mark+' */',value.replace('</script','<\\/script'))
(root/'dist').mkdir(exist_ok=True)
(root/'dist/drone-intro.html').write_text(html)
print('Drone intro:',len(html),'bytes;',len(manifest['answer']['parts'])+5,'part instances')
