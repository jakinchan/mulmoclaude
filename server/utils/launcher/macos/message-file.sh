#!/bin/sh
# Picks the localized text file for the native "Node.js is missing" alert.
#
# Sourced by launch.sh; also exercised directly by
# test/utils/launcher/test_messageFile.ts.
#
# Same two steps as pickLauncherLocale() in ../messages.mjs — the whole
# tag, then the language subtag — because AppleLocale is not always
# `ja_JP`. A Simplified Chinese system reports `zh-Hans_US`, so cutting
# at the `_` alone left `zh-Hans`, which ships no file: the one screen
# that cannot be a web page fell back to English for the users who need
# it most.

mc_message_file() {
  messages_dir=$1
  raw_locale=$2

  # Region is `_`-separated, script subtags are `-`: `zh-Hans_US` has both.
  tagged=$raw_locale
  case "$raw_locale" in *_*) tagged="${raw_locale%%_*}-${raw_locale#*_}" ;; esac
  language=${tagged%%-*}

  for candidate in "$tagged" "$language"; do
    # AppleLocale reaches us as a path component, so anything that is not
    # a plain language tag is refused rather than resolved.
    case "$candidate" in
      "" | *[!A-Za-z0-9-]*) continue ;;
    esac
    if [ -f "$messages_dir/$candidate.txt" ]; then
      echo "$messages_dir/$candidate.txt"
      return 0
    fi
  done

  echo "$messages_dir/en.txt"
}
