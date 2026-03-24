---
"@resciencelab/agent-world-network": minor
---

Rename gateway HTTP endpoints to resource-oriented paths: /peer/* routes replaced by /agents, /messages, /ping; /world/:worldId corrected to /worlds/:worldId; added GET /agents/:agentId, DELETE /agents/:agentId, and separate POST /worlds/:worldId/heartbeat for world servers
