#!/usr/bin/env bash
# Stable shell wrapper; health-check logic lives in doctor.cjs.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/doctor.cjs" "$@"
