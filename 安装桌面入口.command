#!/bin/zsh
set -e
cd "${0:A:h}"
python3 -B scripts/setup_importers.py --ensure
.venv/bin/python -B scripts/install_background_service.py --open
