#!/bin/bash
# Bundle the extension files into a single markdown document for upload
# to Claude Design (or any other agent) to review the visual / UI code.
#
# Output: tab-out-extension-snapshot.md in this directory.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT="$ROOT/extension"
OUT="$ROOT/tab-out-extension-snapshot.md"

cat > "$OUT" <<'HEADER'
# Tab Out Mission — Snapshot for Visual / UI Design Review

A Chrome extension that replaces the New Tab page with a tab-management
dashboard. The user is asking for a visual design audit — typography,
spacing, color, hierarchy, focus states, the works. They are NOT asking
for refactoring of behavior or product features.

## Project structure

```
extension/
├── manifest.json     ← MV3 manifest (permissions, commands, NTP override)
├── index.html        ← New Tab page entry point
├── style.css         ← All visual styles (the main subject of review)
├── app.js            ← Dashboard logic (tabs, missions, action panel)
├── background.js     ← Service worker
└── icons/            ← (binary, not included)
```

Below: each text file inline as a fenced block, in load order.

---

HEADER

emit_file() {
  local relpath="$1"
  local lang="$2"
  local fullpath="$ROOT/$relpath"
  if [ ! -f "$fullpath" ]; then
    echo "## \`$relpath\` (missing)" >> "$OUT"
    echo "" >> "$OUT"
    return
  fi
  echo "## \`$relpath\`" >> "$OUT"
  echo "" >> "$OUT"
  echo "\`\`\`$lang" >> "$OUT"
  cat "$fullpath" >> "$OUT"
  echo "" >> "$OUT"
  echo "\`\`\`" >> "$OUT"
  echo "" >> "$OUT"
}

emit_file "AGENTS.md" "markdown"
emit_file "README.md" "markdown"
emit_file "extension/manifest.json" "json"
emit_file "extension/index.html" "html"
emit_file "extension/style.css" "css"
emit_file "extension/app.js" "javascript"
emit_file "extension/background.js" "javascript"

echo "Snapshot written: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
