#!/usr/bin/env bash
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-isolation.cjs" "$@"
