#!/bin/bash
set -euo pipefail
exec "$(dirname "$0")/build-app.sh" "$@"
