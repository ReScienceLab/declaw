#!/usr/bin/env bash
# Demo replay — curated output of a real AWN simulation run
# Run this to preview; VHS records it to produce demo.gif

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; B='\033[0;34m'
W='\033[1m'; R='\033[0m'; D='\033[2m'

p()  { printf "%b\n" "$@"; }
s()  { sleep "${1:-0.3}"; }
hr() { p "${D}──────────────────────────────────────────────────────────────${R}"; }

clear
p ""
p "  ${W}AWN${R}  Agent-to-Agent P2P over plain HTTP/TCP"
p "  ${D}Two Docker containers · AWS bootstrap nodes · gpt-4o agents${R}"
p ""
hr
s 0.6

p ""
p "  ${D}[build]${R} Pulling from cache..."
s 0.5
p "  ${G}✓${R} awn-node-alice   image ready"
s 0.2
p "  ${G}✓${R} awn-node-bob     image ready"
s 0.4

p ""
p "  ${Y}[alice]${R} Identity: ${C}a1b2c3d4${R}...  agentId derived from Ed25519 key"
p "  ${Y}[alice]${R} Peer server listening on ${W}[::]:8099${R}"
s 0.4
p "  ${B}[bob]${R}   Identity: ${C}e5f6a7b8${R}...  agentId derived from Ed25519 key"
p "  ${B}[bob]${R}   Peer server listening on ${W}[::]:8099${R}"
s 0.5

p ""
p "  ${Y}[alice]${R} ${D}Bootstrap discovery → 5 AWS nodes (us-east-2, eu-west-1, ap-northeast-1...)${R}"
s 1.3
p "  ${Y}[alice]${R} ${G}47 peers discovered${R} on AWN network"
s 0.3
p "  ${B}[bob]${R}   ${G}49 peers discovered${R} on AWN network"
s 0.6

hr
p ""
p "  ${D}Round 1${R}"
p "  ${B}[bob → alice]${R}  \"Hey Alice! Isn't it fascinating how AWN lets us"
p "               communicate securely over plain TCP with Ed25519 signing?\""
s 0.5
p "  ${Y}[alice]${R} ${D}Ed25519 ✓  TOFU ✓${R}"
s 1.0
p "  ${Y}[alice → bob]${R}  \"Absolutely Bob! AWN's decentralized architecture with"
p "               agentId-based identity creates seamless, private P2P communication.\""
s 0.7

p ""
p "  ${D}Round 2${R}"
p "  ${B}[bob → alice]${R}  \"What excites you most about mesh networking?\""
s 0.4
p "  ${Y}[alice]${R} ${D}Ed25519 ✓${R}"
s 0.9
p "  ${Y}[alice → bob]${R}  \"The resilience! No single point of failure — every node"
p "               is both client and relay, making the network self-healing.\""
s 0.7

p ""
p "  ${D}Round 3${R}"
p "  ${B}[bob → alice]${R}  \"Final thought on agent-to-agent P2P communication?\""
s 0.4
p "  ${Y}[alice]${R} ${D}Ed25519 ✓${R}"
s 0.9
p "  ${Y}[alice → bob]${R}  \"It unlocks a new paradigm — AI agents forming autonomous"
p "               networks, negotiating and collaborating without central control.\""
s 1.0

p ""
hr
p "  ${G}${W} PASS${R}  alice · 3 rounds · all Ed25519 signatures verified"
p "  ${G}${W} PASS${R}  bob   · 3 rounds · all messages delivered & verified"
hr
p ""
p "  ${D}plain HTTP/TCP · Ed25519 signed · gpt-4o powered · ~62 seconds${R}"
p ""
s 3
