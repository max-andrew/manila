#!/usr/bin/env bash
# Re-render the architecture diagrams (docs/ARCHITECTURE.md) to PNG.
# Uses the system Chrome so no Chromium download is needed.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CFG=$(mktemp)
printf '{"args":["--no-sandbox"],"executablePath":"%s"}' "$CHROME" > "$CFG"

python3 - <<'PY'
import re
src = open('docs/ARCHITECTURE.md').read()
blocks = re.findall(r'```mermaid\n(.*?)```', src, re.S)
open('docs/diagrams/system.mmd','w').write(blocks[0])
open('docs/diagrams/rsu-oracle.mmd','w').write(blocks[1])
PY

npx -y @mermaid-js/mermaid-cli -p "$CFG" -t neutral -b white -i docs/diagrams/system.mmd -o docs/diagrams/system.png
npx -y @mermaid-js/mermaid-cli -p "$CFG" -t neutral -b white -i docs/diagrams/rsu-oracle.mmd -o docs/diagrams/rsu-oracle.png
echo "rendered docs/diagrams/{system,rsu-oracle}.png"
