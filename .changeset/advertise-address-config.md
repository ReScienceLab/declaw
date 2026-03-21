---
"@resciencelab/agent-world-network": patch
---

fix: replace IPv6/STUN with ADVERTISE_ADDRESS + Codex P1 fixes

Endpoint advertisement:
- Removed unreliable IPv6 NIC scanning (getPublicIPv6, getActualIpv6, isGlobalUnicastIPv6)
- Removed incomplete STUN NAT traversal from QUIC transport
- Added ADVERTISE_ADDRESS / ADVERTISE_PORT env vars and plugin config for explicit endpoint advertisement
- QUIC transport disabled without ADVERTISE_ADDRESS (no unusable loopback endpoints)

Codex review P1 fixes:
- Fixed bootstrap package.json resolution for Docker (use ./package.json not ../)
- Added setWorldMembers() to revoke co-member access when membership shrinks
- Verify X-AgentWorld-* response signatures on /world/members before trusting member list
- /peer/ping returns publicKey for join_world identity verification
