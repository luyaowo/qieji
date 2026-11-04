#!/usr/bin/env python3
"""Exercise the print runner's exit handling without opening a window."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class PrintRunnerChecks(unittest.TestCase):
    def test_platform_control_does_not_replace_current_checks(self):
        for legacy_status, current_status, expected_success in [
            (0, 0, True), (1, 0, True), (3, 0, False), (1, 1, False), (0, 1, False)
        ]:
            with self.subTest(legacy=legacy_status, current=current_status):
                with tempfile.TemporaryDirectory(prefix="qieji-print-runner-") as directory:
                    root = Path(directory)
                    (root / "Scripts").mkdir()
                    shutil.copy2(Path(__file__).with_name("test-print-pdf.sh"), root / "Scripts/test-print-pdf.sh")
                    (root / "Sources/PaperEdgeApp/Resources").mkdir(parents=True)
                    (root / "Sources/PaperEdgeApp/MacResources").mkdir()
                    binary_dir = root / "bin"
                    binary_dir.mkdir()
                    # Replace only compilation/the native executable; run the real shell entry point.
                    compiler = binary_dir / "xcrun"
                    compiler.write_text("""#!/usr/bin/env python3
import os
from pathlib import Path
import sys
target = Path(sys.argv[sys.argv.index('-o') + 1])
target.write_text('''#!/usr/bin/env python3
import os
from pathlib import Path
import sys
with Path(os.environ['PRINT_CALLS']).open('a') as stream:
    print(' '.join(sys.argv[1:]), file=stream)
legacy = '--legacy-sync' in sys.argv
raise SystemExit(int(os.environ['LEGACY_STATUS' if legacy else 'CURRENT_STATUS']))
''')
target.chmod(0o755)
""")
                    compiler.chmod(0o755)
                    # Keep all runner outputs inside this disposable fixture.
                    mktemp = binary_dir / "mktemp"
                    mktemp.write_text("#!/bin/sh\nmkdir \"$PRINT_OUTPUT\"\nprintf '%s\\n' \"$PRINT_OUTPUT\"\n")
                    mktemp.chmod(0o755)
                    calls = root / "calls.txt"
                    environment = dict(os.environ, PATH=str(binary_dir) + os.pathsep + os.environ["PATH"],
                        PRINT_OUTPUT=str(root / "output"), PRINT_CALLS=str(calls),
                        LEGACY_STATUS=str(legacy_status), CURRENT_STATUS=str(current_status))
                    result = subprocess.run(["bash", str(root / "Scripts/test-print-pdf.sh")],
                        env=environment, text=True, capture_output=True, timeout=10)
                    self.assertTrue(calls.exists(), result.stdout + result.stderr)
                    invocations = calls.read_text().splitlines()
                    self.assertEqual(result.returncode == 0, expected_success, result.stdout + result.stderr)
                    current = [call for call in invocations if "--legacy-sync" not in call]
                    if expected_success:
                        self.assertEqual(len(current), 6)
                        for fixture in ("basic", "side", "paper", "many", "empty", "editing"):
                            self.assertTrue(any("--case " + fixture + " " in call for call in current))
                    elif legacy_status == 3:
                        self.assertEqual(current, [])
                    else:
                        self.assertEqual(len(current), 1)


if __name__ == "__main__":
    unittest.main()
