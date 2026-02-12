#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# Install Homebrew if it's missing.
if ! command -v brew >/dev/null 2>&1; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Install Node.js (includes npm).
brew install node

# Install project dependencies.
npm install

# Install Playwright browsers required for local runs.
npx playwright install

echo "Setup complete. Node, npm packages, and Playwright browsers installed."
