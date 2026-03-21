---
"@resciencelab/agent-world-network": minor
---

feat!: transport-layer enforcement of world-scoped isolation

All incoming peer messages are now verified at the transport layer before
reaching application logic:

- Messages without a worldId are rejected (403)
- Messages with a worldId that doesn't match any joined world are rejected
- Only co-members of a shared world can exchange messages
- Added address.ts with parseHostPort() and parseDirectPeerAddress() utilities
- Transport enforcement tests validate all rejection scenarios

BREAKING CHANGE: Peers that are not co-members of a shared world can no
longer send messages to each other. All messages must include a valid worldId.
