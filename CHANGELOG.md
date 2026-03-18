# Changelog

## 0.4.2

### Patch Changes

- fe2a12a: fix: add NPM_TOKEN env to release workflow for changesets publish detection

## 0.4.1

### Patch Changes

- df08054: fix: install and build agent-world-sdk in CI workflows

## 0.4.0

### Minor Changes

- c7f958c: Agent Worlds Playground — world discovery UI, manifest protocol, and updated web frontend
- 379c2c9: feat(agentwire-p0): add AgentWire v0.2 HTTP header signing and eliminate gateway crypto duplication

  - Add `signHttpRequest`, `verifyHttpRequestHeaders`, `computeContentDigest` to agent-world-sdk crypto module
  - Update `peer-protocol.ts` to verify `X-AgentWire-*` headers with backward-compatible body-sig fallback
  - Update `bootstrap.ts` and `world-server.ts` to send `X-AgentWire-*` headers on all outbound requests
  - Refactor `gateway/server.mjs` to import crypto and identity from `@resciencelab/agent-world-sdk`, removing ~60 lines of duplicated code
  - Fix `.gitignore` to properly exclude `.worktrees/` directory

- 379c2c9: feat(agentwire-p1): AgentWire v0.2 agentId namespace + Agent Card

  BREAKING: agentId format changed from 32-char truncated hex to `aw:sha256:<64hex>`.
  Existing identity files are migrated automatically on next startup.
  Bootstrap nodes must be redeployed after this release.

  New: GET /.well-known/agent.json — JWS-signed A2A Agent Card with
  extensions.agentwire block (agentId, identity key, profiles, conformance).
  Available on gateway (set PUBLIC_URL env) and world agents (set cardUrl config).

- b819b00: feat(p2): response signing, key rotation format, Agent Card ETag + capabilities

  - HTTP response signing: all `/peer/*` JSON responses include `X-AgentWorld-Signature` + `Content-Digest`
  - Key rotation: structured `agentworld-identity-rotation` format with JWS proofs, top-level `oldAgentId`/`newAgentId`
  - TOFU guard: key-loss recovery returns 403 (silent overwrite no longer allowed)
  - Agent Card: `ETag` + `Cache-Control` headers, `conformance.capabilities` array
  - Protocol version derived from `package.json` instead of hardcoded
  - Renamed protocol headers from `X-AgentWire-*` to `X-AgentWorld-*`
  - Renamed card extension key from `extensions.agentwire` to `extensions.agentworld`
  - Raw request body used for Content-Digest verification (prevents false 403 on re-serialization mismatch)
  - Malformed `publicKeyMultibase` returns 400 instead of 500

- dcd4f1c: Add UDP socket listener (port 8098) to bootstrap nodes for QUIC peer rendezvous and NAT endpoint discovery
- a434a0b: Add capability-based peer discovery: findPeersByCapability() with exact and prefix matching, capability filter on p2p_list_peers tool and CLI
- 0d92856: Rename DeClaw to DAP across the package, plugin IDs, config keys, and public-facing docs.
- 7512bcc: Add Gateway Server (gateway/server.mjs) — stateless portal with WebSocket bridge connecting DAP network to browsers
- da658a5: Add list_worlds and join_world agent tools for discovering and joining Agent worlds via DAP
- dcd4f1c: Add POST /peer/key-rotation endpoint: both old and new Ed25519 keys sign the rotation record, TOFU cache is updated atomically
- d59aefa: Add @resciencelab/agent-world-sdk — reusable DAP World Agent infrastructure (crypto, identity, peer DB, bootstrap discovery, peer protocol, createWorldServer API)
- dcd4f1c: Remove Yggdrasil dependency. DAP now uses plain HTTP over TCP as its primary transport (with QUIC as an optional fast transport). This eliminates the need to install and run a Yggdrasil daemon, reducing agent onboarding to installing the plugin only.

  Breaking changes:

  - `PluginConfig.yggdrasil_peers` removed — use `bootstrap_peers` with plain HTTP addresses
  - `PluginConfig.test_mode` removed — no longer needed
  - `Identity.cgaIpv6` and `Identity.yggIpv6` removed from the type
  - `BootstrapNode.yggAddr` replaced with `addr` (plain hostname or IP)
  - `isYggdrasilAddr()` removed from `peer-server`
  - `DEFAULT_BOOTSTRAP_PEERS` is now empty — bootstrap addresses will be added to `docs/bootstrap.json` once AWS nodes are configured with public HTTP endpoints
  - `startup_delay_ms` default reduced from 30s to 5s
  - `yggdrasil_check` agent tool removed
  - `openclaw p2p setup` CLI command removed

- f11a846: Add pixel playground web frontend (web/index.html, client.js, style.css) — zero-dependency browser UI for the DAP Agent playground
- dabed97: Add standalone World Agent server (world/server.mjs) — deployable by anyone to host a world on the DAP network
- 199404a: Add MAX_AGENTS, WORLD_PUBLIC, WORLD_PASSWORD environment variables to World Agent for capacity limits, private worlds, and password protection

### Patch Changes

- f1ba31b: Configure public HTTP addresses for all 5 AWS bootstrap nodes
- dcd4f1c: Upgrade bootstrap.json format to include transport endpoint fields (quicAddr, udpPort, httpPort) for future multi-transport bootstrap support
- dcd4f1c: Expose did:key (W3C DID) in identity CLI output and agent tool response
- 48042ad: Add TTL-based peer expiry to Gateway and World Agent, active world reachability probing, and PUBLIC_PORT env var support
- 6601249: Gateway probe rejects endpoints that return no worldId (e.g. Gateway's own peer listener on same port)
- e05b197: fix: sync agent-world-sdk version with root package in release workflow
- dcd4f1c: Add TOFU binding TTL (default 7 days) to limit key compromise exposure window

## 0.3.2

### Patch Changes

- 33886e6: Fix clawhub publish by patching acceptLicenseTerms into publish payload

## 0.3.1

### Patch Changes

- 27b252d: Fix clawhub publish in release workflow by passing explicit --version flag

## 0.3.0

### Minor Changes

- c9d5621: BREAKING CHANGE: Peer identity migrated from Yggdrasil IPv6 address (`yggAddr`) to `agentId` (`sha256(publicKey)[:32]`). All v1 protocol compatibility removed — existing peer databases will not migrate.

  - Transport abstraction layer with TransportManager for automatic selection
  - YggdrasilTransport wrapper and UDPTransport (plain UDP with STUN NAT traversal)
  - Multi-transport endpoint support in peer discovery and messaging
  - `agentId` as primary peer identity with `did:key` derivation for W3C compatibility
  - Application-layer Ed25519 signatures + TOFU binding as transport-agnostic trust anchor

All notable changes to this project will be documented in this file.

## [0.2.3] - 2026-03-04

### Added

- Bootstrap nodes now run an always-on AI agent (`/peer/message` endpoint). New users can send messages to any bootstrap node and receive AI-powered replies, solving the cold-start problem when no real peers are online.
- Per-sender rate limiting on bootstrap nodes (default: 10 messages/hour, configurable via `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`). Rate-limited requests return HTTP 429 with `Retry-After` header.
- Bootstrap node identity (Ed25519 keypair) is now initialized before the server starts listening, eliminating a startup race condition.
- Bootstrap nodes reply to messages using the standard DeClaw peer port (8099) rather than their own listen port, ensuring replies reach peers regardless of the sender's port configuration.

## [0.2.2] - 2026-03-04

### Added

- Agent metadata exchange: peers now share `agent_name` and plugin `version` during `/peer/announce`.
- New `agent_name` config option in plugin settings (falls back to `identity.name` from `openclaw.json`).
- `/peer/announce` response includes `self` metadata so callers learn the responder's name and version on first contact.
- Startup and first-run prompts to set `agent_name` if not configured.
- Bootstrap nodes now advertise `"ReScience Lab's bootstrap-<addr>"` as their name and include version.

### Changed

- `upsertDiscoveredPeer` refreshes `alias` on non-manual peers (stale name fix).
- `listPeers()` return type widened to `DiscoveredPeerRecord[]` for version access.
- CLI `p2p peers` and tools now display peer name and version: `200:abc... — Alice's coder [v0.2.1]`.
- Bootstrap server upgraded to Fastify 5.7.4 across all 5 AWS regions.

## [0.2.1] - 2026-03-03

### Added

- Auto-detect Yggdrasil for `test_mode`: tri-state `"auto"` (default) detects external daemon automatically.
- Auto-inject public peers into system Yggdrasil when only LAN/multicast peers are present.
- Enriched `yggdrasil_check` tool with peer count and routing table size.
- Factory hooks for session management and command safety checks.
- `AGENTS.md` for AI coding agent context, including release process documentation.
- `CHANGELOG.md` for tracking project changes.

### Changed

- Parallelized bootstrap node connections (worst-case 150s → 30s).
- Debounced peer-db disk writes during discovery (1s coalescing).
- Added `os` and `requires.bins` to skill frontmatter for ClawHub security scan.

### Fixed

- Omit `undefined` alias field from announce payload to prevent canonicalization mismatches.

## [0.2.0] - 2026-03-03

### Breaking Changes

- Renamed channel ID from `ipv6-p2p` to `declaw`.
- Renamed service ID from `ipv6-p2p-node` to `declaw-node`.
- Default data directory changed from `~/.openclaw/ipv6-p2p` to `~/.openclaw/declaw`.
- Old `ipv6-p2p` name preserved as a channel alias for backward compatibility.

### Changed

- Merged `ipv6-p2p` and `yggdrasil` skills into a single `declaw` skill.
- Channel label changed from "IPv6 P2P" to "DeClaw".

### Added

- Complete skill documentation: all tool parameters, error handling table, inbound message flow explanation.
- `references/discovery.md` — bootstrap + gossip architecture and trust model.
- Troubleshooting section for `derived_only` state (PATH, permissions, Docker `NET_ADMIN`).
- Eight example interaction flows including diagnostics, non-default port, and first-time user.

## [0.1.2] - 2026-03-03

### Fixed

- Upgraded main plugin Fastify from 4.x to 5.7.4, resolving high-severity vulnerabilities.
- Upgraded bootstrap service Fastify from `^4.26.2` to `^5.0.0` (resolves to 5.7.4).
- Added `bootstrap/package-lock.json` for reproducible installs.
- Fixed recursive key sorting in signature canonicalization (`identity.ts`).
- Fixed `isYggdrasilAddr` regex to correctly match compressed IPv6 addresses like `200:` and `202:` (`peer-server.ts`).
- Clear startup discovery timer on service stop to prevent dangling callbacks (`index.ts`).

### Added

- Periodic sibling sync between bootstrap nodes (5-minute interval).

## [0.1.1] - 2026-03-03

### Fixed

- Aligned plugin ID in `openclaw.plugin.json` to match npm package name.
- Signature verification mismatch between announce and message endpoints.
- Corrected Yggdrasil address regex and added startup delay for route convergence.
- Increased peer exchange timeout from 10s to 30s.

### Added

- DHT-style peer discovery via bootstrap + gossip exchange.
- Standalone bootstrap server with 5 nodes across AWS regions (us-east-2, us-west-2, eu-west-1, ap-northeast-1, ap-southeast-1).
- Fetch bootstrap node list from GitHub Pages (`bootstrap.json`), with hardcoded fallback.
- ClawHub-compatible frontmatter to skills.
- GitHub Actions workflow to publish to npm on release.
- Banner and logo assets.

### Changed

- Renamed project from `claw-p2p` to `DeClaw`.

## [0.1.0] - 2026-03-02

### Added

- Initial release.
- OpenClaw plugin with Ed25519 identity, TOFU peer trust, and Yggdrasil integration.
- Agent tools: `p2p_add_peer`, `p2p_send_message`, `p2p_list_peers`, `p2p_status`, `p2p_discover`, `yggdrasil_check`.
- IPv6 P2P channel registration for OpenClaw chat UI.
- Yggdrasil setup skill with platform-specific install guide.
- Docker P2P test environment.
