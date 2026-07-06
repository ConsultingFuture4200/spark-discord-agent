#!/usr/bin/env bash
#
# install.sh — build the workspace and install the two systemd services
# (PRD §11 M5, NFR-2 always-on across reboots).
#
# Idempotent: safe to re-run after a pull. It:
#   1. verifies toolchain (node >= 20, pnpm),
#   2. `pnpm install` + `pnpm build` (all workspace packages),
#   3. ensures the storage dir exists,
#   4. renders infra/systemd/*.service.in with THIS host's user/paths/node,
#   5. installs them into /etc/systemd/system, daemon-reload, enable,
#   6. starts each service whose built entry point already exists.
#
# The systemd steps need root, so the script re-invokes those parts with sudo.
# Run as the operator (NOT as root) so the services are owned by the operator
# and RUN_USER is picked up correctly:
#
#   infra/install.sh
#
# Flags:
#   --no-services   build only; skip all systemd work.
#   --user USER     run the services as USER (default: invoking user).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
UNIT_DIR="/etc/systemd/system"
SERVICES=(discord-agent-capture discord-agent-processing)

if [ -t 1 ]; then
  RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
else
  RED=''; GRN=''; YLW=''; BLD=''; RST=''
fi
info() { printf '%s\n' "${BLD}==>${RST} $*"; }
ok()   { printf '%s\n' "  ${GRN}ok${RST}   $*"; }
warn() { printf '%s\n' "  ${YLW}warn${RST} $*"; }
die()  { printf '%s\n' "${RED}error:${RST} $*" >&2; exit 1; }

# --- args -------------------------------------------------------------------
DO_SERVICES=1
# When invoked via sudo, SUDO_USER is the real operator; prefer it.
RUN_USER="${SUDO_USER:-$(id -un)}"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-services) DO_SERVICES=0; shift ;;
    --user) RUN_USER="${2:?--user needs a value}"; shift 2 ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] && [ -z "${SUDO_USER:-}" ] && \
  warn "running as root directly — services will run as root. Prefer running as the operator."

# ===========================================================================
# 1. Toolchain
# ===========================================================================
info "Toolchain"
command -v node >/dev/null 2>&1 || die "node not found on PATH"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found $(node -v))"
command -v pnpm >/dev/null 2>&1 || die "pnpm not found — run: corepack enable && corepack prepare pnpm@11 --activate"
ok "node $(node -v), pnpm $(pnpm -v)"

ARCH="$(uname -m)"
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
  warn "arch is '$ARCH', not aarch64. The Spark is ARM64; run infra/verify-native.sh on the"
  warn "target host to confirm the DAVE/opus/sodium native stack builds there (M0)."
else
  ok "ARM64 ($ARCH)"
fi

# ===========================================================================
# 2. Install + build
# ===========================================================================
info "pnpm install"
# pnpm blocks package build scripts by default (the ignored-builds gate). The
# capture service needs @discordjs/opus + sodium-native COMPILED on ARM64
# (D-1/D-2) — a first install on a fresh host trips the gate and exits non-zero.
# Detect that specific case, approve the native builds, and retry so the install
# completes without an interactive `pnpm approve-builds`.
PNPM_LOG="$(mktemp "${TMPDIR:-/tmp}/discord-agent-pnpm.XXXXXX")"
if ! ( cd "$REPO_ROOT" && pnpm install 2>&1 | tee "$PNPM_LOG" ); then
  if grep -q 'ERR_PNPM_IGNORED_BUILDS' "$PNPM_LOG"; then
    warn "pnpm gated native build scripts — building @discordjs/opus + sodium-native and retrying"
    ( cd "$REPO_ROOT" && pnpm rebuild @discordjs/opus sodium-native ) \
      || { rm -f "$PNPM_LOG"; die "failed to build native modules (@discordjs/opus / sodium-native).
       Install a C toolchain: sudo apt-get install -y build-essential python3 cmake"; }
    # DAVE (@snazzah/davey) ships napi prebuilds; rebuild best-effort if present.
    ( cd "$REPO_ROOT" && pnpm rebuild @snazzah/davey ) >/dev/null 2>&1 || true
    ( cd "$REPO_ROOT" && pnpm install ) || { rm -f "$PNPM_LOG"; die "pnpm install still failing after approving native builds"; }
  else
    rm -f "$PNPM_LOG"; die "pnpm install failed (see output above)"
  fi
fi
rm -f "$PNPM_LOG"
ok "dependencies installed"

info "pnpm build"
( cd "$REPO_ROOT" && pnpm build )
ok "workspace built"

# ===========================================================================
# 3. Storage dir (STORAGE_DIR from .env, default ./data/calls)
# ===========================================================================
STORAGE_DIR="./data/calls"
if [ -f "$ENV_FILE" ]; then
  v="$(grep -E '^STORAGE_DIR=' "$ENV_FILE" | tail -n1 || true)"
  [ -n "$v" ] && STORAGE_DIR="${v#*=}"
fi
case "$STORAGE_DIR" in
  /*) STORAGE_ABS="$STORAGE_DIR" ;;
  *)  STORAGE_ABS="$REPO_ROOT/${STORAGE_DIR#./}" ;;
esac
mkdir -p "$STORAGE_ABS"
ok "storage dir ready: $STORAGE_ABS"

if [ "$DO_SERVICES" -eq 0 ]; then
  info "--no-services given — build complete, skipping systemd."
  exit 0
fi

# ===========================================================================
# 4. Render unit templates for this host
# ===========================================================================
[ -f "$ENV_FILE" ] || warn ".env not found at $ENV_FILE — copy .env.example to .env and fill it in before starting the services."

NODE_BIN="$(command -v node)"; NODE_BIN="$(readlink -f "$NODE_BIN")"   # absolute for systemd
RUN_GROUP="$(id -gn "$RUN_USER")" || die "cannot resolve group for user '$RUN_USER'"
RENDER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/discord-agent-units.XXXXXX")"
trap 'rm -rf "$RENDER_DIR"' EXIT

render() {
  # render <template.in> <output>
  sed \
    -e "s#@APP_DIR@#${REPO_ROOT}#g" \
    -e "s#@ENV_FILE@#${ENV_FILE}#g" \
    -e "s#@RUN_USER@#${RUN_USER}#g" \
    -e "s#@RUN_GROUP@#${RUN_GROUP}#g" \
    -e "s#@NODE_BIN@#${NODE_BIN}#g" \
    "$1" > "$2"
}

info "Rendering units (user=$RUN_USER group=$RUN_GROUP node=$NODE_BIN)"
for svc in "${SERVICES[@]}"; do
  render "$SCRIPT_DIR/systemd/${svc}.service.in" "$RENDER_DIR/${svc}.service"
  ok "rendered ${svc}.service"
done

# ===========================================================================
# 5. Install into systemd (needs root)
# ===========================================================================
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "need root to write $UNIT_DIR and no sudo found; re-run as root."
  SUDO="sudo"
fi

info "Installing units into $UNIT_DIR"
for svc in "${SERVICES[@]}"; do
  $SUDO install -m 0644 "$RENDER_DIR/${svc}.service" "$UNIT_DIR/${svc}.service"
  ok "installed $UNIT_DIR/${svc}.service"
done

$SUDO systemctl daemon-reload
ok "systemctl daemon-reload"

# enable = start on boot (NFR-2). Idempotent.
for svc in "${SERVICES[@]}"; do
  $SUDO systemctl enable "${svc}.service" >/dev/null
  ok "enabled ${svc}.service (starts on boot)"
done

# ===========================================================================
# 6. Start services whose built entry point exists
# ===========================================================================
declare -A ENTRY=(
  [discord-agent-capture]="$REPO_ROOT/packages/capture/dist/index.js"
  [discord-agent-processing]="$REPO_ROOT/packages/processing/dist/index.js"
)
info "Starting services"
for svc in "${SERVICES[@]}"; do
  if [ ! -f "${ENTRY[$svc]}" ]; then
    warn "${svc}: entry ${ENTRY[$svc]} not built yet — enabled but not started."
    continue
  fi
  if [ ! -f "$ENV_FILE" ]; then
    warn "${svc}: .env missing — enabled but not started. Configure .env then: $SUDO systemctl start ${svc}"
    continue
  fi
  $SUDO systemctl restart "${svc}.service"
  ok "started ${svc}.service"
done

printf '\n%s\n' "${GRN}${BLD}Install complete.${RST}"
printf '%s\n' "Status:  systemctl status ${SERVICES[0]} ${SERVICES[1]}"
printf '%s\n' "Logs:    journalctl -u ${SERVICES[0]} -f"
