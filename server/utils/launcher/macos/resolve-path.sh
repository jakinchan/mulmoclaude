#!/bin/sh
# PATH recovery for a GUI-launched process (Finder double-click / launchd).
#
# A GUI launch gets PATH=/usr/bin:/bin:/usr/sbin:/sbin and nothing else —
# `launchctl getenv PATH` is empty, so every version manager (nodebrew,
# nvm, fnm, asdf, volta) AND Apple-Silicon Homebrew are missing. This
# runs BEFORE node is found, so it has to be shell.
#
# Sourced by launch.sh; also exercised directly by
# test/utils/launcher/test_resolvePath.ts.

# A login shell that also reads the interactive rc. `-l` alone is NOT
# enough and is actively harmful: version managers and `~/.local/bin`
# are wired up in `.zshrc`, which a non-interactive login shell skips.
# Measured on a nodebrew box: `-l` resolved Homebrew's node v26.3.0 and
# failed to find `claude` at all, while the user's real toolchain was
# nodebrew v24.12.0 — i.e. `-l` alone tells a user with Claude Code
# installed that they need to install it. `-l -i` matches the terminal.
MC_HOP_TIMEOUT_S=10
MC_MARK_BEGIN='__MC_PATH_BEGIN__'
MC_MARK_END='__MC_PATH_END__'

# The login shell per Directory Services. $SHELL is unset or stale under
# launchd, so it can't be trusted here.
mc_login_shell() {
  shell=$(/usr/bin/dscl . -read "$HOME" UserShell 2>/dev/null | /usr/bin/awk '{print $2}')
  if [ -x "$shell" ]; then
    echo "$shell"
  else
    echo /bin/zsh
  fi
}

# macOS ships no timeout(1). Run "$@" with a watchdog that kills it after
# $1 seconds, and print whatever it managed to write.
#
# The `>/dev/null` on the watchdog is load-bearing: without it the `sleep`
# inherits the caller's stdout pipe, so a command substitution around this
# function blocks for the FULL timeout even when the work finished in
# 400ms. (A `perl -e 'alarm N; exec @ARGV'` wrapper has the same defect
# and cannot be fixed — the shell's own children keep the pipe open.)
_mc_run_with_timeout() {
  timeout_s=$1
  shift
  outfile=$(/usr/bin/mktemp "${TMPDIR:-/tmp}/mulmoclaude-hop.XXXXXX") || return 1
  "$@" >"$outfile" 2>/dev/null &
  child=$!
  (sleep "$timeout_s"; kill -9 "$child" 2>/dev/null) >/dev/null 2>&1 &
  watchdog=$!
  wait "$child" 2>/dev/null
  rc=$?
  kill "$watchdog" 2>/dev/null
  cat "$outfile"
  rm -f "$outfile"
  return $rc
}

# Reaping the watchdog makes the shell announce `Terminated: 15 (sleep …)`
# on stderr. Harmless, but the launcher tells the user where its log is,
# and a log that opens with a scary-looking kill notice is exactly the
# kind of thing that makes a beginner stop. Swallow it here rather than
# at every call site.
mc_run_with_timeout() {
  (_mc_run_with_timeout "$@") 2>/dev/null
}

# Ask the login shell for its PATH. Sentinels because rc files print
# banners (and worse) on both stdout and stderr — one machine in testing
# emitted an ssh-agent warning on every interactive shell.
mc_login_path() {
  shell=$(mc_login_shell)
  mc_run_with_timeout "$MC_HOP_TIMEOUT_S" \
    "$shell" -l -i -c "echo $MC_MARK_BEGIN; echo \"\$PATH\"; echo $MC_MARK_END" |
    /usr/bin/sed -n "/$MC_MARK_BEGIN/,/$MC_MARK_END/p" |
    /usr/bin/grep -v "$MC_MARK_BEGIN\|$MC_MARK_END" |
    /usr/bin/head -1
}

# Last resort when the shell hop yields nothing (exotic shell, rc file
# that hangs past the watchdog, corporate lockdown). Prints every
# directory that holds either tool, newline-separated.
#
# Both tools, not just node: Claude Code installs to `~/.local/bin`,
# which usually has no node in it. Scanning for node alone recovers a
# working node and then reports "Claude Code is not installed" to a user
# who has it — the single worst outcome for this launcher.
mc_scan_tool_dirs() {
  for dir in \
    "$HOME/.nodebrew/current/bin" \
    "$HOME/.volta/bin" \
    "$HOME/.local/bin" \
    /opt/homebrew/bin \
    /usr/local/bin
  do
    if [ -x "$dir/node" ] || [ -x "$dir/claude" ]; then echo "$dir"; fi
  done
  # Version managers keep each release in its own directory; take the
  # last match so the newest install wins a plain lexical sort.
  for pattern in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.asdf/installs/nodejs/*/bin/node
  do
    [ -x "$pattern" ] && echo "${pattern%/node}"
  done
}

# Prints the PATH the launcher should run everything under. Falls back
# from the shell hop to a directory scan, and always keeps the inherited
# entries so /usr/bin utilities stay reachable.
mc_resolve_path() {
  hopped=$(mc_login_path)
  if [ -n "$hopped" ]; then
    echo "$hopped:$PATH"
    return 0
  fi
  scanned=$(mc_scan_tool_dirs | /usr/bin/tr '\n' ':')
  echo "$scanned$PATH"
}
