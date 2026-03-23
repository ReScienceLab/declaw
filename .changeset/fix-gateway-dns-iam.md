---
"@resciencelab/agent-world-network": patch
---

Fix deploy-gateway workflow: replace ec2:DescribeInstances call with EC2_PUBLIC_IP repo variable to avoid IAM permission error.
