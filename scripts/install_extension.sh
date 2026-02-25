#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${TMPDIR:-/tmp}/windsurf-api-install-extension.log"
PACKAGE_SCRIPT=""
EXTENSION_NAME=""
EXTENSION_PUBLISHER=""
EXTENSION_VERSION=""
EXPECTED_NAME_LOWER=""
EXPECTED_IDS=()
VERIFICATION_METHOD=""
ALLOW_RUNNING=0

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

print_usage() {
  cat <<'EOF'
Usage: scripts/install_extension.sh [options]

Options:
  --allow-running   Skip the Windsurf running-process preflight check.
  -h, --help        Show this help message.
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --allow-running)
        ALLOW_RUNNING=1
        shift
        ;;
      -h|--help)
        print_usage
        exit 0
        ;;
      *)
        fail_with_solution \
          "Unknown argument: $1" \
          "Run \`scripts/install_extension.sh --help\` for supported options."
        ;;
    esac
  done
}

to_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
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

has_reinstall_requires_restart_error() {
  local log_file="$1"
  grep -Eq 'restart Windsurf before reinstalling|Please restart Windsurf before reinstalling' "$log_file"
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
  EXTENSION_VERSION="$(get_package_field "version")"

  if [[ -z "$EXTENSION_NAME" ]]; then
    fail_with_solution \
      "package.json is missing extension name." \
      "Add a valid name field to package.json and retry."
  fi

  EXPECTED_NAME_LOWER="$(to_lower "$EXTENSION_NAME")"
  build_expected_extension_ids
}

build_expected_extension_ids() {
  EXPECTED_IDS=()

  if [[ -n "$EXTENSION_PUBLISHER" ]]; then
    EXPECTED_IDS+=("$(to_lower "$EXTENSION_PUBLISHER.$EXTENSION_NAME")")
  fi

  # Windsurf CLI commonly shows unpacked extensions without a publisher.
  EXPECTED_IDS+=("$(to_lower "undefined_publisher.$EXTENSION_NAME")")
  EXPECTED_IDS+=("$EXPECTED_NAME_LOWER")
}

expected_id_summary() {
  local IFS=', '
  printf '%s' "${EXPECTED_IDS[*]}"
}

ensure_windsurf_cli_usable() {
  log "Checking Windsurf CLI availability."
  if windsurf --version >>"$LOG_FILE" 2>&1; then
    return
  fi

  fail_with_solution \
    "Windsurf CLI command exists but failed to run." \
    "Run \`windsurf --version\` manually, fix the CLI/runtime issue, then re-run this script."
}

ensure_windsurf_not_running() {
  if [[ "$ALLOW_RUNNING" -eq 1 ]]; then
    warn "Skipping Windsurf running-process check because --allow-running was provided."
    return
  fi

  if ! command_exists pgrep; then
    warn "Skipping running-process check: pgrep is unavailable on this system."
    return
  fi

  local process_output=""
  local process_status=0

  set +e
  process_output="$(pgrep -af "Windsurf|\\.codeium/windsurf/bin/windsurf" 2>/dev/null)"
  process_status=$?
  set -e

  if [[ "$process_status" -eq 0 && -n "$process_output" ]]; then
    warn "Detected Windsurf-related processes:"
    printf '%s\n' "$process_output" >&2
    fail_with_solution \
      "Windsurf appears to still be running (or partially running)." \
      "Quit Windsurf completely (Cmd+Q), wait a few seconds, then re-run this script. If needed, run \`pkill -f \"Windsurf|codeium/windsurf\"\` and retry."
  fi

  if [[ "$process_status" -gt 1 ]]; then
    warn "Could not inspect running Windsurf processes via pgrep. Continuing."
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
  local expected latest
  if [[ -n "$EXTENSION_VERSION" ]]; then
    expected="$REPO_ROOT/${EXTENSION_NAME}-${EXTENSION_VERSION}.vsix"
    if [[ -f "$expected" ]]; then
      printf '%s' "$expected"
      return
    fi
  fi

  latest="$(ls -t "$REPO_ROOT"/*.vsix 2>/dev/null | head -1 || true)"
  printf '%s' "$latest"
}

install_extension_with_windsurf() {
  local vsix_path="$1"
  log "Installing extension via windsurf --install-extension."

  if ! windsurf --install-extension "$vsix_path" --force >>"$LOG_FILE" 2>&1; then
    if has_reinstall_requires_restart_error "$LOG_FILE"; then
      print_log_tail
      fail_with_solution \
        "Windsurf reported that a restart is required before reinstalling the extension." \
        "Fully quit Windsurf (including background helper processes), then re-run this script. You can use \`pkill -f \"Windsurf|codeium/windsurf\"\` if needed."
    fi

    print_log_tail
    fail_with_solution \
      "Failed to install VSIX through windsurf CLI." \
      'Run `windsurf --install-extension "<path-to-vsix>" --force` manually and review the CLI output.'
  fi
}

matches_extension_list_id() {
  local base="$1"
  local expected_id

  for expected_id in "${EXPECTED_IDS[@]}"; do
    if [[ "$base" == "$expected_id" ]]; then
      return 0
    fi
  done

  if [[ "$base" == *".$EXPECTED_NAME_LOWER" ]]; then
    return 0
  fi

  return 1
}

matches_extension_folder_name() {
  local folder="$1"
  local expected_id

  for expected_id in "${EXPECTED_IDS[@]}"; do
    if [[ "$folder" == "$expected_id" || "$folder" == "$expected_id"-* ]]; then
      return 0
    fi
  done

  if [[ "$folder" == *".$EXPECTED_NAME_LOWER" || "$folder" == *".$EXPECTED_NAME_LOWER"-* ]]; then
    return 0
  fi

  return 1
}

verify_extension_in_list_output() {
  local installed_raw="$1"
  local normalized line base

  normalized="$(printf '%s\n' "$installed_raw" | awk '/^[A-Za-z0-9._-]+(@[A-Za-z0-9._+-]+)?$/ {print tolower($0)}')"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    base="${line%@*}"

    if matches_extension_list_id "$base"; then
      VERIFICATION_METHOD="windsurf --list-extensions"
      log "Verified extension installation via windsurf CLI: $base"
      return 0
    fi
  done <<< "$normalized"

  return 1
}

verify_extension_on_disk() {
  local extensions_dir="${WINDSURF_EXTENSIONS_DIR:-$HOME/.windsurf/extensions}"
  local dir base lower

  if [[ ! -d "$extensions_dir" ]]; then
    warn "Windsurf extensions directory was not found: $extensions_dir"
    return 1
  fi

  while IFS= read -r dir; do
    base="$(basename "$dir")"
    lower="$(to_lower "$base")"
    if matches_extension_folder_name "$lower"; then
      VERIFICATION_METHOD="filesystem ($extensions_dir)"
      log "Verified extension installation from filesystem: $dir"
      return 0
    fi
  done < <(find "$extensions_dir" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)

  warn "No matching extension folder found in $extensions_dir"
  return 1
}

verify_extension_installed() {
  local installed_raw=""
  local list_failed=0

  if installed_raw="$(windsurf --list-extensions 2>>"$LOG_FILE")"; then
    if verify_extension_in_list_output "$installed_raw"; then
      return
    fi

    warn "Extension not found in \`windsurf --list-extensions\` output. Falling back to filesystem verification."
  else
    list_failed=1
    warn "\`windsurf --list-extensions\` failed. Falling back to filesystem verification."
    print_log_tail
  fi

  if verify_extension_on_disk; then
    if [[ $list_failed -eq 1 ]]; then
      warn "Windsurf CLI listing failed, but extension is installed on disk."
    fi
    return
  fi

  if [[ $list_failed -eq 1 ]]; then
    fail_with_solution \
      "Could not verify extension installation because \`windsurf --list-extensions\` failed and no matching extension folder was found." \
      "Run \`windsurf --list-extensions\` manually, then check \`$HOME/.windsurf/extensions\` for one of: $(expected_id_summary)"
  fi

  fail_with_solution \
    "Extension does not appear to be installed after running \`windsurf --install-extension\`." \
    "Check \`windsurf --list-extensions\`, then reinstall the VSIX if needed."
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
  local verification_summary="$VERIFICATION_METHOD"

  if [[ -z "$verification_summary" ]]; then
    verification_summary="unknown method"
  fi

  cat <<EOF
Automated steps completed:
- Built extension package: $vsix_path
- Installed extension via windsurf CLI.
- Verified extension installation using: $verification_summary.

These steps cannot be fully automated from this shell:
1. If Windsurf is already open, reload Windsurf to ensure command registration is refreshed.
2. In Windsurf Command Palette, run:
   Windsurf API: Start Server

Note:
- Command Palette execution cannot be triggered from this script because no supported CLI flag is exposed for running extension commands directly.
EOF
}

main() {
  : >"$LOG_FILE"
  parse_args "$@"

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
  ensure_windsurf_cli_usable
  ensure_windsurf_not_running
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
