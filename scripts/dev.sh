#!/usr/bin/env bash
# One-command local dev: BFF (tsx watch) + Vite UI, both on the host.
#
# Unlike the predecessor there is no `docker compose` step — `opencode serve`
# is a plain process you supervise yourself (see deploy/ai.opencode.serve.plist).
# This script does not start it; it checks that it is reachable and tells you
# what to do if it isn't.
set -euo pipefail

cd "$(dirname "$0")/.."

# Captured before .env is sourced: .env is shared with the supervised BFF, so
# only the invoking shell may opt a dev stack into notification delivery (#320).
notification_delivery="${NOTIFICATION_DELIVERY:-off}"

env_file="${DCA_ENV_FILE:-./.env}"
[ -f "$env_file" ] && set -a && . "$env_file" && set +a
export NOTIFICATION_DELIVERY="$notification_delivery"

OPENCODE_URL="${OPENCODE_URL:-http://127.0.0.1:4096}"
PORT="${PORT:-3000}"

echo "→ checking opencode server at ${OPENCODE_URL}"
if [ -n "${OPENCODE_SERVER_PASSWORD:-}" ]; then
  health=$(curl -fsS --max-time 5 \
    --user "${OPENCODE_SERVER_USERNAME:-opencode}:${OPENCODE_SERVER_PASSWORD}" \
    "${OPENCODE_URL}/global/health" 2>/dev/null) || health=""
else
  health=$(curl -fsS --max-time 5 "${OPENCODE_URL}/global/health" 2>/dev/null) || health=""
fi
if [ -z "$health" ]; then
  cat >&2 <<EOF

✗ Cannot reach an opencode server at ${OPENCODE_URL}

  Start one:      opencode serve --hostname 127.0.0.1 --port 4096
  If you intentionally manage OpenCode with launchd, see deploy/README.md.

  If it is running with a password, set OPENCODE_SERVER_PASSWORD in .env.
EOF
  exit 1
fi
echo "  ✓ ${health}"

# Warn early on version skew — it is the first thing to suspect when a
# response shape looks wrong.
# Capture the pin verbatim, including any SemVer build metadata (`+dca.<n>`).
# A bare MAJOR.MINOR.PATCH match would drop that suffix and then disagree with
# the server's full string on every start — a warning that always fires is
# worse than none.
expected=$(grep -oE 'EXPECTED_SERVER_VERSION = "[^"]+"' server/opencode/client.ts | sed -E 's/.*"([^"]+)"/\1/' || true)
actual=$(printf '%s' "$health" | grep -oE '"version":"[^"]+"' | cut -d'"' -f4 || true)
if [ -n "$expected" ] && [ -n "$actual" ] && [ "$expected" != "$actual" ]; then
  echo "  ! version skew: server ${actual}, client pinned to ${expected}" >&2
fi

echo "→ notification delivery: ${NOTIFICATION_DELIVERY}"
if [ "${NOTIFICATION_DELIVERY}" = "off" ]; then
  echo "  (no Web Push, ntfy or notification history from this BFF; run NOTIFICATION_DELIVERY=on npm run dev to enable)"
fi

# Used by the regression test to exercise the real preflight without starting
# either long-running development process.
if [ "${DEV_HEALTHCHECK_ONLY:-0}" = "1" ]; then
  exit 0
fi

npx --no-install tsx scripts/dev-preflight.ts "$PORT"

cleanup() { jobs -p | xargs -r kill 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "→ BFF   :${PORT}"
PORT="$PORT" npx tsx watch server/index.ts &

echo "→ UI    :5173"
npx vite &

wait
