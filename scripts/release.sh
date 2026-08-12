#!/usr/bin/env bash
#
# Fly release command: bring the database up to date before the new version
# takes traffic. Runs on a throwaway machine with the app's secrets; a non-zero
# exit aborts the release.
set -euo pipefail
# Anchored to this script rather than a hardcoded /app, so the same script runs
# in the image, in a release machine, and on a laptop. A hardcoded path fails
# outside the container in a way that looks like the script itself is broken.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "release: applying migrations"
node --experimental-strip-types --no-warnings packages/db/src/migrate.ts

# Idempotent, and it never overwrites an existing row — so it cannot clear the
# Entra binding recorded against someone who has already signed in. Running it
# every release means a newly added officer appears without a manual step.
echo "release: seeding the roster"
node --experimental-strip-types --no-warnings apps/api/src/seed.ts
