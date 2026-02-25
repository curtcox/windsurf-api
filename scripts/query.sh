#!/usr/bin/env bash
set -euo pipefail

SERVER_URL="http://localhost:47923"
TEXT=""
MODEL=""
MODE=""
CASCADE_ID=""
TIMEOUT_SECONDS=180
POLL_INTERVAL_SECONDS=2
PRINT_RAW=0
SUBMIT_FILE=""
RESPONSE_FILE=""
QUEUE_FILE=""

usage() {
  cat <<'EOF'
Usage:
  scripts/query.sh [options] "your prompt text"
  scripts/query.sh [options] --text "your prompt text"

Options:
  -t, --text TEXT            Prompt text to submit.
  -m, --model MODEL          Model label to request (matches GET /models output).
  -M, --mode MODE            Planner mode: default | read-only | no-tool | explore | planning | auto
  -c, --cascade-id ID        Reuse an existing cascade instead of creating a new one.
  -s, --server URL           API base URL. Default: http://localhost:47923
  -T, --timeout SECONDS      Max time to wait for final response. Default: 180
  -i, --interval SECONDS     Poll interval while waiting. Default: 2
      --raw                  Print final /response JSON as well.
  -h, --help                 Show this help text.
EOF
}

log() {
  printf '[INFO] %s\n' "$1"
}

warn() {
  printf '[WARN] %s\n' "$1"
}

fail() {
  printf '[ERROR] %s\n' "$1" >&2
  printf 'How to solve: %s\n' "$2" >&2
  exit 1
}

require_command() {
  local cmd="$1"
  local purpose="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Missing required command: $cmd ($purpose)." "Install $cmd and retry."
  fi
}

json_extract() {
  local file="$1"
  local path="$2"
  node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const keys = process.argv[2].split(".");
let value = data;
for (const key of keys) value = value?.[key];
if (value === undefined || value === null) process.exit(2);
if (typeof value === "object") {
  process.stdout.write(JSON.stringify(value));
} else {
  process.stdout.write(String(value));
}
' "$file" "$path" 2>/dev/null || true
}

build_payload() {
  node -e '
const payload = { text: process.argv[1] };
if (process.argv[2]) payload.model = process.argv[2];
if (process.argv[3]) payload.mode = process.argv[3];
if (process.argv[4]) payload.cascadeId = process.argv[4];
process.stdout.write(JSON.stringify(payload));
' "$TEXT" "$MODEL" "$MODE" "$CASCADE_ID"
}

is_positive_number() {
  [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk "BEGIN { exit !($1 > 0) }"
}

http_post_json() {
  local url="$1"
  local payload="$2"
  local output_file="$3"

  local http_code
  http_code="$(curl -sS -o "$output_file" -w "%{http_code}" \
    -X POST "$url" \
    -H "Content-Type: application/json" \
    --data "$payload")" || return 99

  printf '%s' "$http_code"
}

http_get_json() {
  local url="$1"
  local output_file="$2"

  local http_code
  http_code="$(curl -sS -o "$output_file" -w "%{http_code}" "$url")" || return 99
  printf '%s' "$http_code"
}

cleanup() {
  rm -f "${SUBMIT_FILE:-}" "${RESPONSE_FILE:-}" "${QUEUE_FILE:-}"
}

poll_queue_status() {
  local server_url="$1"
  local message_id="$2"
  local queue_file="$3"

  local queue_url
  queue_url="$server_url/queue/$(node -p "encodeURIComponent(process.argv[1])" "$message_id")"

  local queue_code
  queue_code="$(http_get_json "$queue_url" "$queue_file")" || return 99
  printf '%s' "$queue_code"
}

main() {
  trap cleanup EXIT

  require_command curl "calling the local windsurf-api server"
  require_command node "building/parsing JSON payloads"

  local -a positional=()

  while (($# > 0)); do
    case "$1" in
      -t|--text)
        (($# >= 2)) || fail "Missing value for $1." "Pass prompt text after $1."
        TEXT="$2"
        shift 2
        ;;
      -m|--model)
        (($# >= 2)) || fail "Missing value for $1." "Pass a model label after $1."
        MODEL="$2"
        shift 2
        ;;
      -M|--mode)
        (($# >= 2)) || fail "Missing value for $1." "Pass one of: default, read-only, no-tool, explore, planning, auto."
        MODE="$2"
        shift 2
        ;;
      -c|--cascade-id)
        (($# >= 2)) || fail "Missing value for $1." "Pass a cascade ID after $1."
        CASCADE_ID="$2"
        shift 2
        ;;
      -s|--server)
        (($# >= 2)) || fail "Missing value for $1." "Pass an API base URL after $1."
        SERVER_URL="$2"
        shift 2
        ;;
      -T|--timeout)
        (($# >= 2)) || fail "Missing value for $1." "Pass timeout seconds after $1."
        TIMEOUT_SECONDS="$2"
        shift 2
        ;;
      -i|--interval)
        (($# >= 2)) || fail "Missing value for $1." "Pass poll interval seconds after $1."
        POLL_INTERVAL_SECONDS="$2"
        shift 2
        ;;
      --raw)
        PRINT_RAW=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        shift
        while (($# > 0)); do
          positional+=("$1")
          shift
        done
        ;;
      -*)
        fail "Unknown option: $1" "Run scripts/query.sh --help to see supported options."
        ;;
      *)
        positional+=("$1")
        shift
        ;;
    esac
  done

  if [[ -z "$TEXT" && ${#positional[@]} -gt 0 ]]; then
    TEXT="${positional[*]}"
  fi

  [[ -n "$TEXT" ]] || fail "Prompt text is required." "Pass it as a positional argument or with --text."
  is_positive_number "$TIMEOUT_SECONDS" || fail "Invalid --timeout value: $TIMEOUT_SECONDS" "Use a number greater than 0."
  is_positive_number "$POLL_INTERVAL_SECONDS" || fail "Invalid --interval value: $POLL_INTERVAL_SECONDS" "Use a number greater than 0."

  if [[ -n "$MODE" ]]; then
    local mode_normalized
    mode_normalized="$(printf '%s' "$MODE" | tr '[:upper:]' '[:lower:]')"
    case "$mode_normalized" in
      default|read-only|readonly|read|no-tool|notool|chat|explore|planning|plan|auto)
        ;;
      *)
        fail "Unsupported --mode value: $MODE" "Use one of: default, read-only, no-tool, explore, planning, auto."
        ;;
    esac
  fi

  SERVER_URL="${SERVER_URL%/}"
  local post_url="$SERVER_URL/prompt"
  local payload
  payload="$(build_payload)"

  SUBMIT_FILE="$(mktemp)"

  log "Submitting prompt to $post_url"
  local submit_code
  submit_code="$(http_post_json "$post_url" "$payload" "$SUBMIT_FILE")" || {
    fail "Failed to reach $post_url." "Ensure the Windsurf API server is running (Windsurf API: Start Server) and retry."
  }

  if [[ "$submit_code" -lt 200 || "$submit_code" -ge 300 ]]; then
    local submit_error
    submit_error="$(json_extract "$SUBMIT_FILE" "error")"
    [[ -n "$submit_error" ]] || submit_error="$(cat "$SUBMIT_FILE")"
    fail "Prompt submission failed (HTTP $submit_code): $submit_error" "Check server logs and verify request flags (model/mode/cascadeId)."
  fi

  local submit_status cascade_id message_id
  submit_status="$(json_extract "$SUBMIT_FILE" "status")"
  cascade_id="$(json_extract "$SUBMIT_FILE" "cascadeId")"
  message_id="$(json_extract "$SUBMIT_FILE" "messageId")"

  [[ -n "$cascade_id" ]] || fail "Server response did not include cascadeId." "Verify the API server is up to date and retry."

  if [[ -n "$submit_status" ]]; then
    log "Message accepted: status=$submit_status cascadeId=$cascade_id${message_id:+ messageId=$message_id}"
  fi

  local poll_target
  if [[ -n "$message_id" ]]; then
    poll_target="$SERVER_URL/response?messageId=$(node -p "encodeURIComponent(process.argv[1])" "$message_id")"
  else
    poll_target="$SERVER_URL/response?cascadeId=$(node -p "encodeURIComponent(process.argv[1])" "$cascade_id")"
  fi

  # Capture baseline response so we can detect when a new answer arrives,
  # including runtimes that never flip status back to IDLE.
  local baseline_file baseline_code baseline_output_id baseline_step_index baseline_response
  baseline_file="$(mktemp)"
  baseline_output_id=""
  baseline_step_index=""
  baseline_response=""
  baseline_code="$(http_get_json "$SERVER_URL/response?cascadeId=$(node -p "encodeURIComponent(process.argv[1])" "$cascade_id")" "$baseline_file" || true)"
  if [[ -n "$baseline_code" && "$baseline_code" -ge 200 && "$baseline_code" -lt 300 ]]; then
    baseline_output_id="$(json_extract "$baseline_file" "outputId")"
    baseline_step_index="$(json_extract "$baseline_file" "stepIndex")"
    baseline_response="$(json_extract "$baseline_file" "response")"
  fi
  rm -f "$baseline_file"

  local start_ts elapsed
  start_ts="$(date +%s)"
  RESPONSE_FILE="$(mktemp)"
  local queue_status queue_error queue_position
  QUEUE_FILE="$(mktemp)"

  local last_queue_status=""
  local last_output_id=""

  while true; do
    local poll_code
    poll_code="$(http_get_json "$poll_target" "$RESPONSE_FILE")" || {
      fail "Polling failed for $poll_target." "Check that the server is still running and retry."
    }

    if [[ "$poll_code" -lt 200 || "$poll_code" -ge 300 ]]; then
      local poll_error
      poll_error="$(json_extract "$RESPONSE_FILE" "error")"
      [[ -n "$poll_error" ]] || poll_error="$(cat "$RESPONSE_FILE")"
      fail "Polling failed (HTTP $poll_code): $poll_error" "Inspect server output and retry."
    fi

    local ready status response_text
    ready="$(json_extract "$RESPONSE_FILE" "ready")"
    status="$(json_extract "$RESPONSE_FILE" "status")"
    response_text="$(json_extract "$RESPONSE_FILE" "response")"
    local output_id step_index
    output_id="$(json_extract "$RESPONSE_FILE" "outputId")"
    step_index="$(json_extract "$RESPONSE_FILE" "stepIndex")"

    queue_status=""
    queue_error=""
    queue_position=""
    if [[ -n "$message_id" ]]; then
      local queue_code
      queue_code="$(poll_queue_status "$SERVER_URL" "$message_id" "$QUEUE_FILE")" || {
        fail "Queue status polling failed for messageId=$message_id." "Check that the server is still running and retry."
      }
      if [[ "$queue_code" -ge 200 && "$queue_code" -lt 300 ]]; then
        queue_status="$(json_extract "$QUEUE_FILE" "status")"
        queue_error="$(json_extract "$QUEUE_FILE" "error")"
        queue_position="$(json_extract "$QUEUE_FILE" "queuePosition")"
      fi
    fi

    if [[ "$queue_status" == "error" ]]; then
      [[ -n "$queue_error" ]] || queue_error="Unknown queue error"
      fail "Prompt failed before completion: $queue_error" "Try again with a different model/mode, or inspect Windsurf logs for cascade errors."
    fi

    local has_response="false"
    if [[ -n "$response_text" ]]; then
      has_response="true"
    fi

    # Primary completion signal.
    if [[ "$ready" == "true" && "$has_response" == "true" ]]; then
      printf '\n%s\n' "$response_text"
      if [[ "$PRINT_RAW" -eq 1 ]]; then
        printf '\n[RAW RESPONSE]\n'
        cat "$RESPONSE_FILE"
        printf '\n'
      fi
      return 0
    fi

    # Fallback completion signal for runtimes that keep status non-idle.
    # Return when we observe a new response output after submission.
    if [[ "$has_response" == "true" ]]; then
      local output_changed="false"
      local step_changed="false"

      if [[ -n "$output_id" && "$output_id" != "$baseline_output_id" ]]; then
        output_changed="true"
      fi
      if [[ -n "$step_index" && "$step_index" != "$baseline_step_index" ]]; then
        step_changed="true"
      fi
      if [[ -z "$baseline_output_id" && -z "$baseline_response" ]]; then
        output_changed="true"
      fi

      if [[ "$output_changed" == "true" || "$step_changed" == "true" ]]; then
        warn "Returning latest response even though ready=$ready (runtime did not report idle)."
        printf '\n%s\n' "$response_text"
        if [[ "$PRINT_RAW" -eq 1 ]]; then
          printf '\n[RAW RESPONSE]\n'
          cat "$RESPONSE_FILE"
          printf '\n'
        fi
        return 0
      fi
    fi

    elapsed="$(( $(date +%s) - start_ts ))"
    if awk "BEGIN { exit !($elapsed >= $TIMEOUT_SECONDS) }"; then
      warn "Last poll payload:"
      cat "$RESPONSE_FILE" >&2
      printf '\n' >&2
      if [[ -n "$message_id" ]]; then
        warn "Last queue payload:"
        cat "$QUEUE_FILE" >&2
        printf '\n' >&2
      fi
      fail \
        "Timed out after ${TIMEOUT_SECONDS}s waiting for a final response." \
        "Retry with a longer timeout (--timeout), or check $SERVER_URL/status?cascadeId=$cascade_id and $SERVER_URL/queue/${message_id:-<message-id>}."
    fi

    if [[ -n "$queue_status" ]]; then
      if [[ "$queue_status" != "$last_queue_status" ]]; then
        log "Queue status for messageId=$message_id: ${queue_status}${queue_position:+ (position=$queue_position)}"
        last_queue_status="$queue_status"
      fi
      log "Waiting for final response (elapsed=${elapsed}s, status=${status:-unknown}, ready=${ready:-false}, queue=${queue_status})"
    else
      log "Waiting for final response (elapsed=${elapsed}s, status=${status:-unknown}, ready=${ready:-false})"
    fi

    if [[ -n "$output_id" && "$output_id" != "$last_output_id" ]]; then
      log "Observed outputId change: $output_id"
      last_output_id="$output_id"
    fi

    sleep "$POLL_INTERVAL_SECONDS"
  done
}

main "$@"
