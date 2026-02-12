#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Open dashboard in default browser after runner has started.
(
  sleep 1
  open "http://127.0.0.1:5050/ui"
) &

npm run runner:start
