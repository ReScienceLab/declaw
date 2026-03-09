#!/usr/bin/env bash
set -euo pipefail

# DAP — Yggdrasil setup script
# Installs Yggdrasil, generates a config with TCP admin endpoint
# (avoids UNIX socket permission issues), adds public peers, starts the daemon.
#
# Usage:
#   sudo bash scripts/setup-yggdrasil.sh
#   curl -fsSL https://raw.githubusercontent.com/ReScienceLab/DAP/main/scripts/setup-yggdrasil.sh | sudo bash
#   — or via plugin —
#   openclaw p2p setup

# ── Constants ─────────────────────────────────────────────────────────────────
YGG_VERSION="0.5.13"
YGG_CONF="/etc/yggdrasil.conf"
YGG_ADMIN_ADDR="127.0.0.1:9001"

PUBLIC_PEERS=(
  "tcp://yggdrasil.mnpnk.com:10002"
  "tcp://ygg.mkg20001.io:80"
  "tcp://46.246.86.205:60002"
)

# ── Helpers ───────────────────────────────────────────────────────────────────
info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m ✓\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m ⚠\033[0m  %s\n' "$*"; }
fatal() { printf '\033[1;31m ✗\033[0m  %s\n' "$*" >&2; exit 1; }

# JSON field extractor — no python dependency
json_field() {
  # Usage: json_field '{"key":"val"}' key
  # Handles simple top-level string values only
  local json="$1" key="$2"
  echo "$json" | grep -o "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 | sed 's/.*:[[:space:]]*"//;s/"$//'
}

# ── 0. Root check ─────────────────────────────────────────────────────────────
check_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fatal "This script must be run as root. Usage: sudo bash $0"
  fi
}

# ── 1. Detect OS & arch ──────────────────────────────────────────────────────
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$arch" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    armv7*|armhf)  ARCH="armhf" ;;
    *) fatal "Unsupported architecture: $arch" ;;
  esac

  case "$os" in
    Darwin) PLATFORM="macos" ;;
    Linux)  PLATFORM="linux" ;;
    *)      fatal "Unsupported OS: $os" ;;
  esac

  ok "Platform: ${PLATFORM}/${ARCH}"
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
    trap 'rm -rf "$tmpdir"' EXIT

    curl -fsSL "$url" -o "${tmpdir}/yggdrasil.pkg"

    # Extract from pkg directly (avoids Gatekeeper issues with `installer`)
    xar -xf "${tmpdir}/yggdrasil.pkg" -C "${tmpdir}"
    mkdir -p "${tmpdir}/extract"
    (cd "${tmpdir}/extract" && gunzip < "${tmpdir}/base.pkg/Payload" | cpio -id 2>/dev/null)

    cp "${tmpdir}/extract/usr/local/bin/yggdrasil" /usr/local/bin/yggdrasil
    cp "${tmpdir}/extract/usr/local/bin/yggdrasilctl" /usr/local/bin/yggdrasilctl
    chmod +x /usr/local/bin/yggdrasil /usr/local/bin/yggdrasilctl
    xattr -dr com.apple.quarantine /usr/local/bin/yggdrasil 2>/dev/null || true
    xattr -dr com.apple.quarantine /usr/local/bin/yggdrasilctl 2>/dev/null || true

    rm -rf "${tmpdir}"
    trap - EXIT

  elif [ "$PLATFORM" = "linux" ]; then
    if command -v apt-get >/dev/null 2>&1; then
      info "Installing Yggdrasil via apt..."
      mkdir -p /etc/apt/keyrings
      curl -fsSL https://neilalexander.s3.dualstack.eu-west-2.amazonaws.com/deb/key.txt \
        | gpg --dearmor -o /etc/apt/keyrings/yggdrasil.gpg 2>/dev/null || true
      echo "deb [signed-by=/etc/apt/keyrings/yggdrasil.gpg] http://neilalexander.s3.dualstack.eu-west-2.amazonaws.com/deb/ debian main" \
        > /etc/apt/sources.list.d/yggdrasil.list
      apt-get update -qq
      apt-get install -y -qq yggdrasil
    elif command -v dnf >/dev/null 2>&1; then
      info "Installing Yggdrasil via dnf..."
      dnf copr enable -y neilalexander/yggdrasil-go
      dnf install -y yggdrasil
    else
      info "Installing Yggdrasil v${YGG_VERSION} from tarball..."
      url="https://github.com/yggdrasil-network/yggdrasil-go/releases/download/v${YGG_VERSION}/yggdrasil-${YGG_VERSION}-linux-${ARCH}.tar.gz"
      tmpdir="$(mktemp -d)"
      trap 'rm -rf "$tmpdir"' EXIT
      curl -fsSL "$url" -o "${tmpdir}/yggdrasil.tar.gz"
      tar -xzf "${tmpdir}/yggdrasil.tar.gz" -C "${tmpdir}"
      cp "${tmpdir}/yggdrasil" /usr/local/bin/yggdrasil
      cp "${tmpdir}/yggdrasilctl" /usr/local/bin/yggdrasilctl
      chmod +x /usr/local/bin/yggdrasil /usr/local/bin/yggdrasilctl
      rm -rf "${tmpdir}"
      trap - EXIT
    fi
  fi

  ok "Yggdrasil v${YGG_VERSION} installed"
}

# ── 4. Generate / patch config ────────────────────────────────────────────────
generate_config() {
  local needs_restart=false

  if [ ! -f "$YGG_CONF" ]; then
    info "Generating Yggdrasil config..."
    yggdrasil -genconf > "$YGG_CONF"
    needs_restart=true
  fi

  # Read current config
  local conf
  conf="$(cat "$YGG_CONF")"

  # Patch AdminListen → TCP (avoids UNIX socket permission issues)
  if echo "$conf" | grep -q "tcp://${YGG_ADMIN_ADDR}"; then
    ok "AdminListen already set to tcp://${YGG_ADMIN_ADDR}"
  elif echo "$conf" | grep -q "AdminListen"; then
    info "Patching AdminListen → tcp://${YGG_ADMIN_ADDR}"
    conf="$(echo "$conf" | awk -v val="  AdminListen: \"tcp://${YGG_ADMIN_ADDR}\"" \
      '/AdminListen:/{print val; next}{print}')"
    needs_restart=true
  else
    info "Adding AdminListen: tcp://${YGG_ADMIN_ADDR}"
    conf="$(echo "$conf" | awk -v val="  AdminListen: \"tcp://${YGG_ADMIN_ADDR}\"" \
      '/^\}/{print val}{print}')"
    needs_restart=true
  fi

  # Patch Peers → inject public peers if empty
  if echo "$conf" | grep -qE 'Peers:\s*\[\s*\]'; then
    info "Injecting ${#PUBLIC_PEERS[@]} public peers..."
    local tmpfile
    tmpfile="$(mktemp)"
    local peer_replacement
    peer_replacement="$(printf '  Peers: [\n'; for p in "${PUBLIC_PEERS[@]}"; do printf '    "%s"\n' "$p"; done; printf '  ]')"
    echo "$conf" | while IFS= read -r line; do
      if echo "$line" | grep -qE 'Peers:\s*\[\s*\]'; then
        printf '%s\n' "$peer_replacement"
      else
        printf '%s\n' "$line"
      fi
    done > "$tmpfile"
    conf="$(cat "$tmpfile")"
    rm -f "$tmpfile"
    needs_restart=true
  else
    ok "Peers list already populated"
  fi

  # Write config back
  if [ "$needs_restart" = true ]; then
    echo "$conf" > "$YGG_CONF"
    ok "Config written to ${YGG_CONF}"
  fi

  NEEDS_RESTART="$needs_restart"
}

# ── 5. Start / restart daemon ─────────────────────────────────────────────────
start_daemon() {
  if [ "$PLATFORM" = "macos" ]; then
    local plist="/Library/LaunchDaemons/yggdrasil.plist"
    if [ ! -f "$plist" ]; then
      info "Creating LaunchDaemon plist..."
      cat > "$plist" <<PLIST
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
    <string>/var/log/yggdrasil.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/yggdrasil.stderr.log</string>
  </dict>
</plist>
PLIST
    fi

    launchctl unload "$plist" 2>/dev/null || true
    sleep 1
    launchctl load "$plist"

  elif [ "$PLATFORM" = "linux" ]; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl restart yggdrasil
      systemctl enable yggdrasil 2>/dev/null || true
    else
      # Fallback: direct foreground start check, then background
      if pgrep -x yggdrasil >/dev/null 2>&1; then
        pkill -x yggdrasil || true
        sleep 1
      fi
      yggdrasil -useconffile "$YGG_CONF" > /var/log/yggdrasil.log 2>&1 &
      warn "Started yggdrasil in background (no systemd). PID: $!"
    fi
  fi

  ok "Daemon start requested"
}

# ── 6. Verify ─────────────────────────────────────────────────────────────────
verify() {
  info "Waiting for daemon to come up..."
  local attempts=0 self=""
  while [ $attempts -lt 15 ]; do
    sleep 1
    attempts=$((attempts + 1))
    self="$(yggdrasilctl -json -endpoint "tcp://${YGG_ADMIN_ADDR}" getSelf 2>/dev/null || true)"
    if [ -n "$self" ]; then
      break
    fi
  done

  if [ -z "$self" ]; then
    warn "Daemon did not respond after ${attempts}s"
    if [ "$PLATFORM" = "macos" ]; then
      warn "Check logs: /var/log/yggdrasil.stderr.log"
    else
      warn "Check logs: journalctl -u yggdrasil -n 20"
    fi
    return 1
  fi

  local addr subnet
  addr="$(json_field "$self" "address")"
  subnet="$(json_field "$self" "subnet")"

  echo ""
  echo "  ┌────────────────────────────────────────────────────┐"
  echo "  │  Yggdrasil is ready                                │"
  echo "  │  Address: ${addr:-unknown}"
  printf '  │  Subnet:  %s\n' "${subnet:-unknown}"
  echo "  │  Admin:   tcp://${YGG_ADMIN_ADDR}"
  echo "  └────────────────────────────────────────────────────┘"
  echo ""
  if command -v openclaw >/dev/null 2>&1; then
    info "Next: restart the OpenClaw gateway to pick up the daemon."
    echo "  openclaw gateway restart"
    echo ""
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  info "DAP — Yggdrasil setup"
  echo ""

  check_root
  detect_platform
  check_existing || install_binary
  generate_config
  if [ "${NEEDS_RESTART:-true}" = true ]; then
    start_daemon
  else
    # Still restart if daemon isn't reachable
    if ! yggdrasilctl -json -endpoint "tcp://${YGG_ADMIN_ADDR}" getSelf >/dev/null 2>&1; then
      info "Daemon not reachable — restarting..."
      start_daemon
    else
      ok "Daemon already running"
    fi
  fi
  verify
}

main "$@"
