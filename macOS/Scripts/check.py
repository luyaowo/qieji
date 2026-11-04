#!/usr/bin/env python3
"""Run Mac behavior checks with synthetic data. Requires a logged-in desktop."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
output = Path(tempfile.mkdtemp(prefix="qieji-check-", dir="/private/tmp"))
environment = os.environ.copy()
environment["CLANG_MODULE_CACHE_PATH"] = str(output / "module-cache")
environment["SWIFTPM_MODULECACHE_OVERRIDE"] = str(output / "module-cache")
commands = [
    ("frontend", ["node", "Scripts/build-frontend.cjs", "--check"]),
    ("javascript", ["node", "--test"] + [str(p.relative_to(root)) for p in sorted((root / "Scripts").glob("*.test.cjs"))]
        + ["Scripts/test-reminder-time.cjs"]),
    ("store", ["bash", "Scripts/test-store.sh"]),
    ("interface-and-quit", ["python3", "Scripts/test-reliability.py"]),
    ("windows", ["python3", "Scripts/test-window-transition.py"]),
    ("app-lifecycle", ["python3", "Scripts/test-app-lifecycle.py"]),
    ("print-runner", ["python3", "-B", "Scripts/test-print-runner.py"]),
    ("print", ["bash", "Scripts/test-print-pdf.sh"]),
]
print("Check logs:", output, flush=True)
for name, command in commands:
    log = output / (name + ".log")
    print("Checking " + name + "…", flush=True)
    with log.open("w") as stream:
        result = subprocess.run(command, cwd=root, env=environment, stdout=stream, stderr=subprocess.STDOUT, timeout=600)
    if result.returncode:
        print("\n".join(log.read_text().splitlines()[-70:]), flush=True)
        raise SystemExit("FAIL: " + name + "; log: " + str(log))
    print("PASS: " + name, flush=True)
print("PASS: all Mac checks; no real tasks loaded or OS notifications scheduled.")
