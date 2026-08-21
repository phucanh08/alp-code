#!/usr/bin/env bash
#
# sync-project-index.sh — kiểm soát Project Layer bằng `modified`.
#
# Quét frontmatter của mọi L1 card (memory/projects/<slug>/PROJECT.md), so sánh với L0
# (memory/projects/INDEX.md) và với mtime của filesystem, rồi báo ba tín hiệu:
#
#   DRIFT   mtime > updated       → file bị sửa mà chưa đóng dấu `updated`
#   STALE   ACTIVE, quá N ngày    → khai đang chạy nhưng không ai đụng tới
#   ORPHAN  L1 ⟷ L0 lệch nhau     → card không có dòng index, hoặc ngược lại
#
# Dùng:
#   sync-project-index.sh            # chỉ báo cáo (mặc định, không ghi gì)
#   sync-project-index.sh --write    # sinh lại bảng L0 từ frontmatter L1
#   STALE_DAYS=30 sync-project-index.sh
#
# Exit: 0 mọi thứ khớp · 1 có tín hiệu cần xử lý · 2 lỗi cấu hình
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECTS_DIR="$ROOT/memory/projects"
INDEX_FILE="$PROJECTS_DIR/INDEX.md"
STALE_DAYS="${STALE_DAYS:-14}"
WRITE=0

[[ "${1:-}" == "--write" ]] && WRITE=1
[[ -f "$INDEX_FILE" ]] || { echo "Không thấy $INDEX_FILE" >&2; exit 2; }

TODAY_EPOCH=$(date +%s)

# Đọc một khoá từ YAML frontmatter (khối --- đầu tiên của file).
read_fm() {
  awk -v key="$2" '
    /^---[[:space:]]*$/ { if (seen) exit; seen = 1; next }
    seen && $0 ~ "^" key ":" {
      sub("^" key ":[[:space:]]*", "")
      gsub(/^["'"'"']|["'"'"']$/, "")
      sub(/[[:space:]]+$/, "")
      print
      exit
    }
  ' "$1"
}

# YYYY-MM-DD → epoch. BSD date (macOS).
date_to_epoch() { date -j -f "%Y-%m-%d" "$1" "+%s" 2>/dev/null || echo 0; }

issues=0
active_rows=""
done_rows=""
all_slugs=()

shopt -s nullglob
for card in "$PROJECTS_DIR"/*/PROJECT.md; do
  dir="$(dirname "$card")"
  dirname_slug="$(basename "$dir")"
  [[ "$dirname_slug" == _* ]] && continue   # bỏ qua _template

  slug="$(read_fm "$card" slug)"
  status="$(read_fm "$card" status)"
  priority="$(read_fm "$card" priority)"
  summary="$(read_fm "$card" summary)"
  updated="$(read_fm "$card" updated)"

  # --- frontmatter thiếu hoặc sai ---
  for field in slug status priority summary updated; do
    if [[ -z "${!field}" ]]; then
      echo "MISSING  $dirname_slug — thiếu \`$field:\` trong frontmatter"
      issues=$((issues + 1))
    fi
  done
  [[ -z "$slug" || -z "$updated" ]] && continue

  if [[ "$slug" != "$dirname_slug" ]]; then
    echo "MISMATCH $dirname_slug — slug frontmatter là '$slug', không khớp tên thư mục"
    issues=$((issues + 1))
  fi

  # --- DRIFT: file bị chạm sau lần đóng dấu cuối ---
  mtime_date="$(date -r "$card" "+%Y-%m-%d")"
  updated_epoch="$(date_to_epoch "$updated")"
  mtime_epoch="$(date_to_epoch "$mtime_date")"
  if (( mtime_epoch > updated_epoch )); then
    echo "DRIFT    $slug — sửa $mtime_date nhưng updated: $updated → đọc lại rồi đóng dấu"
    issues=$((issues + 1))
  fi

  # --- STALE: khai ACTIVE mà lâu không đụng ---
  if [[ "$status" == "ACTIVE" ]]; then
    age_days=$(( (TODAY_EPOCH - updated_epoch) / 86400 ))
    if (( age_days > STALE_DAYS )); then
      echo "STALE    $slug — ACTIVE nhưng $age_days ngày không cập nhật (ngưỡng $STALE_DAYS)"
      issues=$((issues + 1))
    fi
  fi

  all_slugs+=("$slug")
  if [[ "$status" == "DONE" ]]; then
    done_rows+="| $slug | $priority | $summary | $updated |"$'\n'
  else
    active_rows+="$priority	$slug	| $slug | $priority | $status | $summary | $updated |"$'\n'
  fi
done
shopt -u nullglob

# --- sinh lại bảng L0 (làm trước, để ORPHAN kiểm tra trên bản mới nhất) ---
if (( WRITE )); then
  # sắp xếp cố định: priority rồi slug — để L0 ổn định byte giữa các lần chạy
  active_tbl="$(mktemp)"; done_tbl="$(mktemp)"
  trap 'rm -f "$active_tbl" "$done_tbl"' EXIT

  {
    echo "| Slug | P | Trạng thái | Tóm tắt | Cập nhật |"
    echo "|---|---|---|---|---|"
    if [[ -n "$active_rows" ]]; then
      printf '%s' "$active_rows" | sort -t'	' -k1,1 -k2,2 | cut -f3-
    else
      echo "| _(chưa có)_ | | | | |"
    fi
  } > "$active_tbl"

  if [[ -n "$done_rows" ]]; then
    { echo "| Slug | P | Tóm tắt | Đóng ngày |"
      echo "|---|---|---|---|"
      printf '%s' "$done_rows" | sort
    } > "$done_tbl"
  else
    echo "_(chưa có)_" > "$done_tbl"
  fi

  tmp="$(mktemp)"
  awk -v active_f="$active_tbl" -v done_f="$done_tbl" '
    function emit(f,   line) { while ((getline line < f) > 0) print line; close(f) }
    /<!-- BEGIN:INDEX -->/ { print; emit(active_f); skip = 1; next }
    /<!-- END:INDEX -->/   { skip = 0 }
    /<!-- BEGIN:DONE -->/  { print; emit(done_f);   skip = 1; next }
    /<!-- END:DONE -->/    { skip = 0 }
    !skip
  ' "$INDEX_FILE" > "$tmp"
  mv "$tmp" "$INDEX_FILE"
  echo "WROTE    INDEX.md — bảng L0 đã sinh lại từ frontmatter L1"
fi

# --- ORPHAN: card ⟷ dòng index, hai chiều ---
for slug in ${all_slugs+"${all_slugs[@]}"}; do
  if ! grep -q "^| $slug |" "$INDEX_FILE"; then
    echo "ORPHAN   $slug — có PROJECT.md nhưng chưa có dòng trong INDEX.md (chạy --write)"
    issues=$((issues + 1))
  fi
done

while IFS= read -r indexed_slug; do
  [[ -z "$indexed_slug" ]] && continue
  if [[ ! -f "$PROJECTS_DIR/$indexed_slug/PROJECT.md" ]]; then
    echo "ORPHAN   $indexed_slug — có dòng trong INDEX.md nhưng không có PROJECT.md"
    issues=$((issues + 1))
  fi
done < <(awk -F'|' '/^\| [a-z0-9][a-z0-9-]* \|/ { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2 }' "$INDEX_FILE")

if (( issues == 0 )); then
  echo "OK       Project Layer khớp — không có DRIFT / STALE / ORPHAN"
  exit 0
fi
echo "---"
echo "$issues tín hiệu cần xử lý."
exit 1
