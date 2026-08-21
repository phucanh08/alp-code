#!/usr/bin/env bash
# Wrapper giữ nguyên CLI đã ghi trong CHARTER/README. Logic ở doctor.cjs.
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/doctor.cjs" "$@"
