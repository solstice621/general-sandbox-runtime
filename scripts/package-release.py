#!/usr/bin/env python3
"""Package source, compiled runtime and npm artifacts as a portable ZIP."""
import json
import os
import zipfile
from pathlib import Path

root=Path(__file__).resolve().parents[1]
version=json.loads((root/'package.json').read_text())['version']
archive=root.parent/f'sandbox-runtime-{version}.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as output:
    for folder,dirs,names in os.walk(root):
        dirs[:]=sorted(name for name in dirs if name not in {'node_modules','.git','__pycache__','work','test-results'})
        for name in sorted(names):
            path=Path(folder)/name
            if path.suffix!='.pyc' and name!='.DS_Store':
                output.write(path,'sandbox-runtime/'+str(path.relative_to(root)))
print(archive)
