#!/usr/bin/env bash
# install.sh — cài alp-code bằng một dòng (macOS/Linux/WSL).
#
#   curl -fsSL https://raw.githubusercontent.com/phucanh08/alp-code/main/install.sh | bash
#   curl -fsSL …/install.sh | bash -s -- --channel tarball
#   curl -fsSL …/install.sh | bash -s -- --version v0.9.0
#   curl -fsSL …/install.sh | bash -s -- --home ~/dev/alp-code --no-path
#   curl -fsSL …/install.sh | bash -s -- --branch main        # dev: clone + build tại chỗ
#
# Biến môi trường: ALP_CHANNEL (auto|npm|tarball) · ALP_VERSION (tag cụ thể) · ALP_HOME
# (mặc định ~/.alp-code, chỉ dùng cho tarball/dev) · ALP_BRANCH · ALP_REPO · ALP_NO_PATH=1
#
# KHÔNG BUILD GÌ TRÊN MÁY NÀY. Bản phát hành đã được compile sẵn trên máy maintainer, nên
# installer chỉ còn phải lấy artifact về đúng chỗ:
#
#   npm      (mặc định khi có npm) — `npm install -g alp-code`. npm lo cả code lẫn dependency
#                                    và tự đặt lệnh `alp` vào PATH của nó.
#   tarball  (không có npm, hoặc registry bị chặn) — tải bundle của GitHub Release về
#                                    `~/.alp-code/versions/<tag>` rồi trỏ `current` sang đó.
#   dev      (--branch)             — clone git và build tại chỗ; đây là bản để SỬA alp-code,
#                                    không phải bản để dùng.
#
# Script này CỐ Ý mỏng: nó chỉ làm những việc buộc phải làm khi trên máy còn chưa có gì. Từ
# lúc code nằm trên đĩa trở đi, mọi thứ giao cho scripts/bootstrap.cjs — bản thật duy nhất,
# dùng chung cho cả ba OS.
#
# Chạy lại lệnh này = cập nhật code. Memory, identity và preferences nằm ở `~/.alp`, không
# nằm trong thư mục cài, nên không có bước nào ở đây đụng tới chúng.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR    %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

PACKAGE="alp-code"
REPO_SLUG="${ALP_REPO_SLUG:-phucanh08/alp-code}"
REPO="${ALP_REPO:-https://github.com/${REPO_SLUG}.git}"
CHANNEL="${ALP_CHANNEL:-auto}"
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
    --channel) shift; [ $# -gt 0 ] || die "--channel thiếu giá trị"; CHANNEL="$1" ;;
    -h|--help)
      sed -n '2,26p' "$0" 2>/dev/null || say "install.sh [--channel npm|tarball] [--home <path>] [--version <tag>] [--branch <x>] [--no-path]"
      exit 0 ;;
    # Còn lại chuyển thẳng cho bootstrap.cjs (ví dụ --no-path).
    *) FORWARD+=("$1") ;;
  esac
  shift
done

# `[ … ] && x` là câu lệnh cuối của list, nên dưới `set -e` một điều kiện SAI làm thoát cả
# script. Viết bằng `if` để nhánh "không có --branch" không tự kết liễu installer.
if [ -n "$BRANCH" ]; then CHANNEL="dev"; fi
case "$CHANNEL" in
  auto|npm|tarball|dev) ;;
  *) die "--channel không hợp lệ: $CHANNEL (auto|npm|tarball)" ;;
esac

# ------------------------------------------------------------------ preflight
have node || die "thiếu \`node\`. Cần Node >= v${NODE_MIN} — xem https://nodejs.org hoặc dùng nvm"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge "$NODE_MIN" ] || die "Node $(node -v) quá cũ — alp-code cần >= v${NODE_MIN}"

if [ "$CHANNEL" = auto ]; then
  if have npm; then CHANNEL=npm; else CHANNEL=tarball; fi
  AUTO=1
else
  AUTO=0
fi

fetch_stdout() {
  if have curl; then curl -fsSL --retry 2 "$1"
  elif have wget; then wget -qO- "$1"
  else die "cần \`curl\` hoặc \`wget\` để tải bản phát hành"
  fi
}

fetch_file() {
  if have curl; then curl -fsSL --retry 2 -o "$2" "$1"
  elif have wget; then wget -qO "$2" "$1"
  else die "cần \`curl\` hoặc \`wget\` để tải bản phát hành"
  fi
}

# ------------------------------------------------------------------ channel npm
install_npm() {
  local spec="$PACKAGE"
  if [ -n "$VERSION" ]; then spec="$PACKAGE@${VERSION#v}"; fi
  say "NPM      npm install -g $spec"
  npm install --global "$spec" || return 1
  ROOT="$(npm root -g 2>/dev/null)/$PACKAGE"
  [ -f "$ROOT/scripts/bootstrap.cjs" ] || die "npm báo thành công nhưng không thấy $ROOT — kiểm tra \`npm root -g\`"
}

# -------------------------------------------------------------- channel tarball
# Giải nén sang một thư mục MỚI rồi mới trỏ `current` sang đó: tải hỏng giữa chừng thì bản
# đang dùng vẫn còn nguyên. Đây cũng đúng cách `alp update` làm, để hai đường không lệch nhau.
install_tarball() {
  local tag="$VERSION"
  if [ -z "$tag" ]; then
    say "RESOLVE  tag release mới nhất của $REPO_SLUG"
    tag="$(fetch_stdout "https://api.github.com/repos/${REPO_SLUG}/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    [ -n "$tag" ] || die "không hỏi được GitHub Releases — thử lại, hoặc chỉ định --version vX.Y.Z"
  fi
  case "$tag" in v*) ;; *) tag="v$tag" ;; esac

  local url="https://github.com/${REPO_SLUG}/releases/download/${tag}/${PACKAGE}-${tag}-bundle.tar.gz"
  local versions="$TARGET/versions"
  local dest="$versions/$tag"
  local staging="$versions/.incoming-$tag.$$"
  local archive="$versions/.$tag.$$.tar.gz"

  have tar || die "thiếu \`tar\` để giải nén bản phát hành"
  mkdir -p "$versions"
  rm -rf "$staging"; mkdir -p "$staging"
  # shellcheck disable=SC2064
  trap "rm -rf '$staging' '$archive'" EXIT

  say "DOWNLOAD $url"
  fetch_file "$url" "$archive" || die "\
không tải được $url
         Kiểm tra tag có tồn tại và có asset bundle: https://github.com/${REPO_SLUG}/releases"
  tar -xzf "$archive" -C "$staging" || die "bundle hỏng — giải nén thất bại"
  [ -f "$staging/scripts/alp.cjs" ] || die "bundle $tag không đúng cấu trúc — thiếu scripts/alp.cjs"

  rm -rf "$dest"
  mv "$staging" "$dest"
  rm -f "$archive"
  trap - EXIT

  # `current` phải là symlink; nếu chỗ đó đang là thư mục thật (bản clone đời cũ) thì dừng
  # lại chứ không xoá — trong đó có thể còn dữ liệu chưa ai di trú.
  local link="$TARGET/current"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    die "$link đang là thư mục thật, không phải symlink — dọn thủ công rồi chạy lại"
  fi
  ln -sfn "$dest" "$link"
  say "INSTALL  $tag → $dest (current → $tag)"
  ROOT="$link"
}

# ------------------------------------------------------------------ channel dev
install_dev() {
  have git || die "thiếu \`git\`. macOS: xcode-select --install · Debian/Ubuntu: apt install git"
  if [ -d "$TARGET/.git" ]; then
    say "PULL     $TARGET (nhánh $BRANCH)"
    # --ff-only: có commit nội bộ chưa push thì DỪNG, không tự merge/stash hộ.
    # Sửa nhầm code của người dùng còn tệ hơn là bắt họ tự xử lý.
    git -C "$TARGET" fetch origin "$BRANCH" && git -C "$TARGET" checkout "$BRANCH" && git -C "$TARGET" pull --ff-only || die "\
$TARGET không cập nhật được nhánh \`$BRANCH\` — nhánh nội bộ đã rẽ hoặc đang dở việc.
         Tự xử lý (git -C \"$TARGET\" status) rồi chạy lại lệnh cài."
  elif [ -e "$TARGET" ]; then
    die "\
$TARGET đã tồn tại nhưng không phải git repo — installer không đụng vào.
         Dọn thủ công, hoặc clone chỗ khác: --home <path>"
  else
    mkdir -p "$(dirname "$TARGET")"
    say "CLONE    $REPO (nhánh $BRANCH) → $TARGET"
    git clone --branch "$BRANCH" "$REPO" "$TARGET"
  fi
  ROOT="$TARGET"
}

# ------------------------------------------------------------------ lấy code
ROOT=""
case "$CHANNEL" in
  npm)
    if ! install_npm; then
      [ "$AUTO" = 1 ] || die "\`npm install -g $PACKAGE\` thất bại — xem log ở trên"
      # Registry bị chặn hay npm global không ghi được là chuyện thường trên máy công ty.
      # Đó chính là lý do có channel thứ hai, nên tự chuyển thay vì bắt người dùng đọc lại.
      say "FALLBACK npm không cài được — chuyển sang bundle của GitHub Release"
      CHANNEL=tarball
      install_tarball
    fi ;;
  tarball) install_tarball ;;
  dev)     install_dev ;;
esac

[ -f "$ROOT/scripts/bootstrap.cjs" ] || die "$ROOT thiếu scripts/bootstrap.cjs — bản cài hỏng hoặc quá cũ"

# ------------------------------------------------------------------ bàn giao
# ${FORWARD[@]+…} vì bash 3.2 (macOS) báo lỗi khi expand mảng rỗng dưới `set -u`.
exec node "$ROOT/scripts/bootstrap.cjs" ${FORWARD[@]+"${FORWARD[@]}"}
