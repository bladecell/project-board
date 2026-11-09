#!/usr/bin/env bash
# Install or update project-board:  curl -fsSL https://raw.githubusercontent.com/bladecell/project-board/master/install.sh | bash
# Env: BOARD_DIR (default ~/.local/share/project-board), BOARD_REPO (git URL), BOARD_NO_BUN_INSTALL=1 to skip installing bun.
set -euo pipefail
dir="${BOARD_DIR:-$HOME/.local/share/project-board}"
repo="${BOARD_REPO:-https://github.com/bladecell/project-board.git}"
say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git is required"
export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null; then
  [ "${BOARD_NO_BUN_INSTALL:-}" = 1 ] && die "bun is required (https://bun.sh)"
  say "Installing bun (https://bun.sh/install)"
  command -v curl >/dev/null || die "curl is required to install bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

if [ -d "$dir/.git" ]; then
  say "Updating $dir"
  git -C "$dir" pull --ff-only
else
  say "Cloning into $dir"
  mkdir -p "$(dirname "$dir")"
  git clone --depth 1 "$repo" "$dir"
fi

(cd "$dir" && bun link >/dev/null)
say "Installed: $(command -v board || echo "$HOME/.bun/bin/board")"
if ! command -v board >/dev/null; then
  case "$(basename "${SHELL:-}")" in
    fish) echo "Add bun to PATH:  fish_add_path ~/.bun/bin" ;;
    *) echo "Add bun to PATH:  echo 'export PATH=\"\$HOME/.bun/bin:\$PATH\"' >> ~/.profile" ;;
  esac
fi
echo "Next: cd your-project && board init && board"
