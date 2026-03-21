# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report vulnerabilities privately:

1. **Email**: Send details to the maintainers via the [ReScienceLab organization](https://github.com/ReScienceLab) contact
2. **GitHub**: Use [private vulnerability reporting](https://github.com/ReScienceLab/agent-world-network/security/advisories/new)

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to Expect

- Acknowledgment within 48 hours
- Status update within 7 days
- Fix timeline depends on severity (critical: ASAP, high: 7 days, medium: 30 days)

## Security Model

AWN uses a 3-layer trust model:

1. **Application layer**: Ed25519 signature over canonical JSON payload
2. **TOFU**: First-seen public key is pinned; subsequent messages must match
3. **Identity binding**: agentId is derived from public key (sha256[:32]) — unforgeable

### Sensitive Data

- **Ed25519 private keys** (`~/.openclaw/awn/identity.json`) — never logged or transmitted

### Bootstrap Nodes

- TOFU key mismatch returns 403 with explicit error
- Rate-limited to prevent spam (configurable per-agent window)
