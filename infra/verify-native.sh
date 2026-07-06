#!/usr/bin/env bash
#
# verify-native.sh — Milestone M0 environment check (PRD §11 M0, DECISIONS Q6).
#
# Fails fast, with an actionable message, when any of the hard prerequisites for
# the Discord agent are not satisfied on this host:
#
#   1. @discordjs/voice's DAVE native module (@snazzah/davey) BUILDS + LOADS.
#   2. A native libsodium binding (sodium-native) BUILDS + LOADS.
#   3. The native opus binding (@discordjs/opus) BUILDS + LOADS (voice receive).
#   4. The Ollama OpenAI-compatible endpoint RESPONDS, with the configured models.
#   5. faster-whisper is reachable (HTTP health URL if set, else importable + GPU).
#
# The native checks (1-3) are the real ARM64 risk (D-1/D-2). They are proven in
# an isolated scratch install so the check does not depend on the app packages
# being built yet — it answers "does this native stack compile/load on THIS CPU?"
#
# Usage:
#   infra/verify-native.sh                 # run all checks
#   SKIP_NATIVE=1 infra/verify-native.sh   # skip the native build probe
#   SKIP_SERVICES=1 infra/verify-native.sh # skip Ollama + whisper checks
#
# Exit code 0 = all attempted checks passed.

set -euo pipefail

# --- locate repo root (this script lives in <repo>/infra/) -----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

# --- pinned versions (voice pinned per build decision; aux at latest) -------
VOICE_SPEC="@discordjs/voice@^0.19.2"
DAVEY_SPEC="@snazzah/davey@latest"     # DAVE / MLS native module (D-1)
SODIUM_SPEC="sodium-native@latest"     # native libsodium binding (D-2)
OPUS_SPEC="@discordjs/opus@latest"     # native opus binding (voice receive)

# --- pretty output ----------------------------------------------------------
if [ -t 1 ]; then
  RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
else
  RED=''; GRN=''; YLW=''; BLD=''; RST=''
fi
info() { printf '%s\n' "${BLD}==>${RST} $*"; }
ok()   { printf '%s\n' "  ${GRN}ok${RST}   $*"; }
warn() { printf '%s\n' "  ${YLW}warn${RST} $*"; }
die()  { printf '%s\n' "  ${RED}FAIL${RST} $*" >&2; exit 1; }

# Read a single KEY from the .env file (no sourcing, no env dumping — safety.md).
# Prints the raw value (may be empty). Returns non-zero if the key is absent.
getenv() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 1
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1)" || return 1
  [ -n "$line" ] || return 1
  printf '%s' "${line#*=}"
}

# ---------------------------------------------------------------------------
info "Host: $(uname -s) $(uname -m), kernel $(uname -r)"
ARCH="$(uname -m)"
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "arm64" ]; then
  warn "arch is '$ARCH', not aarch64 — the Spark is ARM64. Native results here are not"
  warn "representative of the Spark. Run this ON the Spark for a meaningful M0 gate."
else
  ok "ARM64 architecture ($ARCH)"
fi

command -v node >/dev/null 2>&1 || die "node not found on PATH"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found $(node -v))"
ok "node $(node -v)"

# ===========================================================================
# 1-3. Native module build + load probe (@snazzah/davey, sodium-native, opus)
# ===========================================================================
if [ "${SKIP_NATIVE:-0}" = "1" ]; then
  warn "SKIP_NATIVE=1 — skipping native build probe"
else
  command -v pnpm >/dev/null 2>&1 || die "pnpm not found (needed for the native build probe)"
  info "Native build probe: $VOICE_SPEC + DAVE + libsodium + opus"

  PROBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dave-arm-probe.XXXXXX")"
  cleanup() { rm -rf "$PROBE_DIR"; }
  trap cleanup EXIT

  # pnpm blocks package build scripts by default; onlyBuiltDependencies opts the
  # native modules in so they actually COMPILE (that is what we are testing).
  cat > "$PROBE_DIR/package.json" <<JSON
{
  "name": "dave-arm-probe",
  "version": "0.0.0",
  "private": true,
  "type": "commonjs",
  "dependencies": {
    "$(printf '%s' "$VOICE_SPEC"  | sed 's/@[^@]*$//')": "$(printf '%s' "$VOICE_SPEC"  | sed 's/.*@//')",
    "@snazzah/davey": "latest",
    "sodium-native": "latest",
    "@discordjs/opus": "latest"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["sodium-native", "@discordjs/opus", "@snazzah/davey"]
  }
}
JSON

  info "  installing (compiles native addons — this can take a minute on ARM)..."
  if ! ( cd "$PROBE_DIR" && pnpm install --prod --reporter=silent ) ; then
    die "native install/compile failed. On ARM64 this usually means missing build tools —
       install: sudo apt-get install -y build-essential python3 cmake
       (sodium-native/opus need a C toolchain; davey needs a working prebuild or cargo)."
  fi
  ok "native modules installed"

  # Load each addon in a real Node process. A missing/incompatible .node binding
  # throws here — exactly the failure M0 must catch before deeper work.
  info "  loading native addons..."
  ( cd "$PROBE_DIR" && node -e '
    const load = (name) => {
      try {
        const m = require(name);
        let v = "";
        try { v = " v" + require(name + "/package.json").version; } catch {}
        console.log("  ok   loaded " + name + v);
        return m;
      } catch (e) {
        console.error("  FAIL could not load " + name + ": " + e.message);
        process.exit(1);
      }
    };
    // libsodium binding — exercise it, not just require it.
    const sodium = load("sodium-native");
    const buf = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES || 32);
    sodium.randombytes_buf(buf);
    if (buf.every((b) => b === 0)) { console.error("  FAIL sodium randombytes produced all-zero"); process.exit(1); }
    console.log("  ok   sodium randombytes works");
    // opus receive codec.
    load("@discordjs/opus");
    // DAVE / MLS native module — the D-1 ARM64 risk.
    load("@snazzah/davey");
    // voice ties them together; confirm it imports on this Node/ABI.
    load("@discordjs/voice");
  ' ) || die "a native addon failed to load (see above). The DAVE/opus/sodium stack is not usable on this host."
  ok "DAVE + libsodium + opus build and load on $ARCH"
fi

# ===========================================================================
# 4. Ollama OpenAI-compatible endpoint
# ===========================================================================
run_service_checks() { [ "${SKIP_SERVICES:-0}" != "1" ]; }

if ! run_service_checks; then
  warn "SKIP_SERVICES=1 — skipping Ollama + faster-whisper checks"
else
  command -v curl >/dev/null 2>&1 || die "curl not found (needed for endpoint checks)"

  OLLAMA_BASE_URL="$(getenv OLLAMA_BASE_URL || true)"
  OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434/v1}"
  OLLAMA_API_KEY="$(getenv OLLAMA_API_KEY || true)"
  INTERACTIVE_MODEL="$(getenv OLLAMA_INTERACTIVE_MODEL || true)"; INTERACTIVE_MODEL="${INTERACTIVE_MODEL:-qwen2.5:7b}"
  BATCH_MODEL="$(getenv OLLAMA_BATCH_MODEL || true)"; BATCH_MODEL="${BATCH_MODEL:-qwen2.5:32b}"

  info "Ollama endpoint: $OLLAMA_BASE_URL"
  AUTH=(); [ -n "$OLLAMA_API_KEY" ] && AUTH=(-H "Authorization: Bearer $OLLAMA_API_KEY")

  MODELS_JSON="$(curl -fsS --max-time 10 "${AUTH[@]}" "${OLLAMA_BASE_URL%/}/models" 2>/dev/null)" \
    || die "no response from ${OLLAMA_BASE_URL%/}/models — is Ollama running? (ollama serve)"
  ok "endpoint responded to GET /models"

  # Warn (not fail) on a missing model — models can be pulled after the gate.
  for model in "$INTERACTIVE_MODEL" "$BATCH_MODEL"; do
    if printf '%s' "$MODELS_JSON" | grep -qF "\"$model\"" || printf '%s' "$MODELS_JSON" | grep -qF "$model"; then
      ok "model present: $model"
    else
      warn "model '$model' not listed — pull it on the Spark: ollama pull $model"
    fi
  done

  # =========================================================================
  # 5. faster-whisper
  # =========================================================================
  WHISPER_HEALTH_URL="$(getenv WHISPER_HEALTH_URL || true)"
  if [ -n "$WHISPER_HEALTH_URL" ]; then
    info "faster-whisper service: $WHISPER_HEALTH_URL"
    curl -fsS --max-time 10 "$WHISPER_HEALTH_URL" >/dev/null \
      || die "no response from WHISPER_HEALTH_URL ($WHISPER_HEALTH_URL)"
    ok "faster-whisper health endpoint responded"
  else
    # In-process mode (no health URL configured): prove the library imports and
    # a GPU is visible, which is what the processing service needs on the Spark.
    info "faster-whisper: no WHISPER_HEALTH_URL set — checking local import + GPU"
    if command -v python3 >/dev/null 2>&1 && python3 -c 'import faster_whisper' 2>/dev/null; then
      FW_VER="$(python3 -c 'import faster_whisper,sys; print(getattr(faster_whisper,"__version__","?"))' 2>/dev/null || echo '?')"
      ok "faster_whisper importable (python3, v$FW_VER)"
    else
      die "faster_whisper not importable. Install on the Spark:
       pip install faster-whisper   (or set WHISPER_HEALTH_URL to a running whisper service)"
    fi
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
      ok "NVIDIA GPU visible ($(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1))"
    else
      warn "nvidia-smi not available — faster-whisper will fall back to CPU (slow on the Spark)."
    fi
  fi
fi

printf '\n%s\n' "${GRN}${BLD}M0 native + service checks passed.${RST}"
