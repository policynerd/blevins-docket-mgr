#!/usr/bin/env bash
#
# Run the API and the web server side by side in one container.
#
# The pair is treated as one unit: if either dies the container exits, so Fly
# replaces the machine. The alternative — restarting the dead one in place —
# means a machine that passes its health check while serving a broken half, and
# the failure only shows up as confusing behaviour in the browser.
set -uo pipefail
# Anchored to this script rather than a hardcoded /app, so the same script runs
# in the image, in a release machine, and on a laptop. A hardcoded path fails
# outside the container in a way that looks like the script itself is broken.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Explicit, and not inherited from PORT: Fly sets PORT for the public service,
# and if the API read that too both processes would race for the same port.
API_PORT="${API_PORT:-3200}"
WEB_PORT="${PORT:-3100}"

PORT="$API_PORT" node --experimental-strip-types --no-warnings apps/api/src/main.ts &
api=$!

(cd apps/web && exec node_modules/.bin/next start -p "$WEB_PORT") &
web=$!

stop() {
  # Chromium is a child of the API process and needs the API's own shutdown to
  # run, so signal rather than kill.
  kill -TERM "$api" "$web" 2>/dev/null || true
  wait "$api" "$web" 2>/dev/null || true
}
trap stop TERM INT

# Returns as soon as *either* exits, rather than waiting for both.
wait -n
code=$?
echo "start.sh: a process exited with ${code}; shutting the container down" >&2
stop
exit "$code"
