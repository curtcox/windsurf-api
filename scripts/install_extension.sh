#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${TMPDIR:-/tmp}/windsurf-api-install-extension.log"
PACKAGE_SCRIPT=""
EXTENSION_NAME=""
EXTENSION_PUBLISHER=""

log() {
  printf '[INFO] %s\n' "$1"
}

warn() {
  printf '[WARN] %s\n' "$1"
}

fail_with_solution() {
  printf '[ERROR] %s\n' "$1" >&2
  printf 'How to solve: %s\n' "$2" >&2
  printf 'Error log: %s\n' "$LOG_FILE" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  local purpose="$2"

  if command -v "$command_name" >/dev/null 2>&1; then
    return
  fi

  fail_with_solution \
    "Missing required command: $command_name ($purpose)." \
    "Install $command_name, then re-run this script."
}

command_exists() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1
}

get_package_field() {
  local field="$1"
  node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const key = process.argv[1];
const value = pkg?.[key];
if (typeof value === "string") process.stdout.write(value);
' "$field"
}

has_vsce_not_found_error() {
  local log_file="$1"
  grep -Eq 'vsce: command not found|Command "vsce" not found|sh: vsce:' "$log_file"
}

get_package_script() {
  node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const script = pkg?.scripts?.package;
if (typeof script === "string") process.stdout.write(script);
'
}

ensure_package_script_exists() {
  PACKAGE_SCRIPT="$(get_package_script)"
  if [[ -z "$PACKAGE_SCRIPT" ]]; then
    fail_with_solution \
      "package.json is missing scripts.package." \
      'Add a package script (for example `vsce package --no-dependencies`) and retry.'
  fi
}

ensure_extension_metadata() {
  EXTENSION_NAME="$(get_package_field "name")"
  EXTENSION_PUBLISHER="$(get_package_field "publisher")"

  if [[ -z "$EXTENSION_NAME" ]]; then
    fail_with_solution \
      "package.json is missing extension name." \
      "Add a valid name field to package.json and retry."
  fi
}

pnpm_dlx_available() {
  pnpm dlx --help >/dev/null 2>&1
}

vsce_available() {
  if command_exists vsce; then
    return 0
  fi

  pnpm exec vsce --version >/dev/null 2>&1
}

print_log_tail() {
  if [[ -f "$LOG_FILE" ]]; then
    warn "Last 40 lines of operation log:"
    tail -n 40 "$LOG_FILE" >&2 || true
  fi
}

find_latest_vsix() {
  local latest
  latest="$(ls -t "$REPO_ROOT"/*.vsix 2>/dev/null | head -1 || true)"
  printf '%s' "$latest"
}

install_extension_with_windsurf() {
  local vsix_path="$1"
  log "Installing extension via windsurf --install-extension."

  if ! windsurf --install-extension "$vsix_path" --force >>"$LOG_FILE" 2>&1; then
    print_log_tail
    fail_with_solution \
      "Failed to install VSIX through windsurf CLI." \
      'Run `windsurf --install-extension "<path-to-vsix>" --force` manually and review the CLI output.'
  fi
}

verify_extension_installed() {
  local installed_raw normalized line base
  local expected_name expected_full found

  expected_name="$(printf '%s' "$EXTENSION_NAME" | tr '[:upper:]' '[:lower:]')"
  expected_full=""
  if [[ -n "$EXTENSION_PUBLISHER" ]]; then
    expected_full="$(printf '%s.%s' "$EXTENSION_PUBLISHER" "$EXTENSION_NAME" | tr '[:upper:]' '[:lower:]')"
  fi

  if ! installed_raw="$(windsurf --list-extensions 2>>"$LOG_FILE")"; then
    print_log_tail
    fail_with_solution \
      "Failed to list installed Windsurf extensions." \
      'Run `windsurf --list-extensions` manually and confirm the extension is present.'
  fi

  normalized="$(printf '%s\n' "$installed_raw" | awk '/^[A-Za-z0-9._-]+(@[A-Za-z0-9._+-]+)?$/ {print tolower($0)}')"
  found=""

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    base="${line%@*}"

    if [[ "$base" == "$expected_name" ]]; then
      found="$base"
      break
    fi

    if [[ -n "$expected_full" && "$base" == "$expected_full" ]]; then
      found="$base"
      break
    fi

    if [[ "$base" == *".$expected_name" ]]; then
      found="$base"
      break
    fi
  done <<< "$normalized"

  if [[ -z "$found" ]]; then
    print_log_tail
    fail_with_solution \
      'Extension does not appear in `windsurf --list-extensions` after install.' \
      'Check `windsurf --list-extensions` output manually and reinstall the VSIX if needed.'
  fi

  log "Verified extension installation: $found"
}

package_with_dlx_fallback() {
  if ! pnpm_dlx_available; then
    warn "pnpm dlx is unavailable in this pnpm version/environment."
    return 1
  fi

  warn "Using fallback packaging with pnpm dlx @vscode/vsce."
  if pnpm dlx @vscode/vsce package --no-dependencies >>"$LOG_FILE" 2>&1; then
    log "Extension packaged via pnpm dlx fallback."
    return 0
  fi

  return 1
}

package_extension() {
  : >"$LOG_FILE"

  if [[ "$PACKAGE_SCRIPT" == *"vsce"* ]] && ! vsce_available; then
    warn "scripts.package uses vsce but vsce is not currently available."
    if package_with_dlx_fallback; then
      return
    fi

    print_log_tail
    fail_with_solution \
      "Failed to package extension: vsce is unavailable and fallback packaging failed." \
      'Ensure network access for `pnpm dlx`, or install vsce (`pnpm add -D @vscode/vsce`), then re-run this script.'
  fi

  log "Packaging extension with pnpm run package."
  if pnpm run package >"$LOG_FILE" 2>&1; then
    log "Extension packaged via project script."
    return
  fi

  warn "Primary packaging failed."
  cat "$LOG_FILE" >&2

  if has_vsce_not_found_error "$LOG_FILE"; then
    warn "Detected missing vsce binary in package script output."
    if package_with_dlx_fallback; then
      return
    fi
  fi

  print_log_tail
  fail_with_solution \
    "Failed to package extension into a .vsix file." \
    "Review the packaging errors above, ensure dependencies are installed, and verify network access if using pnpm dlx."
}

print_manual_steps() {
  local vsix_path="$1"

  cat <<EOF
Automated steps completed:
- Built extension package: $vsix_path
- Installed extension via windsurf CLI.
- Verified extension appears in windsurf extension list.

These steps cannot be fully automated from this shell:
1. If Windsurf is already open, reload Windsurf to ensure command registration is refreshed.
2. In Windsurf Command Palette, run:
   Windsurf API: Start Server

Note:
- Command Palette execution cannot be triggered from this script because no supported CLI flag is exposed for running extension commands directly.
EOF
}

main() {
  require_command node "running package tools"
  require_command pnpm "packaging the extension"
  require_command windsurf "installing and verifying the extension"

  cd "$REPO_ROOT"

  if [[ ! -f "$REPO_ROOT/package.json" ]]; then
    fail_with_solution \
      "package.json not found in repository root." \
      "Run this script from inside the windsurf-api repository."
  fi

  ensure_package_script_exists
  ensure_extension_metadata
  package_extension

  local vsix_path
  vsix_path="$(find_latest_vsix)"
  if [[ -z "$vsix_path" || ! -f "$vsix_path" ]]; then
    fail_with_solution \
      "Packaging completed but no .vsix file was found." \
      'Confirm package output and permissions, then run `pnpm run package` manually.'
  fi

  install_extension_with_windsurf "$vsix_path"
  verify_extension_installed

  print_manual_steps "$vsix_path"
}

main "$@"
