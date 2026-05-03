#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Edgent — Edge Node Installer
#  Supports: Linux x86_64 / ARM64 (Jetson Orin / Nano)
#  Usage:  curl -fsSL https://raw.githubusercontent.com/R-Abinav/edgent/main/install.sh | bash
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
RESET='\033[0m'

log()  { echo -e "${CYAN}[edgent]${RESET} $*"; }
ok()   { echo -e "${GREEN}[✓]${RESET} $*"; }
warn() { echo -e "${YELLOW}[!]${RESET} $*"; }
die()  { echo -e "${RED}[✗]${RESET} $*" >&2; exit 1; }

REPO_URL="https://github.com/R-Abinav/edgent.git"
REPO_DIR="edgent"
MIN_NODE=18
MIN_GO="1.21"

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}  ⚡ Edgent — Edge Compute Node Installer${RESET}"
echo -e "  Autonomous delegation • ZK proofs • Onchain escrow"
echo ""

# ── 1. Detect OS / Architecture ───────────────────────────────────────────────
log "Detecting platform..."

OS="$(uname -s)"
ARCH="$(uname -m)"

[[ "$OS" != "Linux" ]] && die "This installer only supports Linux. Got: $OS"

case "$ARCH" in
  x86_64)         GOARCH="amd64"; PLATFORM="linux/amd64"  ;;
  aarch64|arm64)  GOARCH="arm64"; PLATFORM="linux/arm64"  ;;
  *)              die "Unsupported architecture: $ARCH"    ;;
esac

ok "Platform: Linux $ARCH ($PLATFORM)"

# ── 2. Check / Install Node.js ────────────────────────────────────────────────
log "Checking Node.js (need v${MIN_NODE}+)..."

install_node() {
  warn "Node.js not found or too old — installing via NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
}

if command -v node &>/dev/null; then
  NODE_VER="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
  if (( NODE_VER >= MIN_NODE )); then
    ok "Node.js v$(node --version | tr -d v) — OK"
  else
    warn "Node.js v$NODE_VER found, need $MIN_NODE+"
    install_node
  fi
else
  install_node
fi

ok "Node.js $(node --version)"

# ── 3. Check / Install Go ─────────────────────────────────────────────────────
log "Checking Go (need v${MIN_GO}+)..."

version_gte() {
  # Returns 0 (true) if $1 >= $2 in semver
  printf '%s\n%s' "$2" "$1" | sort -V -C
}

install_go() {
  warn "Go not found or too old — installing Go ${MIN_GO}..."
  GO_VERSION="1.22.3"
  GO_TARBALL="go${GO_VERSION}.linux-${GOARCH}.tar.gz"
  GO_URL="https://go.dev/dl/${GO_TARBALL}"

  log "Downloading $GO_URL..."
  curl -fsSL "$GO_URL" -o "/tmp/${GO_TARBALL}"
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf "/tmp/${GO_TARBALL}"
  rm -f "/tmp/${GO_TARBALL}"

  # Add to PATH for this session
  export PATH="/usr/local/go/bin:$PATH"
  echo 'export PATH="/usr/local/go/bin:$PATH"' >> "$HOME/.bashrc"
}

if command -v go &>/dev/null; then
  GO_VER="$(go version | awk '{print $3}' | tr -d 'go')"
  if version_gte "$GO_VER" "$MIN_GO"; then
    ok "Go $GO_VER — OK"
  else
    warn "Go $GO_VER found, need $MIN_GO+"
    install_go
  fi
else
  install_go
fi

ok "Go $(go version | awk '{print $3}')"

# ── 4. Clone repo (if not already inside it) ──────────────────────────────────
log "Checking repository..."

if [[ -f "package.json" ]] && grep -q '"name": "edgent"' package.json 2>/dev/null; then
  ok "Already inside the edgent repo — skipping clone"
  REPO_DIR="."
else
  if [[ -d "$REPO_DIR/.git" ]]; then
    ok "Repo already cloned at ./$REPO_DIR"
    cd "$REPO_DIR"
  else
    log "Cloning $REPO_URL..."
    git clone "$REPO_URL" "$REPO_DIR"
    cd "$REPO_DIR"
    ok "Cloned to $(pwd)"
  fi
fi

# ── 5. npm install ────────────────────────────────────────────────────────────
log "Installing Node dependencies..."
npm install --silent
ok "npm packages installed"

# ── 6. Build AXL binary ───────────────────────────────────────────────────────
log "Building AXL mesh binary..."

if [[ ! -d "axl" ]]; then
  log "Cloning AXL source..."
  git clone https://github.com/gensyn-ai/axl.git axl
  ok "AXL source cloned"
fi

mkdir -p axl-bin

(cd axl && make build 2>&1) || die "AXL build failed — check axl/Makefile"
cp axl/node axl-bin/node
chmod +x axl-bin/node

ok "AXL binary built → axl-bin/node"

# ── 7. Copy .env.example → .env ───────────────────────────────────────────────
log "Setting up environment config..."

if [[ -f ".env" ]]; then
  warn ".env already exists — skipping copy (not overwriting your config)"
else
  if [[ -f ".env.example" ]]; then
    cp .env.example .env
    ok ".env created from .env.example"
    warn "Open .env and fill in your WALLET_PRIVATE_KEY and other required values"
  else
    warn ".env.example not found — create .env manually"
  fi
fi

# ── 8. Check Ollama ───────────────────────────────────────────────────────────
log "Checking Ollama..."

if command -v ollama &>/dev/null; then
  ok "Ollama found: $(ollama --version 2>/dev/null || echo 'installed')"

  log "Checking for tinyllama model..."
  if ollama list 2>/dev/null | grep -q "tinyllama"; then
    ok "tinyllama already pulled"
  else
    warn "tinyllama not found — pulling now (this may take a few minutes)..."
    ollama pull tinyllama && ok "tinyllama pulled"
  fi
else
  warn "Ollama not installed."
  echo ""
  echo "  Install it with:"
  echo ""
  echo -e "    ${BOLD}curl -fsSL https://ollama.com/install.sh | sh${RESET}"
  echo ""
  echo "  Then run:"
  echo -e "    ${BOLD}ollama pull tinyllama${RESET}"
  echo ""
fi

# ── 9. Done ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}  ✅ Edgent node ready!${RESET}"
echo ""
echo "  Next steps:"
echo ""
echo -e "  1. ${BOLD}Edit .env${RESET} — add WALLET_PRIVATE_KEY and configure your role"
echo ""
echo "     ROLE=provider                    # or: requester"
echo "     WALLET_PRIVATE_KEY=0x...         # this node's signing key"
echo "     ESCROW_CONTRACT_ADDR=0x26322...  # already deployed on Base Sepolia"
echo ""
echo -e "  2. ${BOLD}Start the daemon${RESET}"
echo ""
echo "     npx tsx src/index.ts --role=provider"
echo "     # or"
echo "     npx tsx src/index.ts --role=requester"
echo ""
echo -e "  3. ${BOLD}Open the dashboard${RESET}"
echo ""
echo "     http://localhost:3001/dashboard"
echo ""
echo -e "${CYAN}  Documentation: https://github.com/R-Abinav/edgent${RESET}"
echo ""
