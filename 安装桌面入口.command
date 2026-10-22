#!/bin/zsh
set -e
cd "${0:A:h}"
python3 -B scripts/install_background_service.py --open
