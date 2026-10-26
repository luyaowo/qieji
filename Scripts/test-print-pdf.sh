#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
output=$(mktemp -d /private/tmp/qieji-print-regression.XXXXXX)
echo "Print verification output: $output"
mkdir "$output/resources" "$output/legacy" "$output/async"
cp -R Sources/PaperEdgeApp/Resources/. "$output/resources/"
cp -R Sources/PaperEdgeApp/MacResources "$output/resources/MacResources"
xcrun swiftc -module-cache-path /private/tmp/qieji-print-module-cache \
  Sources/PaperEdgeApp/WebPrintSession.swift Scripts/verify-print-pdf.swift \
  -o "$output/verify-print-pdf"

# Reproduction of a historical platform bug is diagnostic, not a release gate.
if "$output/verify-print-pdf" --case basic --legacy-sync --output "$output/legacy"; then
  echo 'INFO: historical synchronous-print failure not reproduced on this Mac; continuing current checks.'
else
  result=$?
  if [ "$result" -ne 1 ]; then
    echo "Negative control did not finish normally: $result" >&2
    exit 1
  fi
  echo 'INFO: historical synchronous-print content failure reproduced; continuing current checks.'
fi

for fixture in basic side paper many empty editing; do
  "$output/verify-print-pdf" --case "$fixture" --repeat \
    --resources "$output/resources" --output "$output/async"
done
echo 'PASS: current async PDF text, A4, multiple pages, hidden completed tasks and reminder metadata, unchanged screen reminders and repeat printing verified.'
