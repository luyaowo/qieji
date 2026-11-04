#!/usr/bin/env python3
"""Check the independent Windows project with temporary synthetic data only."""
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--native-smoke", action="store_true", help="Open the debug app and exercise the actual native bridge with synthetic data.")
args = parser.parse_args()
output = Path(tempfile.mkdtemp(prefix="qieji-windows-check-"))
env = os.environ.copy()
env["TAURI_CONFIG"] = (root / "src-tauri/tauri.dev.conf.json").read_text()

def run(name, command, timeout=600):
    log = output / (name + ".log")
    print("Checking " + name + "…", flush=True)
    with log.open("w") as stream:
        result = subprocess.run(command, cwd=root, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        print("\n".join(log.read_text().splitlines()[-60:]), flush=True)
        raise SystemExit("FAIL: " + name + "; log: " + str(log))
    print("PASS: " + name, flush=True)
    return log

print("Check logs:", output, flush=True)
run("frontend", ["node", "Scripts/build-frontend.cjs", "--check"])
run("javascript", ["node", "--test"] + [str(p.relative_to(root)) for p in sorted((root / "Scripts").glob("*.test.cjs"))] + ["Scripts/test-reminder-time.cjs"])
run("native-store", ["cargo", "test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib"])
if args.native_smoke:
    run("native-build", ["cargo", "build", "--locked", "--manifest-path", "src-tauri/Cargo.toml"])
    binary = root / "src-tauri/target/debug" / ("qieji-windows.exe" if platform.system() == "Windows" else "qieji-windows")
    log = run("native-smoke", [str(binary), "--verify-stage1"], timeout=120)
    marker = "Stage 1 verification: "
    locations = [line.split(marker, 1)[1] for line in log.read_text().splitlines() if marker in line]
    if not locations:
        raise SystemExit("FAIL: native app did not produce verification results")
    report = json.loads((Path(locations[-1]) / "results.json").read_text())
    if not report.get("valid") or not report.get("results") or not all(case.get("valid") for case in report["results"]):
        print(json.dumps(report, ensure_ascii=False, indent=2))
        raise SystemExit("FAIL: native bridge verification")
    print("PASS: actual native bridge", len(report["results"]), "checks; synthetic data only", flush=True)
if platform.system() != "Windows":
    print("Windows runtime: NOT RUN. Native UI checks on this computer are macOS previews, not Windows acceptance.", flush=True)
print("PASS: requested checks; no installed Mac application or real workspace used.", flush=True)
