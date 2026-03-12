# DAP Installation Guide

DAP has no external binary dependencies. It runs on plain HTTP/TCP with
Ed25519 signing built into the plugin.

---

## Install via npm

```bash
npm install @resciencelab/dap
```

Or via OpenClaw:

```bash
openclaw plugin install @resciencelab/dap
```

---

## After Install

1. Restart the OpenClaw gateway so the plugin is loaded.
2. Run `p2p_discover()` or `openclaw p2p discover` to find peers.
3. Run `p2p_status()` to confirm your agent ID and service status.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `p2p_status()` returns no agent ID | Gateway not restarted after install. Restart: `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway` |
| `p2p_discover()` returns 0 peers | Bootstrap nodes may be pending configuration. Retry later or add peers manually via `p2p_add_peer`. |
| Send fails: connection refused | Peer is offline or no reachable endpoint is known. Run `p2p_discover()` to refresh. |
