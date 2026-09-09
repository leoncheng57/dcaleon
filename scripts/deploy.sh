#!/usr/bin/env bash
# One-command supervised deploy: move this checkout to a remote ref, then rebuild
# and reload the `ai.dcaleon.bff` LaunchAgent.
#
# Why this exists: the DEPLOYMENT.md runbook is a copy-paste sequence that assumes
# the repository root sitting on `main`. Run it from a worktree and `git switch
# main` fails ("'main' is already checked out at ..."), but the *remaining*
# commands still succeed — so `npm ci` and `service:install` happily deploy
# whatever commit was already on disk. That failure is silent in the worst way:
# the deploy looks like it ran. This script checks the ref out detached, so it
# behaves identically in the root checkout and in every worktree, and it refuses
# outright rather than deploying something you did not ask for.
#
# It also encodes the `npm ci` trap from DEPLOYMENT.md: reinstalling
# node_modules underneath the BFF that is serving from this same directory
# breaks its already-loaded imports. We skip the install when the lockfile did
# not move, and stop the service first when it must run.
set -euo pipefail

cd "$(dirname "$0")/.."
root="$(pwd)"

LABEL="ai.dcaleon.bff"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DEV_PORT=3000

DEFAULT_PORT=3210
PORT_ATTEMPTS=3

# Empty until resolved: an explicit --port wins, otherwise we ask.
port=""
ref="origin/main"
force_active_claude=0
skip_fetch=0

say() { printf '→ %s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
die() {
  printf '\n✗ %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  printf '\n' >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: scripts/deploy.sh [options]

Updates this checkout to a remote ref and reloads the supervised BFF.

Options:
  --port=N                Supervised port. When omitted you are asked for one,
                          with ${DEFAULT_PORT} offered as the default.
  --ref=REF               Git ref to deploy (default: ${ref}).
  --force-active-claude   Replace the BFF even if Claude sessions are running.
                          Passed through to scripts/launchd.ts.
  --skip-fetch            Do not run 'git fetch'; deploy the ref as already known.
  -h, --help              Show this message.

The port is asked for rather than assumed because deploying onto the wrong port
either collides with a running service or quietly starts a second one. Press
Enter to accept ${DEFAULT_PORT}. With no answer available — a pipe, cron, CI — the
default is used, so non-interactive callers keep working; pass --port to be
explicit there.

Examples:
  scripts/deploy.sh                          # asks for the port, default ${DEFAULT_PORT}
  scripts/deploy.sh --port=3211              # skip the question
  scripts/deploy.sh --ref=origin/release-1.2 # deploy some other ref
EOF
}

for argument in "$@"; do
  case "$argument" in
    --port=*) port="${argument#--port=}" ;;
    --ref=*) ref="${argument#--ref=}" ;;
    --force-active-claude) force_active_claude=1 ;;
    --skip-fetch) skip_fetch=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: ${argument}" "Run 'scripts/deploy.sh --help' for usage." ;;
  esac
done

# Rejects a port scripts/launchd.ts would reject anyway, so a typo costs a
# second instead of a full SPA + server build. parseSupervisedPort() there stays
# the authority; this mirrors it only to move the error earlier.
port_rejection() {
  local value="$1"
  case "$value" in
    '' | *[!0-9]*)
      printf 'invalid supervised port: %s (expected an integer between 1 and 65535)' "$value"
      return 0
      ;;
  esac
  if [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    printf 'invalid supervised port: %s (expected an integer between 1 and 65535)' "$value"
    return 0
  fi
  if [ "$value" -eq "$DEV_PORT" ]; then
    printf 'supervised port %s conflicts with the development default' "$DEV_PORT"
    return 0
  fi
  return 1
}

# An explicit --port is taken as given; anything else is a question, because
# deploying onto the wrong port either collides with the running service or
# quietly starts a second one alongside it.
if [ -n "$port" ]; then
  if rejection="$(port_rejection "$port")"; then
    die "${rejection}" "Run 'scripts/deploy.sh --help' for usage."
  fi
else
  attempt=0
  while [ "$attempt" -lt "$PORT_ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    printf '→ which supervised port? [%s] ' "$DEFAULT_PORT"
    # EOF (a pipe, cron, CI) is not a wrong answer, it is the absence of one:
    # fall back to the default rather than failing a non-interactive deploy.
    if ! read -r answer; then
      printf '\n'
      port="$DEFAULT_PORT"
      info "no answer available — using the default :${DEFAULT_PORT}"
      break
    fi
    answer="${answer:-$DEFAULT_PORT}"
    if rejection="$(port_rejection "$answer")"; then
      # Interactively the user's own Enter ended the prompt line; a piped
      # answer leaves the cursor mid-line, so close it before complaining.
      [ -t 0 ] || printf '\n'
      warn "$rejection"
    else
      port="$answer"
      break
    fi
  done
  if [ -z "$port" ]; then
    die "no valid supervised port after ${PORT_ATTEMPTS} attempts" \
      "Pass one directly, e.g. --port=${DEFAULT_PORT}."
  fi
fi

printf '\n'
say "deploying ${ref} to ${LABEL} on :${port}"
info "checkout: ${root}"

# ---------------------------------------------------------------------------
# Preflight: never build a tree that is not exactly the commit you asked for.
# ---------------------------------------------------------------------------
say "checking the working tree"
dirty="$(git status --porcelain)"
if [ -n "$dirty" ]; then
  die "refusing to deploy: this checkout has uncommitted changes" \
    "service:install builds whatever is on disk, so those changes would ship" \
    "even though they are not on ${ref}." \
    "" \
    "Preserve the work first — commit it on its own branch, or deploy from a" \
    "separate clean worktree. Do not stash it: the stash stack is shared with" \
    "every other worktree of this repository." \
    "" \
    "$(printf '%s\n' "$dirty" | head -20)"
fi
ok "clean"

previous="$(git rev-parse HEAD)"
info "currently at $(git rev-parse --short HEAD) $(git log -1 --format=%s HEAD)"

if [ "$skip_fetch" -eq 1 ]; then
  say "skipping fetch (--skip-fetch)"
else
  say "fetching origin"
  git fetch origin
  ok "fetched"
fi

if ! target="$(git rev-parse --verify --quiet "${ref}^{commit}")"; then
  die "cannot resolve ref: ${ref}" \
    "Fetch it first, or pass an existing ref with --ref=<ref>."
fi

# Explain, rather than trip over, the exact condition that breaks the runbook's
# 'git switch main': a branch can only be checked out in one worktree at a time.
branch="${ref#origin/}"
holder="$(git worktree list --porcelain |
  awk -v b="refs/heads/${branch}" '/^worktree /{w=$2} /^branch /{if ($2==b) print w}')"
if [ -n "$holder" ] && [ "$holder" != "$root" ]; then
  say "note: branch '${branch}' is checked out in another worktree"
  info "${holder}"
  info "That is why this script checks ${ref} out detached instead of switching"
  info "to '${branch}' — git allows a branch in only one worktree at a time."
fi

# ---------------------------------------------------------------------------
# Decide whether dependencies need reinstalling, before changing anything.
# Reinstalling under a live BFF is the documented deploy trap, so the cheapest
# safe answer is usually "don't".
# ---------------------------------------------------------------------------
say "checking dependencies"
needs_install=0
install_reason=""
if [ ! -d node_modules ]; then
  needs_install=1
  install_reason="node_modules is missing"
elif [ -n "$(git diff --name-only "$previous" "$target" -- package-lock.json package.json)" ]; then
  needs_install=1
  install_reason="package.json or package-lock.json changed in this update"
fi

if [ "$needs_install" -eq 0 ]; then
  ok "unchanged — will skip 'npm ci'"
  info "Nothing in this update touches the dependency tree. Reinstalling would"
  info "delete node_modules underneath a BFF serving from this checkout, which"
  info "breaks its already-loaded imports (see DEPLOYMENT.md)."
else
  ok "will run 'npm ci' (${install_reason})"
fi

# Everything above only reads. Everything below changes the checkout, the
# dependency tree, or the LaunchAgent — so this is the last safe stop, and the
# gate tests/deploy-script.test.ts uses to exercise the real checks.
if [ "${DCA_DEPLOY_PREFLIGHT_ONLY:-0}" = "1" ]; then
  say "preflight only (DCA_DEPLOY_PREFLIGHT_ONLY=1) — stopping before any change"
  exit 0
fi

# ---------------------------------------------------------------------------
# Update the checkout.
# ---------------------------------------------------------------------------
if [ "$target" = "$previous" ]; then
  say "already at $(git rev-parse --short "$target") — rebuilding and reloading anyway"
else
  say "checking out ${ref} ($(git rev-parse --short "$target")) detached"
  git -c advice.detachedHead=false checkout --detach "$target"
  ok "$(git rev-parse --short HEAD) $(git log -1 --format=%s HEAD)"
fi

# ---------------------------------------------------------------------------
# Dependencies.
# ---------------------------------------------------------------------------
if [ "$needs_install" -eq 1 ]; then
  say "installing dependencies (${install_reason})"
  # Only dangerous when the running service resolves modules from this very
  # directory. Stop it first and wait for the port, exactly as DEPLOYMENT.md
  # prescribes; service:install brings it back at the end.
  serving_here=0
  if [ -f "$PLIST" ] && grep -q "<string>${root}</string>" "$PLIST" &&
    launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    serving_here=1
  fi
  if [ "$serving_here" -eq 1 ]; then
    warn "the running BFF serves from this checkout — stopping it before 'npm ci'"
    launchctl bootout "gui/$(id -u)/${LABEL}" || true
    for _ in 1 2 3 4 5; do
      /usr/sbin/lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1 || break
      sleep 1
    done
    ok "stopped; :${port} released"
  fi
  npm ci
  ok "installed"
fi

# ---------------------------------------------------------------------------
# Build + reload the LaunchAgent.
# ---------------------------------------------------------------------------
say "building and reloading ${LABEL}"
install_args=("--port=${port}")
[ "$force_active_claude" -eq 1 ] && install_args+=("--force-active-claude")
install_log="$(mktemp -t dcaleon-service-install.XXXXXX)"
# Keep the log on failure so the operator can inspect it.
keep_install_log=0
cleanup_install_log() { [ "$keep_install_log" -eq 0 ] && rm -f "$install_log"; }
trap cleanup_install_log EXIT
if ! npm run service:install -- "${install_args[@]}" 2>&1 | tee "$install_log"; then
  # macOS occasionally returns bootstrap error 5 immediately after bootout,
  # even though the newly written plist is valid. At that point install has
  # already removed the old service, so exiting here leaves localhost down.
  # Retry only this exact terminal failure: never turn a build, config or
  # active-session refusal into an implicit service start.
  #
  # The sentinel is a substring match (grep -Fq), not exact whole-line
  # (grep -Fxq), because tsx wraps the error in a stack trace.
  recovered=0
  if grep -Fq "launchctl bootstrap failed" "$install_log" && [ -f "$PLIST" ]; then
    domain="gui/$(id -u)"
    target="${domain}/${LABEL}"
    if launchctl print "$target" >/dev/null 2>&1; then
      # Service IS loaded despite error 5 — poll for health rather than
      # retrying bootstrap (which would fail on an already-loaded service).
      warn "bootstrap returned an error but the service is loaded — checking health"
      for attempt in $(seq 1 10); do
        if /usr/bin/curl -fsS --max-time 3 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
          ok "service healthy after bootstrap error (health poll ${attempt})"
          recovered=1
          break
        fi
        sleep 1
      done
      if [ "$recovered" -eq 0 ]; then
        warn "service is loaded but never became healthy"
      fi
    else
      # Service is NOT loaded — retry bootstrap.
      warn "launchd rejected the first bootstrap — retrying without rebuilding"
      for attempt in 1 2 3; do
        sleep "$attempt"
        if launchctl bootstrap "$domain" "$PLIST" 2>/dev/null ||
          launchctl print "$target" >/dev/null 2>&1; then
          if launchctl print "$target" >/dev/null 2>&1; then
            ok "LaunchAgent loaded on bootstrap retry ${attempt}"
            recovered=1
            break
          fi
        fi
        warn "bootstrap retry ${attempt} failed"
      done
    fi
  fi
  if [ "$recovered" -eq 0 ]; then
    keep_install_log=1
    die "service:install failed (log preserved: ${install_log})" \
      "The LaunchAgent may have been replaced without being loaded. Check:" \
      "  launchctl print gui/$(id -u)/${LABEL}" \
      "  npm run service:logs" \
      "  cat ${install_log}"
  fi
fi
rm -f "$install_log"
trap - EXIT

# ---------------------------------------------------------------------------
# Prove it is actually serving. A successful bootstrap is not a healthy BFF.
# ---------------------------------------------------------------------------
say "verifying :${port}"
healthy=0
for _ in $(seq 1 20); do
  if /usr/bin/curl -fsS --max-time 3 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done

if [ "$healthy" -eq 0 ]; then
  die "deployed ${ref}, but :${port} never answered /api/health" \
    "The LaunchAgent is installed; the process is not serving. Check:" \
    "  npm run service:logs" \
    "  launchctl print gui/$(id -u)/${LABEL}"
fi

pid="$(launchctl list | awk -v l="$LABEL" '$3 == l { print $1 }')"
ok "healthy on http://127.0.0.1:${port} (pid ${pid:-unknown})"

printf '\n✓ deployed %s at %s\n' "$ref" "$(git rev-parse --short HEAD)"
info "$(git log -1 --format=%s HEAD)"
info "logs: npm run service:logs"
printf '\n'
