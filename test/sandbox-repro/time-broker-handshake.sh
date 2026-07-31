#!/usr/bin/env bash
# Times the SHIPPED MCP broker's cold boot inside the sandbox container (#2233).
#
# What decides the `handlePermission not found` race (#2201) is how long the
# broker takes to answer `initialize` after the CLI spawns it — not how long the
# process runs in total. Those are not the same number: measured natively on
# macOS the same handshake was ~1.1s to `initialize` and ~5.7s to process exit.
# #2201's "about 15 seconds" came from a whole smoke test's duration (15872ms),
# which is why #2233 exists.
#
# Two runs, one container: the first reads the bind mount cold, the second finds
# the page cache hot. Production spawns a fresh container per turn but the HOST
# cache survives, so `warm` models turn 2 onward — and the gap between them is
# how much of the boot is filesystem rather than the import graph itself, which
# is what picks between #2235's two candidate fixes.
#
# Usage (inside the container, `/repro` = test/sandbox-repro):
#   bash /repro/time-broker-handshake.sh <broker-command> [args...]
#
# Emits `TIMING <run> <event> <ms>` lines on stdout alongside the broker's own
# JSON-RPC output, which the caller parses. Reports only — never gates.

set -uo pipefail

HANDSHAKE_FILE=/repro/mcp-handshake.jsonl

now_ms() { date +%s%3N; }

# `%3N` is GNU-only. On a date that lacks it the value keeps a literal "N" and
# every subtraction below would fail — loudly here beats reporting nonsense.
if [[ "$(now_ms)" == *N* ]]; then
  echo "FATAL: this date(1) does not support %3N, cannot measure milliseconds" >&2
  exit 1
fi

if [[ ! -r "$HANDSHAKE_FILE" ]]; then
  echo "FATAL: $HANDSHAKE_FILE is not readable — is test/sandbox-repro mounted at /repro?" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  echo "FATAL: no broker command given" >&2
  exit 1
fi

# Feeds the handshake to the broker and stamps each response as it arrives.
# The elapsed clock starts at spawn, so it measures exactly the window the CLI
# is waiting through.
#
# Responses are recognised by JSON-RPC id, not by their contents: the fixture
# assigns id 1 to `initialize` and id 2 to `tools/list`, so a reply that arrives
# but is missing `serverInfo` / `handlePermission` still gets timed. Keying on
# the contents would drop the measurement in exactly the #2052 case where the
# reply comes back without the tool — the run worth measuring most.
#
# Whether those contents were there is reported separately, as a per-run RESULT
# line, so the caller can gate each run on its own rather than on the two runs
# smeared together.
run_handshake() {
  local run_label="$1"
  shift
  local started_ms
  started_ms=$(now_ms)
  # shellcheck disable=SC2002  # `cat |` keeps the broker's stdin a pipe, which
  # is what the CLI hands it; a `<` redirect would give it a seekable file.
  # The trailing block keeps the flags and the summary line in one subshell —
  # a bare `while` at the end of a pipeline cannot export what it saw.
  cat "$HANDSHAKE_FILE" | "$@" | {
    saw_server_info=no
    saw_handle_permission=no
    while IFS= read -r line; do
      elapsed_ms=$(($(now_ms) - started_ms))
      case "$line" in
      *'"id":1'* | *'"id": 1'*)
        echo "TIMING $run_label initialize $elapsed_ms"
        case "$line" in *serverInfo*) saw_server_info=yes ;; esac
        ;;
      *'"id":2'* | *'"id": 2'*)
        echo "TIMING $run_label tools_list $elapsed_ms"
        case "$line" in *'"name":"handlePermission"'*) saw_handle_permission=yes ;; esac
        ;;
      esac
      printf '%s\n' "$line"
    done
    echo "RESULT $run_label serverInfo=$saw_server_info handlePermission=$saw_handle_permission"
  }
}

run_handshake cold "$@"
run_handshake warm "$@"
