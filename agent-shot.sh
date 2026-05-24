#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
agent-shot.sh - capture a screenshot for terminal-based coding agents

Usage:
  ./agent-shot.sh              Capture and copy the image path
  ./agent-shot.sh --prompt     Capture and copy a ready-to-send prompt
  ./agent-shot.sh --markdown   Capture and copy Markdown image syntax
  ./agent-shot.sh --reveal     Capture, copy path, and reveal in Finder

Environment:
  AGENT_SHOT_DIR=/path/to/dir  Override screenshot output directory
EOF
}

copy_to_clipboard() {
  printf '%s' "$1" | pbcopy
}

mode="path"
reveal="false"

case "${1:-}" in
  ""|--path|-p)
    mode="path"
    ;;
  --prompt)
    mode="prompt"
    ;;
  --markdown|-m)
    mode="markdown"
    ;;
  --reveal)
    mode="path"
    reveal="true"
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    usage >&2
    exit 2
    ;;
esac

out_dir="${AGENT_SHOT_DIR:-$HOME/Pictures/AgentShots/$(date +%Y-%m-%d)}"
mkdir -p "$out_dir"

stamp="$(date +%H%M%S)"
file="$out_dir/shot-$stamp.png"

echo "Select a region or window. Press Esc to cancel."
screencapture -i "$file"

if [[ ! -s "$file" ]]; then
  rm -f "$file"
  echo "No screenshot captured."
  exit 1
fi

case "$mode" in
  path)
    clipboard="$file"
    ;;
  prompt)
    clipboard="Please inspect this screenshot: $file"
    ;;
  markdown)
    clipboard="![screenshot]($file)"
    ;;
esac

copy_to_clipboard "$clipboard"

if [[ "$reveal" == "true" ]]; then
  open -R "$file"
fi

osascript -e 'display notification "Screenshot path copied to clipboard" with title "Agent Shot"' >/dev/null 2>&1 || true

echo "Saved:  $file"
echo "Copied: $clipboard"
