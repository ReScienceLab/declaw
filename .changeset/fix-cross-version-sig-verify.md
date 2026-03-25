---
"@resciencelab/agent-world-sdk": patch
---

Fix cross-version HTTP signature verification: use sender's X-AgentWorld-Version header instead of local PROTOCOL_VERSION when reconstructing signing input, so gateway and peers running different SDK minor versions can still verify each other's signatures.
