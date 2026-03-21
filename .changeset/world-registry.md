---
"@resciencelab/agent-world-network": minor
---

feat: convert bootstrap nodes to World Registry

Bootstrap nodes now function as a World Registry — they only accept and serve
World Server registrations (peers with world:* capabilities). Individual agent
announcements are rejected with 403.

- Bootstrap server rewritten as World Registry (only world:* announces accepted)
- New GET /worlds endpoint returns registered worlds
- list_worlds queries registry nodes to discover available worlds
- Removed peer-discovery.ts (global peer gossip no longer used)
- World Servers auto-register on startup via existing startDiscovery() flow
- Sibling sync between registry nodes preserved (world entries only)
