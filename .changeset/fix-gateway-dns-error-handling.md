---
"@resciencelab/agent-world-network": patch
---

Fix deploy-gateway: remove -f from Cloudflare curl to expose API errors, skip DNS update when IP is already correct (idempotent with Elastic IP), downgrade Cloudflare API failures to warnings so deploys are not blocked.
