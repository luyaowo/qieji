#!/usr/bin/env python3
"""Wrap the checked ZIP in a read-only drag-to-install DMG, without installing."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
info = plistlib.loads((root / 'Packaging/Info.plist').read_bytes())
stem = f"且记-Mac-{info['CFBundleShortVersionString']}-构建{info['CFBundleVersion']}-Apple芯片"
archive = root / 'dist' / (stem + '.zip')
source_record = archive.with_suffix('.json')
output = archive.with_suffix('.dmg')
record = output.with_suffix('.dmg.json')
checksum = output.with_suffix('.dmg.sha256')
for destination in (output, record, checksum):
    if destination.exists():
        raise SystemExit('已有同版本交付文件，未覆盖：' + str(destination))
if not archive.is_file() or not source_record.is_file():
    raise SystemExit('请先运行 python3 Scripts/package-mac.py 生成并验证 ZIP。')
source = json.loads(source_record.read_text())
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
if sha(archive) != source.get('sha256') or not source.get('checksPassed') or not source.get('extractedPackageSmokePassed'):
    raise SystemExit('来源 ZIP 校验失败，未生成 DMG。')
for relative, expected in source.get('sourceSHA256', {}).items():
    path = root / relative
    if not path.is_file() or sha(path) != expected:
        raise SystemExit('源码已变化，请重新生成 ZIP：' + relative)

def run(*args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        raise SystemExit(result.stderr.decode(errors='replace') + result.stdout.decode(errors='replace'))
    return result.stdout

def tree(path):
    result = {}
    for item in sorted(path.rglob('*')):
        key = str(item.relative_to(path))
        if item.is_symlink():
            result[key] = {'symlink': os.readlink(item)}
        elif item.is_file():
            result[key] = {'sha256': sha(item), 'mode': item.stat().st_mode & 0o777}
    return result

with tempfile.TemporaryDirectory(prefix='qieji-dmg-', dir='/private/tmp') as work:
    work = Path(work)
    stage = work / 'stage'
    stage.mkdir()
    run('ditto', '-x', '-k', str(archive), str(stage))
    app = stage / '且记.app'
    if plistlib.loads((app / 'Contents/Info.plist').read_bytes()) != info:
        raise SystemExit('来源应用与仓库版本信息不一致。')
    run('codesign', '--verify', '--deep', '--strict', str(app))
    app_tree = tree(app)
    (stage / 'Applications').symlink_to('/Applications', target_is_directory=True)
    temporary_image = work / (stem + '.dmg')
    print('Creating read-only DMG…', flush=True)
    run('hdiutil', 'create', '-volname', '且记 · 拖入应用程序', '-srcfolder', str(stage), '-fs', 'HFS+', '-format', 'UDZO', '-ov', str(temporary_image))
    run('hdiutil', 'verify', str(temporary_image))
    mount = work / 'mounted'
    mount.mkdir()
    attached = False
    try:
        run('hdiutil', 'attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', str(mount), str(temporary_image))
        attached = True
        if not (mount / 'Applications').is_symlink() or os.readlink(mount / 'Applications') != '/Applications':
            raise SystemExit('DMG 中的应用程序入口不正确。')
        if tree(mount / '且记.app') != app_tree:
            raise SystemExit('DMG 内应用与来源 ZIP 不一致。')
        run('codesign', '--verify', '--deep', '--strict', str(mount / '且记.app'))
        copied = work / 'copy-check' / '且记.app'
        copied.parent.mkdir()
        run('ditto', str(mount / '且记.app'), str(copied))
        if tree(copied) != app_tree:
            raise SystemExit('复制后的应用与 DMG 内应用不一致。')
        run('codesign', '--verify', '--deep', '--strict', str(copied))
        smoke = run(str(copied / 'Contents/MacOS' / info['CFBundleExecutable']), '--verify-package').decode()
        print(smoke.strip(), flush=True)
    finally:
        if attached:
            run('hdiutil', 'detach', str(mount))
    image_hash = sha(temporary_image)
    metadata = {
        'version': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion'],
        'bundleIdentifier': info['CFBundleIdentifier'], 'architecture': source['architecture'],
        'minimumMacOS': info['LSMinimumSystemVersion'], 'signing': 'ad-hoc', 'notarized': False,
        'sourceCommit': source['sourceCommit'], 'sourceDirty': source['sourceDirty'],
        'sourceZIP': archive.name, 'sourceZIPSHA256': source['sha256'],
        'archive': output.name, 'sha256': image_hash,
        'imageVerified': True, 'mountedAppMatchesZIP': True, 'applicationShortcutVerified': True,
        'copiedAppMatchesZIP': True, 'copiedAppSignatureVerified': True, 'copiedAppSmokePassed': True,
        'installed': False, 'downloadFirstLaunchVerified': False,
    }
    # Exclusive creation prevents accidentally replacing an earlier delivery.
    created = []
    try:
        with output.open('xb') as stream:
            created.append(output)
            with temporary_image.open('rb') as image:
                shutil.copyfileobj(image, stream)
        with record.open('x') as stream:
            created.append(record)
            json.dump(metadata, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        with checksum.open('x') as stream:
            created.append(checksum)
            stream.write(image_hash + '  ' + output.name + '\n')
    except Exception:
        for path in created:
            path.unlink(missing_ok=True)
        raise
print('PASS: DMG image, drag-copy integrity, signature and isolated package startup.')
print(output)
