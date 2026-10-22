#!/bin/zsh
set -e
cd "${0:A:h}"
python3 -B scripts/serve.py --port 8787 --open
