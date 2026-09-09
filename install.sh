#!/usr/bin/env bash
# Direct native installer for macOS and glibc Linux. The binary channel never requires Node.

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR     %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

PACKAGE="alp-code"
REPO_SLUG="${ALP_REPO_SLUG:-phucanh08/alp-code}"
REPO="${ALP_REPO:-https://github.com/${REPO_SLUG}.git}"
CHANNEL="${ALP_CHANNEL:-auto}"
VERSION="${ALP_VERSION:-}"
BRANCH="${ALP_BRANCH:-}"
INSTALL_HOME="${ALP_HOME:-$HOME/.alp-code}"
NO_PATH="${ALP_NO_PATH:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --home) shift; [ $# -gt 0 ] || die "--home requires a path"; INSTALL_HOME="$1" ;;
    --version) shift; [ $# -gt 0 ] || die "--version requires vX.Y.Z"; VERSION="$1" ;;
    --channel) shift; [ $# -gt 0 ] || die "--channel requires binary|npm|dev"; CHANNEL="$1" ;;
    --branch) shift; [ $# -gt 0 ] || die "--branch requires a name"; BRANCH="$1"; CHANNEL=dev ;;
    --repo) shift; [ $# -gt 0 ] || die "--repo requires a URL"; REPO="$1" ;;
    --no-path) NO_PATH=1 ;;
    -h|--help)
      say "install.sh [--channel binary|npm|dev] [--version vX.Y.Z] [--home PATH] [--no-path]"
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

if [ "$CHANNEL" = auto ]; then CHANNEL=binary; fi
if [ "$CHANNEL" = tarball ]; then CHANNEL=binary; fi
case "$CHANNEL" in binary|npm|dev) ;; *) die "unsupported channel: $CHANNEL" ;; esac

fetch_stdout() {
  if have curl; then curl -fsSL --retry 2 "$1"
  elif have wget; then wget -qO- "$1"
  else die "curl or wget is required"
  fi
}

fetch_file() {
  if have curl; then curl -fsSL --retry 2 -o "$2" "$1"
  elif have wget; then wget -qO "$2" "$1"
  else die "curl or wget is required"
  fi
}

require_node() {
  have node || die "Node >=18 is required only for the $CHANNEL channel"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf 0)"
  [ "$major" -ge 18 ] || die "Node >=18 is required for the $CHANNEL channel"
}

install_npm() {
  require_node
  have npm || die "npm is required for --channel npm"
  local spec="$PACKAGE"
  [ -z "$VERSION" ] || spec="$PACKAGE@${VERSION#v}"
  say "NPM       npm install -g $spec"
  npm install --global "$spec"
  command alp __internal ensure-state
  say "READY     $spec"
}

install_dev() {
  require_node
  have npm || die "npm is required for --channel dev"
  have git || die "git is required for --channel dev"
  [ -n "$BRANCH" ] || BRANCH=main
  if [ -d "$INSTALL_HOME/.git" ]; then
    git -C "$INSTALL_HOME" fetch origin "$BRANCH"
    git -C "$INSTALL_HOME" checkout "$BRANCH"
    git -C "$INSTALL_HOME" pull --ff-only
  elif [ -e "$INSTALL_HOME" ]; then
    die "$INSTALL_HOME exists and is not a git clone"
  else
    mkdir -p "$(dirname "$INSTALL_HOME")"
    git clone --branch "$BRANCH" "$REPO" "$INSTALL_HOME"
  fi
  if [ "$NO_PATH" = 1 ]; then exec node "$INSTALL_HOME/scripts/bootstrap.cjs" --no-path; fi
  exec node "$INSTALL_HOME/scripts/bootstrap.cjs"
}

resolve_target() {
  local os arch machine
  machine="$(uname -m)"
  case "$machine" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) die "unsupported architecture: $machine" ;; esac
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux)
      os=linux
      if have ldd && ldd --version 2>&1 | grep -qi musl; then die "Linux musl is not supported; use glibc or the npm/dev fallback"; fi
      ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac
  if [ "$os" = linux ]; then TARGET_ID="linux-${arch}-gnu"; else TARGET_ID="darwin-${arch}"; fi
}

resolve_version() {
  local tag="$VERSION"
  if [ -z "$tag" ]; then
    say "RESOLVE   latest release for $REPO_SLUG"
    tag="$(fetch_stdout "https://api.github.com/repos/${REPO_SLUG}/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  fi
  case "$tag" in v*) ;; *) tag="v$tag" ;; esac
  printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || die "invalid release version: $tag"
  VERSION_TAG="$tag"
  VERSION_NUMBER="${tag#v}"
}

checksum_file() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else die "sha256sum or shasum is required to verify the release"
  fi
}

validate_archive() {
  local archive="$1" listing="$2" verbose="$3" entry clean first
  tar -tzf "$archive" > "$listing" || die "release archive is not readable"
  while IFS= read -r entry; do
    [ "$entry" = "." ] || [ "$entry" = "./" ] && continue
    clean="${entry#./}"
    case "$clean" in /*|*\\*|..|../*|*/../*|*/..) die "unsafe archive entry: $entry" ;; esac
  done < "$listing"
  tar -tvzf "$archive" > "$verbose" || die "release archive metadata is not readable"
  while IFS= read -r entry; do
    first="${entry%${entry#?}}"
    case "$first" in l|h) die "release archive contains a link entry; refusing extraction" ;; esac
  done < "$verbose"
}

preflight_command() {
  [ "$NO_PATH" = 1 ] && return
  USER_BIN="${ALP_BIN_DIR:-$HOME/.local/bin}"
  USER_COMMAND="$USER_BIN/alp"
  if [ -e "$USER_COMMAND" ] || [ -L "$USER_COMMAND" ]; then
    [ -L "$USER_COMMAND" ] || die "$USER_COMMAND exists and is not an ALP symlink"
    local linked
    linked="$(readlink "$USER_COMMAND")"
    [ "$linked" = "$INSTALL_HOME/bin/alp" ] || die "$USER_COMMAND is owned by another installation ($linked)"
  fi
}

add_to_path() {
  [ "$NO_PATH" = 1 ] && return
  mkdir -p "$USER_BIN"
  if [ ! -L "$USER_COMMAND" ]; then ln -s "$INSTALL_HOME/bin/alp" "$USER_COMMAND"; fi
  case ":${PATH:-}:" in *":$USER_BIN:"*) return ;; esac
  local profile=""
  case "${SHELL##*/}" in zsh) profile="$HOME/.zshrc" ;; bash) [ "$(uname -s)" = Darwin ] && profile="$HOME/.bash_profile" || profile="$HOME/.bashrc" ;; esac
  if [ -n "$profile" ]; then
    if [ ! -f "$profile" ] || ! grep -q '# >>> alp-code >>>' "$profile"; then
      printf '\n# >>> alp-code >>>\nexport PATH="%s:$PATH"\n# <<< alp-code <<<\n' "$USER_BIN" >> "$profile"
    fi
    say "PATH      open a new shell, or source $profile"
  else
    say "PATH      add $USER_BIN to PATH"
  fi
}

install_binary() {
  resolve_target
  resolve_version
  have tar || die "tar is required"
  preflight_command

  local filename="${PACKAGE}-${VERSION_TAG}-${TARGET_ID}.tar.gz"
  local base="https://github.com/${REPO_SLUG}/releases/download/${VERSION_TAG}"
  local staging="$INSTALL_HOME/.staging-${VERSION_TAG}-$$"
  local archive="$INSTALL_HOME/.${filename}.$$"
  local checksums="$INSTALL_HOME/.SHA256SUMS.$$"
  local listing="$INSTALL_HOME/.archive-list.$$"
  local verbose="$INSTALL_HOME/.archive-verbose.$$"
  local destination="$INSTALL_HOME/versions/$VERSION_TAG"
  local current="$INSTALL_HOME/current"
  local temporary="$INSTALL_HOME/.current.$$"
  local stable="$INSTALL_HOME/bin/alp"
  local stable_existed=0
  mkdir -p "$INSTALL_HOME/versions" "$INSTALL_HOME/bin"
  if [ -e "$current" ] && [ ! -L "$current" ]; then die "$current is not a symlink; refusing to replace it"; fi
  if [ -e "$stable" ] || [ -L "$stable" ]; then
    stable_existed=1
    [ -L "$stable" ] && [ "$(readlink "$stable")" = "../current/bin/alp" ] || die "$stable exists and is not the ALP stable symlink"
  fi
  rm -rf "$staging"
  mkdir -p "$staging"
  trap 'rm -rf "$staging"; rm -f "$archive" "$checksums" "$listing" "$verbose" "$temporary"' EXIT

  say "DOWNLOAD  $filename"
  fetch_file "$base/SHA256SUMS" "$checksums"
  fetch_file "$base/$filename" "$archive"
  local expected actual
  expected="$(awk -v name="$filename" '$2 == name { print $1; exit }' "$checksums")"
  printf '%s\n' "$expected" | grep -Eq '^[0-9a-fA-F]{64}$' || die "checksum entry missing or invalid for $filename"
  expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
  actual="$(checksum_file "$archive")"
  [ "$actual" = "$expected" ] || die "checksum mismatch for $filename"
  validate_archive "$archive" "$listing" "$verbose"
  tar -xzf "$archive" -C "$staging"
  [ -x "$staging/bin/alp" ] || die "archive is missing executable bin/alp"
  [ -d "$staging/skills" ] && [ -d "$staging/scaffold" ] || die "archive is missing skills/scaffold"
  grep -q '"app"[[:space:]]*:[[:space:]]*"alp-code"' "$staging/install-manifest.json" || die "invalid install manifest app"
  grep -q '"version"[[:space:]]*:[[:space:]]*"'"$VERSION_NUMBER"'"' "$staging/install-manifest.json" || die "install manifest version mismatch"
  grep -q '"target"[[:space:]]*:[[:space:]]*"'"$TARGET_ID"'"' "$staging/install-manifest.json" || die "install manifest target mismatch"
  [ "$("$staging/bin/alp" --version)" = "alp $VERSION_NUMBER" ] || die "staged binary version smoke failed"

  if [ -e "$destination" ]; then
    [ -x "$destination/bin/alp" ] && [ "$("$destination/bin/alp" --version)" = "alp $VERSION_NUMBER" ] || die "$destination exists but is incomplete"
    rm -rf "$staging"
  else
    mv "$staging" "$destination"
  fi

  local previous=""
  [ ! -L "$current" ] || previous="$(readlink "$current")"
  ln -s "versions/$VERSION_TAG" "$temporary"
  mv -f "$temporary" "$current"

  if [ -e "$stable" ] || [ -L "$stable" ]; then
    if [ ! -L "$stable" ] || [ "$(readlink "$stable")" != "../current/bin/alp" ]; then
      if [ -n "$previous" ]; then ln -s "$previous" "$temporary"; mv -f "$temporary" "$current"; else rm -f "$current"; fi
      die "$stable exists and is not the ALP stable symlink"
    fi
  else ln -s "../current/bin/alp" "$stable"
  fi

  if ! "$stable" __internal ensure-state; then
    if [ -n "$previous" ]; then
      ln -s "$previous" "$temporary"; mv -f "$temporary" "$current"
    else
      rm -f "$current"
      [ "$stable_existed" = 1 ] || rm -f "$stable"
    fi
    die "state initialization failed; previous current pointer restored"
  fi
  add_to_path
  rm -f "$archive" "$checksums" "$listing" "$verbose"
  trap - EXIT
  say "READY     alp-code $VERSION_TAG ($TARGET_ID) at $INSTALL_HOME"
}

case "$CHANNEL" in
  binary) install_binary ;;
  npm) install_npm ;;
  dev) install_dev ;;
esac
