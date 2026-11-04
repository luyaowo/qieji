#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
output=$(mktemp -d /private/tmp/qieji-store-checks.XXXXXX)
xcrun swiftc -parse-as-library -module-cache-path /private/tmp/qieji-store-module-cache \
  "${QIEJI_STORE_SOURCE:-Sources/PaperEdgeApp/TaskBackupStore.swift}" \
  Tests/WorkspaceStoreChecks.swift -o "$output/check-store"
"$output/check-store"
xcrun swiftc -parse-as-library -module-cache-path /private/tmp/qieji-store-module-cache \
  Sources/PaperEdgeApp/TaskReminderScheduler.swift Tests/ReminderPlanChecks.swift -o "$output/check-reminders"
"$output/check-reminders"
