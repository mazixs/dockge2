"""Export the existing, published Sites client without the presentation frame."""
from pathlib import Path
import argparse, hashlib, json, shutil, subprocess
parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
args = parser.parse_args()
out = Path(__file__).resolve().parent
src = args.source.resolve()
commit = subprocess.check_output(['git','rev-parse','HEAD'], cwd=src, text=True).strip()
expected = '7bce7fcfa312f93583fcfe57c7d247af679c43d4'
if commit != expected:
    raise SystemExit('Source differs from verified Sites version 1')
client = src / 'dist/client'
for folder in ['_next','fonts']:
    shutil.copytree(client/folder, out/folder, dirs_exist_ok=True)
shutil.copy2(client/'favicon.svg', out/'favicon.svg')
html = (client/'index.html').read_text()
html = html.replace('</head>', '<link rel="stylesheet" href="./standalone.css"></head>')
html = html.replace('</body>', '<script src="./navigation.js"></script></body>')
html = html.replace('Dockge2 · Три направления', 'Dockge2 · Локальный эталон Sites 01 · Демонстрация')
(out/'index.html').write_text(html)
manifest = {'source_url':'https://dockge2-design-directions.xizam.chatgpt.site/', 'version':1, 'commit':commit,'exported':'2026-09-13','direction':'01 Знакомый Dockge','changes':['Presentation chooser and footer hidden','Outer frame removed','Query navigation for review only'],'files':{}}
for p in sorted(client.rglob('*')):
    if p.is_file() and (p.parts[-2]=='fonts' or '_next' in p.parts or p.name=='index.html'):
        manifest['files'][str(p.relative_to(client))]=hashlib.sha256(p.read_bytes()).hexdigest()
(out/'provenance.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
(out/'source.css').write_text((src/'app/globals.css').read_text())
print('Exported Sites version 1:',commit)
