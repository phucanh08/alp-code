#!/usr/bin/env bash
# install.sh — cài alp-code bằng một dòng (macOS/Linux/WSL).
#
#   curl -fsSL https://raw.githubusercontent.com/phucanh08/alp-code/main/install.sh | bash
#   curl -fsSL …/install.sh | bash -s -- --home ~/dev/alp-code
#   curl -fsSL …/install.sh | bash -s -- --no-trust
#   curl -fsSL …/install.sh | bash -s -- --no-path
#
# Biến môi trường: ALP_HOME (mặc định ~/.alp-code) · ALP_BRANCH (main) · ALP_REPO ·
# ALP_NO_PATH=1
#
# Script này CỐ Ý mỏng. Nó chỉ làm những việc buộc phải làm khi repo còn chưa có trên
# máy: kiểm dependency và lấy code về. Mọi thứ sau đó giao cho scripts/bootstrap.cjs.
# Chạy lại lệnh này = cập nhật (git pull + recompile), không đụng vào memory/.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR    %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

REPO="${ALP_REPO:-https://github.com/phucanh08/alp-code.git}"
BRANCH="${ALP_BRANCH:-main}"
TARGET="${ALP_HOME:-$HOME/.alp-code}"
NODE_MIN=18
FORWARD=()

while [ $# -gt 0 ]; do
  case "$1" in
    --home)   shift; [ $# -gt 0 ] || die "--home thiếu giá trị";   TARGET="$1" ;;
    --branch) shift; [ $# -gt 0 ] || die "--branch thiếu giá trị"; BRANCH="$1" ;;
    --repo)   shift; [ $# -gt 0 ] || die "--repo thiếu giá trị";   REPO="$1" ;;
    -h|--help)
      sed -n '2,11p' "$0" 2>/dev/null || say "install.sh [--home <path>] [--branch <x>] [--no-trust] [--no-path]"
      exit 0 ;;
    # Còn lại chuyển thẳng cho bootstrap.cjs (ví dụ --no-trust).
    *) FORWARD+=("$1") ;;
  esac
  shift
done

# ------------------------------------------------------------------ preflight
have git || die "thiếu \`git\`. macOS: xcode-select --install · Debian/Ubuntu: apt install git"
have node || die "thiếu \`node\`. Cần Node >= v${NODE_MIN} — xem https://nodejs.org hoặc dùng nvm"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge "$NODE_MIN" ] || die "Node $(node -v) quá cũ — alp-code cần >= v${NODE_MIN}"

# ------------------------------------------------------------------ lấy code
if [ -d "$TARGET/.git" ]; then
  say "PULL     $TARGET"
  # --ff-only: có commit nội bộ chưa push thì DỪNG, không tự merge/stash hộ.
  # Sửa nhầm code của người dùng còn tệ hơn là bắt họ tự xử lý.
  git -C "$TARGET" pull --ff-only || die "\
$TARGET không fast-forward được — nhánh nội bộ đã rẽ hoặc đang dở việc.
         Tự xử lý (git -C \"$TARGET\" status) rồi chạy lại lệnh cài."
elif [ -e "$TARGET" ]; then
  die "\
$TARGET đã tồn tại nhưng không phải git repo — installer không đụng vào.
         Dọn thủ công, hoặc cài chỗ khác: --home <path> / ALP_HOME=<path>"
else
  say "CLONE    $REPO → $TARGET"
  mkdir -p "$(dirname "$TARGET")"
  git clone --branch "$BRANCH" "$REPO" "$TARGET"
fi

[ -f "$TARGET/scripts/bootstrap.cjs" ] || die "$TARGET thiếu scripts/bootstrap.cjs — clone hỏng hoặc nhánh \`$BRANCH\` quá cũ"

# ------------------------------------------------------------------ bàn giao
# ${FORWARD[@]+…} vì bash 3.2 (macOS) báo lỗi khi expand mảng rỗng dưới `set -u`.
exec node "$TARGET/scripts/bootstrap.cjs" ${FORWARD[@]+"${FORWARD[@]}"}
