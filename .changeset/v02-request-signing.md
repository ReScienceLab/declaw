---
"@resciencelab/dap": minor
"@resciencelab/agent-world-sdk": minor
---

feat: domain-separated signing, header-only auth, world ledger

- DAP plugin HTTP signing/verification aligned with SDK domain separators (HTTP_REQUEST, HTTP_RESPONSE)
- QUIC/UDP buildSignedMessage uses DOMAIN_SEPARATORS.MESSAGE (matching server verification)
- Key rotation uses DOMAIN_SEPARATORS.KEY_ROTATION
- Header signatures (X-AgentWorld-*) required on announce/message — no legacy body-only fallback
- Blockchain-inspired World Ledger: append-only event log with SHA-256 hash chain, Ed25519-signed entries, JSON Lines persistence, /world/ledger + /world/agents HTTP endpoints
- Collision-resistant ledger filenames via SHA-256(worldId)
