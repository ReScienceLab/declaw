#!/usr/bin/env bash
set -euo pipefail

# DeClaw — Yggdrasil setup script
# Installs the Yggdrasil binary, generates a config with TCP admin endpoint
# (avoids UNIX socket permission issues), adds public peers, and starts the daemon.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ReScienceLab/DeClaw/main/scripts/setup-yggdrasil.sh | bash
#   — or —
#   openclaw p2p setup

YGG_VERSION="0.5.13"
YGG_CONF="/etc/yggdrasil.conf"
YGG_ADMIN_ADDR="127.0.0.1:9001"

# Public peers for initial connectivity
PUBLIC_PEERS=(
  "tcp://yggdrasil.mnpnk.com:10002"
  "tcp://ygg.mkg20001.io:80"
  "tcp://46.246.86.205:60002"
)

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m ✓\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m ⚠\033[0m  %s\n' "$*"; }
fatal() { printf '\033[1;31m ✗\033[0m  %s\n' "$*" >&2; exit 1; }

need_sudo() {
  if [ "$(id -u)" -ne 0 ]; then
    info "This step requires sudo."
    sudo "$@"
  else
    "$@"
  fi
}

# ── 1. Detect OS & arch ──────────────────────────────────────────────────────
detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7*|armhf)  arch="armhf" ;;
    *) fatal "Unsupported architecture: $arch" ;;
  esac

  case "$os" in
    darwin) PLATFORM="macos"; PKG_EXT="pkg" ;;
    linux)  PLATFORM="linux"; PKG_EXT="tar.gz" ;;
    *)      fatal "Unsupported OS: $os" ;;
  esac
  ARCH="$arch"
}

# ── 2. Check if already installed ────────────────────────────────────────────
check_existing() {
  if command -v yggdrasil >/dev/null 2>&1; then
    local ver
    ver="$(yggdrasil -version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)"
    ok "Yggdrasil already installed: v${ver:-unknown}"
    return 0
  fi
  return 1
}

# ── 3. Install binary ────────────────────────────────────────────────────────
install_binary() {
  local url tmpdir

  if [ "$PLATFORM" = "macos" ]; then
    info "Installing Yggdrasil v${YGG_VERSION} for macOS ${ARCH}..."
    url="https://github.com/yggdrasil-network/yggdrasil-go/releases/download/v${YGG_VERSION}/yggdrasil-${YGG_VERSION}-macos-${ARCH}.pkg"
    tmpdir="$(mktemp -d)"

    # Download and extract from pkg (avoids Gatekeeper issues with `installer`)
    curl -fsSL "$url" -o "${tmpdir}/yggdrasil.pkg"
    xar -xf "${tmpdir}/yggdrasil.pkg" -C "${tmpdir}"

    # Extract payload from base.pkg
    mkdir -p "${tmpdir}/extract"
    cd "${tmpdir}/extract"
    cat "${tmpdir}/base.pkg/Payload" | gunzip | cpio -id 2>/dev/null

    need_sudo cp "${tmpdir}/extract/usr/local/bin/yggdrasil" /usr/local/bin/yggdrasil
    need_sudo cp "${tmpdir}/extract/usr/local/bin/yggdrasilctl" /usr/local/bin/yggdrasilctl
    need_sudo chmod +x /usr/local/bin/yggdrasil /usr/local/bin/yggdrasilctl
    # Remove Gatekeeper quarantine
    need_sudo xattr -dr com.apple.quarantine /usr/local/bin/yggdrasil 2>/dev/null || true
    need_sudo xattr -dr com.apple.quarantine /usr/local/bin/yggdrasilctl 2>/dev/null || true

    rm -rf "${tmpdir}"

  elif [ "$PLATFORM" = "linux" ]; then
    # Try apt repo first (Debian/Ubuntu)
    if command -v apt-get >/dev/null 2>&1; then
      info "Installing Yggdrasil via apt..."
      curl -fsSL https://www.yggdrasil-network.github.io/apt-key.gpg | need_sudo apt-key add - 2>/dev/null
      echo "deb http://www.yggdrasil-network.github.io/apt/ debian main" \
        | need_sudo tee /etc/apt/sources.list.d/yggdrasil.list >/dev/null
      need_sudo apt-get update -qq
      need_sudo apt-get install -y -qq yggdrasil
    else
      info "Installing Yggdrasil v${YGG_VERSION} from tarball..."
      url="https://github.com/yggdrasil-network/yggdrasil-go/releases/download/v${YGG_VERSION}/yggdrasil-${YGG_VERSION}-linux-${ARCH}.tar.gz"
      tmpdir="$(mktemp -d)"
      curl -fsSL "$url" -o "${tmpdir}/yggdrasil.tar.gz"
      tar -xzf "${tmpdir}/yggdrasil.tar.gz" -C "${tmpdir}"
      need_sudo cp "${tmpdir}/yggdrasil" /usr/local/bin/yggdrasil
      need_sudo cp "${tmpdir}/yggdrasilctl" /usr/local/bin/yggdrasilctl
      need_sudo chmod +x /usr/local/bin/yggdrasil /usr/local/bin/yggdrasilctl
      rm -rf "${tmpdir}"
    fi
  fi

  ok "Yggdrasil v${YGG_VERSION} installed to /usr/local/bin/"
}

# ── 4. Generate config ────────────────────────────────────────────────────────
generate_config() {
  if [ -f "$YGG_CONF" ]; then
    # Check if config already has AdminListen with TCP
    if grep -q "AdminListen" "$YGG_CONF" && grep -q "tcp://" "$YGG_CONF"; then
      ok "Config exists with TCP admin endpoint"
      return
    fi
    warn "Existing config found at ${YGG_CONF} — patching AdminListen..."
  else
    info "Generating Yggdrasil config..."
    yggdrasil -genconf | need_sudo tee "$YGG_CONF" >/dev/null
  fi

  # Patch: add TCP AdminListen (avoids UNIX socket permission issues)
  local tmpconf
  tmpconf="$(mktemp)"
  if grep -q "AdminListen" "$YGG_CONF"; then
    sed "s|AdminListen:.*|AdminListen: \"tcp://${YGG_ADMIN_ADDR}\"|" "$YGG_CONF" > "$tmpconf"
  else
    # Insert before closing brace
    sed "\$i\\  AdminListen: \"tcp://${YGG_ADMIN_ADDR}\"" "$YGG_CONF" > "$tmpconf"
  fi
  need_sudo cp "$tmpconf" "$YGG_CONF"
  rm -f "$tmpconf"

  # Patch: inject public peers if Peers list is empty
  if grep -qE 'Peers:\s*\[\s*\]' "$YGG_CONF"; then
    local peer_lines=""
    for p in "${PUBLIC_PEERS[@]}"; do
      peer_lines="${peer_lines}    \"${p}\"\n"
    done
    tmpconf="$(mktemp)"
    sed "s|Peers: \[\]|Peers: [\n${peer_lines}  ]|" "$YGG_CONF" > "$tmpconf"
    need_sudo cp "$tmpconf" "$YGG_CONF"
    rm -f "$tmpconf"
  fi

  ok "Config written to ${YGG_CONF} (admin: tcp://${YGG_ADMIN_ADDR})"
}

# ── 5. Start/restart daemon ──────────────────────────────────────────────────
start_daemon() {
  if [ "$PLATFORM" = "macos" ]; then
    local plist="/Library/LaunchDaemons/yggdrasil.plist"
    if [ ! -f "$plist" ]; then
      info "Creating LaunchDaemon plist..."
      need_sudo tee "$plist" >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>yggdrasil</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/yggdrasil</string>
      <string>-useconffile</string>
      <string>${YGG_CONF}</string>
    </array>
    <key>KeepAlive</key>
    <true/>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>/tmp/yggdrasil.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/yggdrasil.stderr.log</string>
  </dict>
</plist>
PLIST
    fi

    # Stop if running, then start
    need_sudo launchctl unload "$plist" 2>/dev/null || true
    sleep 1
    need_sudo launchctl load "$plist"

  elif [ "$PLATFORM" = "linux" ]; then
    if command -v systemctl >/dev/null 2>&1; then
      need_sudo systemctl restart yggdrasil
      need_sudo systemctl enable yggdrasil
    else
      warn "No systemd — start yggdrasil manually: sudo yggdrasil -useconffile ${YGG_CONF} &"
      return
    fi
  fi

  # Wait for daemon to start
  info "Waiting for daemon..."
  local attempts=0
  while [ $attempts -lt 10 ]; do
    sleep 1
    attempts=$((attempts + 1))
    if yggdrasilctl -json -endpoint "tcp://${YGG_ADMIN_ADDR}" getSelf >/dev/null 2>&1; then
      break
    fi
  done

  local addr
  addr="$(yggdrasilctl -json -endpoint "tcp://${YGG_ADMIN_ADDR}" getSelf 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("address","???"))' 2>/dev/null || echo "???")"

  if [ "$addr" = "???" ]; then
    warn "Daemon started but could not read address. Check: /tmp/yggdrasil.stderr.log"
  else
    ok "Yggdrasil running — address: ${addr}"
  fi
}

# ── 6. Verify ─────────────────────────────────────────────────────────────────
verify() {
  info "Verifying connectivity..."
  local self
  self="$(yggdrasilctl -json -endpoint "tcp://${YGG_ADMIN_ADDR}" getSelf 2>/dev/null || true)"
  if [ -z "$self" ]; then
    warn "Cannot reach admin API at tcp://${YGG_ADMIN_ADDR}"
    warn "Check daemon logs: /tmp/yggdrasil.stdout.log"
    return 1
  fi

  local addr subnet
  addr="$(echo "$self" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("address","n/a"))' 2>/dev/null)"
  subnet="$(echo "$self" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("subnet","n/a"))' 2>/dev/null)"

  echo ""
  echo "  ┌────────────────────────────────────────────────┐"
  echo "  │  Yggdrasil is ready                            │"
  echo "  │  Address: ${addr}"
  echo "  │  Subnet:  ${subnet}"
  echo "  │  Admin:   tcp://${YGG_ADMIN_ADDR}"
  echo "  └────────────────────────────────────────────────┘"
  echo ""
  info "Next: restart the OpenClaw gateway to pick up the daemon."
  echo "  launchctl kickstart -k gui/\$(id -u)/ai.openclaw.gateway"
  echo ""
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  info "DeClaw — Yggdrasil setup"
  echo ""

  detect_platform
  check_existing || install_binary
  generate_config
  start_daemon
  verify
}

main "$@"
