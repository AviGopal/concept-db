#!/usr/bin/env bash
# Install the versioned git hooks for concept-db.
#
# Sets core.hooksPath to scripts/git-hooks/ so updates to the hooks land via
# `git pull` rather than re-copying files into .git/hooks/.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

git config core.hooksPath scripts/git-hooks
chmod +x scripts/git-hooks/pre-commit

echo "✓ core.hooksPath set to scripts/git-hooks"
echo "✓ pre-commit hook is executable"
echo ""
echo "Optional: install gitleaks for secrets scanning"
echo "  brew install gitleaks                              # macOS"
echo "  go install github.com/gitleaks/gitleaks/v8@latest  # Go"
