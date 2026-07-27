#!/bin/sh
# Executable of the generated MulmoClaude.app bundle.
#
# Deliberately tiny: recover a usable PATH, find node, hand over. Every
# decision a user can see lives in the Node half (../Resources/utils/
# launcher/run.mjs), where there are real strings and a real UI.
#
# The one thing that MUST be handled here is "no node at all" — there is
# nothing left to render a page with, so it falls back to a native alert.

BUNDLE_MACOS_DIR=$(cd "$(dirname "$0")" && pwd)
RESOURCES_DIR=$(cd "$BUNDLE_MACOS_DIR/../Resources" && pwd)
LAUNCHER_DIR="$RESOURCES_DIR/utils/launcher"

. "$LAUNCHER_DIR/macos/resolve-path.sh"

PATH=$(mc_resolve_path)
export PATH

# Alert text is read from a file rather than interpolated into
# AppleScript source, and passed as `on run` arguments — no quoting of
# translated prose into two different languages' string literals.
#
# The download button is labelled with the bare domain so it needs no
# translation. It exists because this is the one screen that cannot be
# a web page — without node there is nothing to render one — and a URL
# someone has to retype by hand is a dead end for the exact user this
# launcher is for.
mc_alert_no_node() {
  locale=$(/usr/bin/defaults read -g AppleLocale 2>/dev/null | /usr/bin/cut -d_ -f1)
  file="$RESOURCES_DIR/messages/$locale.txt"
  [ -f "$file" ] || file="$RESOURCES_DIR/messages/en.txt"
  title=$(/usr/bin/head -1 "$file")
  body=$(/usr/bin/tail -n +2 "$file")
  /usr/bin/osascript \
    -e 'on run {t, m}' \
    -e 'set answer to display alert t message m as critical buttons {"OK", "nodejs.org"} default button 2' \
    -e 'if button returned of answer is "nodejs.org" then' \
    -e 'do shell script "open https://nodejs.org/"' \
    -e 'end if' \
    -e 'end run' \
    "$title" "$body" >/dev/null 2>&1
}

NODE_BIN=$(command -v node)
if [ -z "$NODE_BIN" ]; then
  mc_alert_no_node
  exit 1
fi

exec "$NODE_BIN" "$LAUNCHER_DIR/run.mjs"
