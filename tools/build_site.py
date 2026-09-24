#!/usr/bin/env python3
"""Build the public static site (GitHub Pages) into a folder.

    python3 tools/build_site.py OUT_DIR

  index.html  cover + difficulty picker (site/index.template.html, with the
              level animations taken from src/help.js so both stay identical)
  sim.html    the simulator (dist/kitbash-standalone.html)
  intro.html  the exploded-drone background (dist/drone-intro.html)

Run build.py and tools/build_drone_intro.py first; tools/deploy_pages.sh does all of it.
"""
import pathlib, shutil, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]


def main(out):
    out = pathlib.Path(out)
    out.mkdir(parents=True, exist_ok=True)
    help_js = (ROOT / 'src/help.js').read_text()
    start = help_js.index("  var HOLE = '#ff2d95'")
    end = help_js.index('  /* ---------- 真实零件的小动画')
    page = (ROOT / 'site/index.template.html').read_text().replace('__ANIM__', help_js[start:end])
    (out / 'index.html').write_text(page)
    shutil.copyfile(ROOT / 'dist/kitbash-standalone.html', out / 'sim.html')
    shutil.copyfile(ROOT / 'dist/drone-intro.html', out / 'intro.html')
    (out / '.nojekyll').write_text('')
    print('site ->', out, sorted(p.name for p in out.iterdir()))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else ROOT / '_site')
