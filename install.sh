#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
PACKAGE_JSON="$REPO_ROOT/package.json"
DEFAULT_API_PORT=47923
API_PORT="${WINDSURF_API_PORT:-$DEFAULT_API_PORT}"
NODE_VERSION=""
NODE_MAJOR=""

log() {
  printf '[INFO] %s\n' "$1"
}

warn() {
  printf '[WARN] %s\n' "$1"
}

fail_with_solution() {
  printf '[ERROR] %s\n' "$1" >&2
  printf 'How to solve: %s\n' "$2" >&2
  exit 1
}

install_hint() {
  local command_name="$1"

  if command -v brew >/dev/null 2>&1; then
    printf 'Install `%s` with Homebrew: `brew install %s`' "$command_name" "$command_name"
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    printf 'Install `%s` with apt: `sudo apt-get update && sudo apt-get install -y %s`' "$command_name" "$command_name"
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    printf 'Install `%s` with dnf: `sudo dnf install -y %s`' "$command_name" "$command_name"
    return
  fi

  printf 'Install `%s` using your OS package manager, then re-run this script.' "$command_name"
}

require_command() {
  local command_name="$1"
  local purpose="$2"

  if command -v "$command_name" >/dev/null 2>&1; then
    return
  fi

  fail_with_solution \
    "Missing required command: $command_name ($purpose)." \
    "$(install_hint "$command_name")"
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return
  fi

  if command -v corepack >/dev/null 2>&1; then
    log "pnpm was not found. Trying to activate pnpm through corepack."
    if corepack enable && corepack prepare pnpm@latest --activate; then
      log "pnpm activated through corepack."
      return
    fi
  fi

  fail_with_solution \
    "pnpm is required but is not available." \
    'Install pnpm (`npm install -g pnpm`) or enable it with corepack (`corepack enable && corepack prepare pnpm@latest --activate`).'
}

check_node_version() {
  NODE_VERSION="$(node -v 2>/dev/null | sed 's/^v//')"
  NODE_MAJOR="${NODE_VERSION%%.*}"

  if [[ -z "$NODE_MAJOR" || ! "$NODE_MAJOR" =~ ^[0-9]+$ || "$NODE_MAJOR" -lt 20 ]]; then
    fail_with_solution \
      "Node.js v20+ is required, but found v${NODE_VERSION:-unknown}." \
      "Install Node.js 20 or newer from https://nodejs.org/ and re-run this script."
  fi

  if [[ "$NODE_MAJOR" -ge 25 ]]; then
    warn "Node.js v${NODE_VERSION} detected. Proto generation will use compatibility mode on Node 25+."
  fi
}

build_node_options_with_webstorage_fix() {
  local current="${NODE_OPTIONS:-}"

  if [[ "$current" == *"--no-experimental-webstorage"* ]]; then
    printf '%s' "$current"
    return
  fi

  if [[ -n "$current" ]]; then
    printf '%s --no-experimental-webstorage' "$current"
    return
  fi

  printf '%s' "--no-experimental-webstorage"
}

generate_protos() {
  local node_options_compat

  if [[ ! -f "$REPO_ROOT/buf.gen.yaml" ]]; then
    fail_with_solution \
      "buf.gen.yaml was not found." \
      "Ensure you are in the windsurf-api repository root and that protobuf config files are present."
  fi

  if [[ ! -d "$REPO_ROOT/protos" ]]; then
    fail_with_solution \
      "protos directory was not found." \
      "Restore the `protos/` directory, then re-run this script."
  fi

  log "Generating protobuf TypeScript files."
  node_options_compat="$(build_node_options_with_webstorage_fix)"

  if [[ "$NODE_MAJOR" -ge 25 ]]; then
    log "Using Node compatibility mode for protobuf generation."
    if ! NODE_OPTIONS="$node_options_compat" pnpm exec buf generate; then
      fail_with_solution \
        "Protobuf generation failed." \
        'Review the buf/proto errors above (for example duplicate proto symbols), fix them, then retry `pnpm exec buf generate`.'
    fi
  elif ! pnpm exec buf generate; then
    warn "Proto generation failed. Retrying with a Node compatibility fallback."
    if ! NODE_OPTIONS="$node_options_compat" pnpm exec buf generate; then
      fail_with_solution \
        "Protobuf generation failed." \
        'Review the buf/proto errors above (for example duplicate proto symbols), fix them, then retry `pnpm exec buf generate`.'
    fi
    log "Proto generation succeeded with compatibility fallback."
  fi

  if [[ ! -f "$REPO_ROOT/src/gen/exa.language_server_pb_pb.ts" || ! -f "$REPO_ROOT/src/gen/exa.codeium_common_pb_pb.ts" || ! -f "$REPO_ROOT/src/gen/exa.cortex_pb_pb.ts" ]]; then
    fail_with_solution \
      "Expected generated files were not created in src/gen." \
      'Run `pnpm exec buf generate` manually and confirm src/gen contains the required *_pb_pb.ts files.'
  fi
}

check_extension_manifest_commands() {
  if ! node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const commands = pkg?.contributes?.commands ?? [];
const hasStart = commands.some(
  (c) => c.command === "windsurfapi.startServer" && c.title === "Windsurf API: Start Server"
);
const hasStop = commands.some((c) => c.command === "windsurfapi.stopServer");
if (!hasStart || !hasStop) process.exit(1);
'; then
    fail_with_solution \
      "Extension manifest does not declare expected Windsurf API commands." \
      "Restore the command entries in package.json (windsurfapi.startServer and windsurfapi.stopServer), then re-run this script."
  fi

  log "Verified extension manifest command entries."
}

print_windsurf_command_fix_steps() {
  cat <<'EOF'
Run the extension installer script:
  bash scripts/install_extension.sh

What this script automates:
- Packages the extension into a .vsix file.
- Falls back to `pnpm dlx @vscode/vsce package --no-dependencies` if `vsce` is missing.
- Reports failures with a log file path.

What still requires manual action in Windsurf:
- Install the .vsix from the Windsurf Extensions UI.
- Ensure the extension is enabled and reload Windsurf.
- Confirm "Windsurf API: Start Server" appears in Command Palette and run it.
EOF
}

print_verification_commands() {
  local version
  version="$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")"

  printf '\nInstallation complete for windsurf-api v%s.\n' "$version"
  cat <<EOF
Run these commands to verify the API is working after you start the server in Windsurf:

# In Windsurf Command Palette:
#   Windsurf API: Start Server

curl -fsS http://localhost:${API_PORT}/models
curl -fsS -X POST http://localhost:${API_PORT}/prompt \\
  -H "Content-Type: application/json" \\
  -d '{"text":"Hello from windsurf-api install verification"}'

# Optional: run the included smoke test scripts
bash tests/test_models.sh
bash tests/test_text.sh
EOF
}

log "Starting windsurf-api installation in $REPO_ROOT"

if [[ ! -f "$PACKAGE_JSON" ]]; then
  fail_with_solution \
    "package.json was not found at $PACKAGE_JSON." \
    "Run this script from the windsurf-api repository root."
fi

require_command node "building and running the extension"
check_node_version
ensure_pnpm
require_command curl "runtime verification calls"

cd "$REPO_ROOT"

log "Installing dependencies with pnpm."
if ! CI=true pnpm install --frozen-lockfile; then
  warn "Frozen lockfile install failed. Retrying with a standard pnpm install."
  if ! CI=true pnpm install; then
    fail_with_solution \
      "Dependency installation failed." \
      'Check the pnpm errors above (network access, registry auth, or lockfile/module issues), then retry `pnpm install`.'
  fi
fi

generate_protos

log "Compiling TypeScript sources."
if ! pnpm run compile; then
  fail_with_solution \
    "Compilation failed." \
    'Review the TypeScript errors above, resolve them, and retry `pnpm run compile`.'
fi

if [[ ! -f "$REPO_ROOT/out/extension.js" ]]; then
  fail_with_solution \
    "Build artifact out/extension.js was not produced." \
    'Run `pnpm run compile` manually and verify `tsconfig.json` outDir/rootDir settings.'
fi

check_extension_manifest_commands

if curl -fsS --max-time 4 "http://localhost:${API_PORT}/models" >/dev/null 2>&1; then
  log "Live API check succeeded at http://localhost:${API_PORT}/models."
else
  warn "Could not reach http://localhost:${API_PORT}/models for a live runtime check."
  warn "Windsurf command availability cannot be checked directly from this shell."
  print_windsurf_command_fix_steps
fi

print_verification_commands
