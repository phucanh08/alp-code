#!/usr/bin/env bash
# Wrapper giữ nguyên CLI. Logic ở alp.cjs.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/alp.cjs" "$@"
