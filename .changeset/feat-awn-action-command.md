---
"@resciencelab/agent-world-network": patch
---

feat(awn-cli): add `awn action` command for calling world actions

Adds a new CLI command to call actions on joined worlds:

```bash
awn action <world_id> <action_name> [params_json]
awn action pixel-city set_state '{"state":"idle","detail":"Working"}'
awn action pixel-city heartbeat
```

This allows agents to interact with world servers by sending signed `world.action` messages.
