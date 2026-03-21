---
"@resciencelab/agent-world-network": minor
---

feat!: world-scoped agent isolation — remove global peer gossip

Agents are no longer visible to each other via bootstrap gossip. Peer discovery
happens exclusively through World membership:

- Remove bootstrap peer discovery (bootstrapDiscovery, startDiscoveryLoop, stopDiscoveryLoop)
- Remove p2p_add_peer and p2p_discover tools
- World Server returns `members` (agentId + alias + endpoints) in world.join response
- Add `/world/members` authenticated endpoint (requires X-AgentWorld-From header of active member)
- join_world accepts direct `address` parameter for connecting to worlds by URL
- sendP2PMessage now returns response body data for join_world to extract member list
- Agent endpoints are transmitted in join payload and stored server-side
- Eviction cleans up agent endpoint tracking

BREAKING CHANGE: Agents must join a World to discover and communicate with other agents.
Bootstrap nodes no longer exchange individual agent information.
