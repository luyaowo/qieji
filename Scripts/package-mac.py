#!/usr/bin/env python3
"""Check, build, sign, archive, extract and smoke-test the Apple Silicon Mac app.

Produces a local ad-hoc test package; never installs, notarizes, or overwrites a
previous artifact. Version and build come only from Packaging/Info.plist.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile

root = Path(__file__).resolve().parent.parent
if platform.system() != "Darwin" or platform.machine() != "arm64":
    raise SystemExit("打包需要 Apple 芯片 Mac。")
if int(platform.mac_ver()[0].split(".")[0]) < 14 or sys.version_info < (3, 9):
    raise SystemExit("打包需要 macOS 14 及以上、Python 3.9 及以上。")
required = ["node", "swift", "python3", "git", "xcrun", "codesign", "lipo", "ditto"]
missing = [command for command in required if shutil.which(command) is None]
if missing:
    raise SystemExit("缺少打包工具：" + ", ".join(missing) + "；请按 README 准备构建环境。")
repository = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=root, text=True, capture_output=True)
if repository.returncode or Path(repository.stdout.strip()).resolve() != root:
    raise SystemExit("打包需要项目自身的 Git 仓库。请通过 Git 克隆仓库后运行；源码 ZIP 不含 Git 历史。")
node_version = subprocess.check_output(["node", "--version"], text=True).strip()
swift_version = subprocess.check_output(["swift", "--version"], text=True)
swift_major = re.search(r"Swift version (\d+)", swift_version)
if int(node_version.lstrip("v").split(".")[0]) < 18 or not swift_major or int(swift_major[1]) < 6:
    raise SystemExit("打包需要 Node.js 18 及以上、支持 Swift 6 的命令行工具。")

output = Path(tempfile.mkdtemp(prefix="qieji-package-", dir="/private/tmp"))
environment = os.environ.copy()
environment["CLANG_MODULE_CACHE_PATH"] = str(output / "module-cache")
environment["SWIFTPM_MODULECACHE_OVERRIDE"] = str(output / "module-cache")
environment["COPYFILE_DISABLE"] = "1"
info = plistlib.loads((root / "Packaging/Info.plist").read_bytes())
version, build = info["CFBundleShortVersionString"], info["CFBundleVersion"]
filename = f"且记-Mac-{version}-构建{build}-Apple芯片.zip"
destination = root / "dist" / filename
metadata_path = destination.with_suffix(".json")
checksum_path = destination.with_suffix(".zip.sha256")
for path in [destination, metadata_path, checksum_path]:
    if path.exists():
        raise SystemExit("已有同版本交付文件，未覆盖：" + str(path))

def run(name, command):
    print(name + "…", flush=True)
    log = output / (name + ".log")
    with log.open("w") as stream:
        result = subprocess.run(command, cwd=root, env=environment, stdout=stream, stderr=subprocess.STDOUT)
    if result.returncode:
        print("\n".join(log.read_text().splitlines()[-70:]), flush=True)
        raise SystemExit("FAIL: " + name + "; log: " + str(log))
    print("PASS: " + name, flush=True)

print("Package logs:", output, flush=True)
run("generate-frontend", ["node", "Scripts/build-frontend.cjs"])
run("checks", ["python3", "Scripts/check.py"])
scratch = output / "build"
run("release", ["swift", "build", "-c", "release", "--arch", "arm64", "--scratch-path", str(scratch)])
binary_directory = Path(subprocess.check_output(
    ["swift", "build", "-c", "release", "--arch", "arm64", "--scratch-path", str(scratch), "--show-bin-path"],
    cwd=root, env=environment, text=True).strip().splitlines()[-1])
binary = binary_directory / "PaperEdgeApp"
bundle = binary_directory / "PaperEdge_PaperEdgeApp.bundle"
if not binary.is_file() or not bundle.is_dir():
    raise SystemExit("构建产物不完整：" + str(binary_directory))

app = output / "且记.app"
contents = app / "Contents"
(contents / "MacOS").mkdir(parents=True)
(contents / "Resources").mkdir()
shutil.copy2(binary, contents / "MacOS" / info["CFBundleExecutable"])
shutil.copy2(root / "Packaging/Info.plist", contents / "Info.plist")
shutil.copy2(root / "Packaging/QieJi.icns", contents / "Resources/QieJi.icns")
shutil.copy2(root / "Packaging/使用说明.md", contents / "Resources/使用说明.md")
shutil.copytree(bundle, contents / "Resources/PaperEdge_PaperEdgeApp.bundle")
run("sign", ["codesign", "--force", "--sign", "-", str(app)])
run("verify-signature", ["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)])
architecture = subprocess.check_output(["lipo", "-archs", str(contents / "MacOS" / info["CFBundleExecutable"])], text=True).strip()
if architecture != "arm64":
    raise SystemExit("芯片架构不符合预期：" + architecture)

archive = output / filename
run("archive", ["ditto", "-c", "-k", "--norsrc", "--noextattr", "--noacl", "--keepParent", str(app), str(archive)])
with zipfile.ZipFile(archive) as zipped:
    names = zipped.namelist()
    if zipped.testzip() is not None or any("__MACOSX" in name.split("/") or Path(name).name.startswith("._") or Path(name).name == ".DS_Store" for name in names):
        raise SystemExit("压缩包完整性或元数据检查失败")
extracted = output / "extracted"
extracted.mkdir()
run("extract", ["ditto", "-x", "-k", str(archive), str(extracted)])
extracted_app = extracted / "且记.app"
# ditto writes UTF-8 names without ZIP's UTF-8 flag. Python 3.9 decodes those
# names as CP437; validate the real system-extracted path instead of guessing it.
packaged_info = plistlib.loads((extracted_app / "Contents/Info.plist").read_bytes())
if packaged_info != info:
    raise SystemExit("安装包版本信息不一致")
run("verify-extracted-signature", ["codesign", "--verify", "--deep", "--strict", str(extracted_app)])
run("package-smoke", [str(extracted_app / "Contents/MacOS" / info["CFBundleExecutable"]), "--verify-package"])

source_hashes = {}
for folder in ["Frontend", "Sources", "Scripts", "Tests", "Packaging"]:
    for path in sorted((root / folder).rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.name != ".DS_Store":
            source_hashes[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
source_hashes["Package.swift"] = hashlib.sha256((root / "Package.swift").read_bytes()).hexdigest()
revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, text=True, capture_output=True).stdout.strip()
if len(revision) != 40 or any(char not in "0123456789abcdef" for char in revision):
    revision = "uncommitted"
dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip())
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
metadata = {"version": version, "build": build, "architecture": architecture, "minimumMacOS": info["LSMinimumSystemVersion"],
    "signing": "ad-hoc", "notarized": False, "installed": False, "notificationVisibilityVerified": False,
    "sourceCommit": revision, "sourceDirty": dirty, "sourceSHA256": source_hashes,
    "archive": filename, "sha256": checksum, "checksPassed": True, "extractedPackageSmokePassed": True,
    "logs": str(output)}
destination.parent.mkdir(exist_ok=True)
# Reserve the delivery record before publishing the archive; a failed publish
# removes it so an archive is never left without its metadata and checksum.
created = []
try:
    with metadata_path.open("x") as stream: json.dump(metadata, stream, ensure_ascii=False, indent=2)
    created.append(metadata_path)
    with checksum_path.open("x") as stream: stream.write(checksum + "  " + filename + "\n")
    created.append(checksum_path)
except BaseException:
    for path in created:
        path.unlink(missing_ok=True)
    raise
# Publish only after verification, and refuse an existing archive even if a
# second packaging process finished while this one was building.
partial = destination.parent / (filename + ".partial-" + uuid.uuid4().hex)
try:
    shutil.copyfile(archive, partial)
    if destination.exists():
        raise SystemExit("已有同版本交付文件，未覆盖：" + str(destination))
    os.replace(partial, destination)
except BaseException:
    metadata_path.unlink(missing_ok=True)
    checksum_path.unlink(missing_ok=True)
    raise
finally:
    if partial.exists(): partial.unlink()
print("Package:", destination)
print("SHA-256:", checksum)
print("Local ad-hoc package only. Installed app and real task data were not changed.")
