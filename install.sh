#!/usr/bin/env bash
# install.sh — cài alp-code bằng một dòng (macOS/Linux/WSL).
#
#   curl -fsSL https://raw.githubusercontent.com/phucanh08/alp-code/main/install.sh | bash
#   curl -fsSL …/install.sh | bash -s -- --home ~/dev/alp-code
#   curl -fsSL …/install.sh | bash -s -- --version v0.2.0
#   curl -fsSL …/install.sh | bash -s -- --no-path
#
# Biến môi trường: ALP_HOME (mặc định ~/.alp-code) · ALP_VERSION (tag release cụ thể) ·
# ALP_BRANCH (theo dõi một nhánh — bỏ qua release resolution, chỉ dùng khi phát triển) ·
# ALP_REPO · ALP_NO_PATH=1
#
# Mặc định (release mode): cài đặt/cập nhật resolve tag GitHub Release mới nhất (qua
# scripts/checkout-release.cjs) rồi checkout đúng tag đó. Đặt --branch/ALP_BRANCH để bỏ
# qua release resolution và theo dõi trực tiếp một nhánh (dev mode, ff-only pull như cũ).
#
# Script này CỐ Ý mỏng. Nó chỉ làm những việc buộc phải làm khi repo còn chưa có trên
# máy: kiểm dependency và lấy code về. Mọi thứ sau đó giao cho scripts/bootstrap.cjs.
# Chạy lại lệnh này = cập nhật code + rebuild, không đụng memory/runtime/backend preferences.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR    %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

REPO="${ALP_REPO:-https://github.com/phucanh08/alp-code.git}"
BRANCH="${ALP_BRANCH:-}"
VERSION="${ALP_VERSION:-}"
TARGET="${ALP_HOME:-$HOME/.alp-code}"
NODE_MIN=18
FORWARD=()

while [ $# -gt 0 ]; do
  case "$1" in
    --home)    shift; [ $# -gt 0 ] || die "--home thiếu giá trị";    TARGET="$1" ;;
    --branch)  shift; [ $# -gt 0 ] || die "--branch thiếu giá trị";  BRANCH="$1" ;;
    --version) shift; [ $# -gt 0 ] || die "--version thiếu giá trị"; VERSION="$1" ;;
    --repo)    shift; [ $# -gt 0 ] || die "--repo thiếu giá trị";    REPO="$1" ;;
    -h|--help)
      sed -n '2,14p' "$0" 2>/dev/null || say "install.sh [--home <path>] [--version <tag>] [--branch <x>] [--no-path]"
      exit 0 ;;
    # Còn lại chuyển thẳng cho bootstrap.cjs (ví dụ --no-path).
    *) FORWARD+=("$1") ;;
  esac
  shift
done

RELEASE_MODE=1
[ -n "$BRANCH" ] && RELEASE_MODE=0

# ------------------------------------------------------------------ preflight
have git || die "thiếu \`git\`. macOS: xcode-select --install · Debian/Ubuntu: apt install git"
have node || die "thiếu \`node\`. Cần Node >= v${NODE_MIN} — xem https://nodejs.org hoặc dùng nvm"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge "$NODE_MIN" ] || die "Node $(node -v) quá cũ — alp-code cần >= v${NODE_MIN}"

# ------------------------------------------------------------------ lấy code
checkout_release() {
  node "$TARGET/scripts/checkout-release.cjs" ${VERSION:+--version "$VERSION"} \
    || die "$TARGET: checkout release thất bại — chạy \`node \"$TARGET/scripts/checkout-release.cjs\"\` để xem chi tiết"
}

if [ -d "$TARGET/.git" ]; then
  if [ "$RELEASE_MODE" = 1 ]; then
    say "UPDATE   $TARGET (release)"
    checkout_release
  else
    say "PULL     $TARGET (nhánh $BRANCH)"
    # --ff-only: có commit nội bộ chưa push thì DỪNG, không tự merge/stash hộ.
    # Sửa nhầm code của người dùng còn tệ hơn là bắt họ tự xử lý.
    git -C "$TARGET" fetch origin "$BRANCH" && git -C "$TARGET" checkout "$BRANCH" && git -C "$TARGET" pull --ff-only || die "\
$TARGET không cập nhật được nhánh \`$BRANCH\` — nhánh nội bộ đã rẽ hoặc đang dở việc.
         Tự xử lý (git -C \"$TARGET\" status) rồi chạy lại lệnh cài."
  fi
elif [ -e "$TARGET" ]; then
  die "\
$TARGET đã tồn tại nhưng không phải git repo — installer không đụng vào.
         Dọn thủ công, hoặc cài chỗ khác: --home <path> / ALP_HOME=<path>"
else
  mkdir -p "$(dirname "$TARGET")"
  if [ "$RELEASE_MODE" = 1 ]; then
    say "CLONE    $REPO → $TARGET"
    git clone "$REPO" "$TARGET"
    checkout_release
  else
    say "CLONE    $REPO (nhánh $BRANCH) → $TARGET"
    git clone --branch "$BRANCH" "$REPO" "$TARGET"
  fi
fi

[ -f "$TARGET/scripts/bootstrap.cjs" ] || die "$TARGET thiếu scripts/bootstrap.cjs — clone hỏng hoặc phiên bản quá cũ"

# ------------------------------------------------------------------ bàn giao
# ${FORWARD[@]+…} vì bash 3.2 (macOS) báo lỗi khi expand mảng rỗng dưới `set -u`.
exec node "$TARGET/scripts/bootstrap.cjs" ${FORWARD[@]+"${FORWARD[@]}"}
