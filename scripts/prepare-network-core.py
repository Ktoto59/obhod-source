#!/usr/bin/env python3
"""Prepare the pinned experimental sing-box sources and record all inputs."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
PIN = json.loads((ROOT / 'core/upstream.json').read_text(encoding='utf-8'))


def prepare(checkouts, destination):
    # Validate every source before creating output. Archive committed blobs,
    # independently of the checkout's worktree and any prior builds.
    for project, revision in PIN['upstream'].items():
        actual = subprocess.check_output(
            ['git', '-C', checkouts[project], 'rev-parse', 'HEAD'], text=True,
        ).strip()
        if actual != revision:
            raise ValueError(f'{project}: expected {revision}, found {actual}')
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {**PIN, 'patches': {}, 'overlay': {}}
    for project, checkout in checkouts.items():
        target = destination / ('source' if project == 'sing-box' else project)
        target.mkdir()
        committed = subprocess.check_output(['git', '-C', checkout, 'archive', 'HEAD'])
        with tarfile.open(fileobj=io.BytesIO(committed)) as archive:
            archive.extractall(target, filter='data')
        patch = ROOT / 'core/patches' / f'{project}.patch'
        if patch.is_file():
            patch_bytes = patch.read_bytes()
            subprocess.run(
                ['git', 'apply', '--whitespace=error', '-'], cwd=target,
                input=patch_bytes, check=True,
            )
            manifest['patches'][patch.name] = hashlib.sha256(patch_bytes).hexdigest()
        overlay = ROOT / 'core/overlay' / project
        if overlay.is_dir():
            for file in sorted(path for path in overlay.rglob('*') if path.is_file()):
                relative = file.relative_to(overlay)
                output = target / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                if output.exists():
                    raise ValueError(f'Overlay collides with upstream: {project}/{relative}')
                shutil.copyfile(file, output)
                manifest['overlay'][f'{project}/{relative.as_posix()}'] = hashlib.sha256(file.read_bytes()).hexdigest()
    (destination / 'build-manifest.json').write_text(
        json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n',
    )
    print(f"Prepared {PIN['version']} in {destination}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for project in PIN['upstream']:
        parser.add_argument('--' + project, type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    prepare({project: getattr(args, project.replace('-', '_')).resolve()
             for project in PIN['upstream']}, args.output.resolve())
