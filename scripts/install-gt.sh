#!/usr/bin/env bash
#
# Gemini Terminal (gt) CLI One-Line Installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Tonyogo/gt-hub/main/scripts/install-gt.sh | bash
#   or from your gt-hub server:
#   curl -fsSL http://<hub-ip>:8000/install.sh | bash
#

set -e

# Hub server URL placeholder (dynamically replaced by gt-hub server if fetched via /install.sh)
INJECTED_HUB_URL="${INJECTED_HUB_URL:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Temporary file cleanup handler
TEMP_FILE=""
cleanup() {
  if [ -n "$TEMP_FILE" ] && [ -f "$TEMP_FILE" ]; then
    rm -f "$TEMP_FILE"
  fi
}
trap cleanup EXIT

echo -e "${BLUE}=== Installing Gemini Terminal CLI (gt) ===${NC}"

# Function to print Node.js installation instructions tailored to OS
print_node_guide() {
  echo -e "\n${RED}[Error] Node.js 18+ is required to run gt CLI.${NC}" >&2
  echo -e "Current environment does not meet the requirements." >&2
  echo -e "Please install or upgrade Node.js on your system:\n" >&2

  if [[ "$OSTYPE" == "darwin"* ]] || command -v sw_vers >/dev/null 2>&1; then
    echo -e "  ${YELLOW}macOS (Homebrew):${NC}" >&2
    echo -e "  brew install node@20\n" >&2
  elif [ -f /etc/os-release ]; then
    OS_ID=$(grep -E '^ID=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    OS_LIKE=$(grep -E '^ID_LIKE=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'")
    OS_COMBINED="$OS_ID $OS_LIKE"
    case "$OS_COMBINED" in
      *ubuntu*|*debian*|*raspbian*)
        echo -e "  ${YELLOW}Debian / Ubuntu:${NC}" >&2
        echo -e "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs\n" >&2
        ;;
      *rhel*|*centos*|*rocky*|*almalinux*|*fedora*)
        echo -e "  ${YELLOW}RHEL / CentOS / Rocky / Fedora:${NC}" >&2
        echo -e "  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs\n" >&2
        ;;
      *)
        echo -e "  ${YELLOW}Linux (Debian / Ubuntu):${NC}" >&2
        echo -e "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs\n" >&2
        echo -e "  ${YELLOW}Linux (RHEL / CentOS / Rocky):${NC}" >&2
        echo -e "  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs\n" >&2
        ;;
    esac
  else
    echo -e "  ${YELLOW}Linux (Debian / Ubuntu):${NC}" >&2
    echo -e "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs\n" >&2
    echo -e "  ${YELLOW}Linux (RHEL / CentOS / Rocky):${NC}" >&2
    echo -e "  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs\n" >&2
  fi

  echo -e "Official Node.js downloads & guide: https://nodejs.org" >&2
  exit 1
}

# 1. Check Node.js runtime (Strict check >= 18)
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}[Error] Node.js is not found on your system.${NC}" >&2
  print_node_guide
fi

NODE_RAW_VER=$(node -v 2>/dev/null || echo "")
NODE_MAJOR=$(echo "$NODE_RAW_VER" | sed -E 's/^v//' | cut -d. -f1)

if [ -z "$NODE_MAJOR" ] || ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || [ "$NODE_MAJOR" -lt 18 ]; then
  echo -e "${RED}[Error] Node.js version is $NODE_RAW_VER. gt CLI requires Node.js v18 or later.${NC}" >&2
  print_node_guide
fi

echo -e "${GREEN}✓ Detected Node.js $NODE_RAW_VER${NC}"

# Check Python 3 runtime for PTY fallback support (optional)
if command -v python3 >/dev/null 2>&1; then
  echo -e "${GREEN}✓ Detected Python 3 runtime (PTY fallback with dynamic resize supported)${NC}"
fi

# 2. Determine target install directory
INSTALL_DIR="/usr/local/bin"
USE_SUDO=0

if [ -w "$INSTALL_DIR" ]; then
  TARGET_DIR="$INSTALL_DIR"
elif [ -n "$SUDO_USER" ] && [ -w "/usr/local/bin" ]; then
  TARGET_DIR="/usr/local/bin"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  TARGET_DIR="/usr/local/bin"
  USE_SUDO=1
else
  # Fallback to user home bin
  TARGET_DIR="$HOME/.local/bin"
  mkdir -p "$TARGET_DIR"

  # Ensure target directory is in PATH
  if [[ ":$PATH:" != *":$TARGET_DIR:"* ]]; then
    SHELL_PROFILE=""
    CURRENT_SHELL=$(basename "${SHELL:-bash}")
    if [ "$CURRENT_SHELL" = "zsh" ]; then
      SHELL_PROFILE="$HOME/.zshrc"
    elif [ "$CURRENT_SHELL" = "bash" ]; then
      if [ -f "$HOME/.bashrc" ]; then
        SHELL_PROFILE="$HOME/.bashrc"
      elif [ -f "$HOME/.bash_profile" ]; then
        SHELL_PROFILE="$HOME/.bash_profile"
      else
        SHELL_PROFILE="$HOME/.bashrc"
      fi
    elif [ -f "$HOME/.profile" ]; then
      SHELL_PROFILE="$HOME/.profile"
    elif [ -f "$HOME/.bashrc" ]; then
      SHELL_PROFILE="$HOME/.bashrc"
    elif [ -f "$HOME/.zshrc" ]; then
      SHELL_PROFILE="$HOME/.zshrc"
    fi

    if [ -n "$SHELL_PROFILE" ]; then
      if ! grep -qs "$TARGET_DIR" "$SHELL_PROFILE"; then
        echo "export PATH=\"\$PATH:$TARGET_DIR\"" >> "$SHELL_PROFILE"
        echo -e "${YELLOW}[Notice] Added $TARGET_DIR to $SHELL_PROFILE. Please run 'source $SHELL_PROFILE' or restart your terminal.${NC}"
      fi
    fi
    export PATH="$PATH:$TARGET_DIR"
  fi
fi

TARGET_BIN="$TARGET_DIR/gt"
TEMP_FILE=$(mktemp 2>/dev/null || mktemp /tmp/gt.XXXXXX 2>/dev/null || (mkdir -p "$HOME/.local" 2>/dev/null && mktemp "$HOME/.local/gt.XXXXXX"))

# 3. Determine download URL
# Priority:
# 1. Environment variable GT_DOWNLOAD_URL
# 2. Injected Hub URL from server (${INJECTED_HUB_URL}/gt)
# 3. Environment variable GT_SERVER_URL (${GT_SERVER_URL}/gt)
# 4. Official GitHub raw repository
GITHUB_FALLBACK_URL="https://raw.githubusercontent.com/Tonyogo/gt-hub/main/scripts/gt.js"

if [ -n "$GT_DOWNLOAD_URL" ]; then
  DOWNLOAD_URL="$GT_DOWNLOAD_URL"
elif [ -n "$INJECTED_HUB_URL" ]; then
  DOWNLOAD_URL="${INJECTED_HUB_URL%/}/gt"
elif [ -n "$GT_SERVER_URL" ]; then
  DOWNLOAD_URL="${GT_SERVER_URL%/}/gt"
else
  DOWNLOAD_URL="$GITHUB_FALLBACK_URL"
fi

echo -e "Downloading gt CLI from ${BLUE}$DOWNLOAD_URL${NC}..."

download_file() {
  local target_url="$1"
  local dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$target_url" -o "$dest" 2>/dev/null || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$target_url" 2>/dev/null || return 1
  else
    echo -e "${RED}[Error] Neither curl nor wget was found.${NC}" >&2
    return 1
  fi
  grep -q "gt (Gemini Terminal)" "$dest" || return 1
  return 0
}

if ! download_file "$DOWNLOAD_URL" "$TEMP_FILE"; then
  if [ "$DOWNLOAD_URL" != "$GITHUB_FALLBACK_URL" ]; then
    echo -e "${YELLOW}[Warning] Failed to download from $DOWNLOAD_URL. Retrying via official GitHub repository...${NC}"
    if ! download_file "$GITHUB_FALLBACK_URL" "$TEMP_FILE"; then
      echo -e "${RED}[Error] Failed to download gt CLI from all sources.${NC}" >&2
      rm -f "$TEMP_FILE"
      exit 1
    fi
  else
    echo -e "${RED}[Error] Failed to download gt CLI from $GITHUB_FALLBACK_URL.${NC}" >&2
    rm -f "$TEMP_FILE"
    exit 1
  fi
fi

chmod +x "$TEMP_FILE"

# 4. Install binary to target location
if [ "$USE_SUDO" -eq 1 ]; then
  sudo mkdir -p "$TARGET_DIR"
  sudo mv "$TEMP_FILE" "$TARGET_BIN"
  sudo chmod +x "$TARGET_BIN"
else
  mkdir -p "$TARGET_DIR"
  mv "$TEMP_FILE" "$TARGET_BIN"
  chmod +x "$TARGET_BIN"
fi

echo -e "${GREEN}✓ Successfully installed gt CLI to $TARGET_BIN${NC}"
echo ""

# 5. Output version and quickstart
"$TARGET_BIN" --version || true

EFFECTIVE_HUB_URL="${INJECTED_HUB_URL:-${GT_SERVER_URL:-http://<hub-host>:3000}}"

echo ""
echo -e "${GREEN}Quickstart:${NC}"
echo "  1. Authenticate with your hub server:"
echo "     gt login \"$EFFECTIVE_HUB_URL\" <your-admin-key>"
echo ""
echo "  2. Connect and run agent daemon:"
echo "     gt run -d --name=\"my-server\""
echo ""
echo "  3. List remote agent nodes:"
echo "     gt ps"
echo ""
echo "  4. Execute commands remotely:"
echo "     gt exec <host> uptime"
echo ""
