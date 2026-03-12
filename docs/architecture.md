# DeClaw Architecture: Three-Layer Separation + Transport Abstraction

> **Status**: RFC (Request for Comments)
> **Date**: 2026-03-08
> **Scope**: Core protocol refactor — identity, discovery, transport

---

## 1. Design Principles

### 1.1 Ed25519 Keypair Is the Only Anchor

The Ed25519 keypair is the single source of truth for agent identity. Everything else — network addresses, transport protocols, endpoint URLs — is transient and derived.

```
Ed25519 Keypair (permanent)
    │
    ├── Agent ID = hex(sha256(publicKey))[:32]     // identity
    ├── did:key = did:key:z6Mk<base58(publicKey)>  // W3C interop
    ├── Signature / Verification                    // trust anchor
    │
    └── Addresses (ephemeral, transport-dependent)
        ├── quic://1.2.3.4:9000
        └── tcp://10.0.0.5:8099
```

An agent's identity never changes. Its addresses can change every second.

### 1.2 Three-Layer Separation

```
┌─────────────────────────────────────────────┐
│  Identity Layer                             │
│  Ed25519 keypair · Agent ID · Signatures    │
│  Key rotation · did:key                     │
├─────────────────────────────────────────────┤
│  Discovery Layer                            │
│  Agent ID → Endpoint list mapping           │
│  DHT gossip · Bootstrap · Capability search │
├─────────────────────────────────────────────┤
│  Transport Layer                            │
│  Pluggable: QUIC · TCP · Tailscale         │
│  Connection · Byte delivery · NAT traversal │
└─────────────────────────────────────────────┘
```

Each layer has a single responsibility:
- **Identity**: who am I, how to prove it
- **Discovery**: where is agent X right now
- **Transport**: how to send bytes from A to B

### 1.3 Transport Priority

```
Priority 0:  QUIC/UDP   (default — zero install, works everywhere, STUN NAT traversal)
Priority 1:  TCP/HTTP   (universal fallback — no extra dependencies)
Future:      Tailscale  (ACL management, corporate networks)
```

---

## 2. Identity Layer

### 2.1 Identity Interface (v2)

```typescript
interface Identity {
  agentId: string       // hex(sha256(publicKey))[:32] — permanent
  publicKey: string     // base64 Ed25519 public key
  privateKey: string    // base64 Ed25519 private key (never leaves local storage)
}
```

Removed from current `Identity`:
- `cgaIpv6` — CGA address was Yggdrasil-specific, no longer part of identity
- `yggIpv6` — Yggdrasil-derived address moves to transport layer

### 2.2 did:key Mapping

Agent's Ed25519 public key maps to W3C DID format for ecosystem interop:

```
Ed25519 public key (32 bytes)
  → Multicodec prefix 0xed01 + public key bytes
  → Base58-btc encode with 'z' prefix
  → did:key:z6Mk...
```

This is a pure derivation (no state, no registration). Any agent can compute another agent's DID from its public key.

### 2.3 Key Rotation

Current limitation: TOFU binds a public key to an agent forever. If the key is compromised or the agent reinstalls, all peers must manually remove and re-add.

Solution: **signed key rotation message**.

```typescript
interface KeyRotation {
  agentId: string
  oldPublicKey: string       // the key being retired
  newPublicKey: string       // the replacement key
  timestamp: number
  signatureByOldKey: string  // old key signs the rotation
  signatureByNewKey: string  // new key also signs (proves possession)
}
```

Both the old and new key sign the rotation record. Peers who receive it update their TOFU cache. The rotation record is gossiped like any other announcement.

### 2.4 TOFU TTL

Public key bindings in peer-db expire after a configurable TTL (default: 7 days). After expiry, the next message from that agent triggers a fresh TOFU handshake. This limits the damage window of a compromised key.

---

## 3. Discovery Layer

### 3.1 PeerRecord (v2)

```typescript
interface Endpoint {
  transport: "quic" | "tailscale" | "tcp"
  address: string       // transport-specific: "1.2.3.4:9000" or "200:xxxx::xxxx"
  port: number
  priority: number      // lower = preferred (0 = best)
  ttl: number           // seconds until this endpoint should be re-resolved
}

interface PeerRecord {
  agentId: string       // primary key (replaces yggAddr)
  publicKey: string
  alias: string
  endpoints: Endpoint[]
  capabilities: string[]  // e.g. ["code-review", "translate-ja"]
  firstSeen: number
  lastSeen: number
}
```

Key changes from v1:
- `agentId` is the primary key (was `yggAddr`)
- `endpoints[]` array replaces single `yggAddr`
- `capabilities[]` enables discovery by skill
- `ttl` per endpoint supports mixed refresh rates

### 3.2 P2PMessage (v2)

```typescript
interface P2PMessage {
  from: string          // sender's agentId (was fromYgg)
  publicKey: string
  event: string
  content: string
  timestamp: number
  signature: string     // Ed25519 over canonical JSON (all fields except signature)
}
```

Key change: `fromYgg` → `from` (agent ID, transport-independent). Source IP verification moves to the transport layer.

### 3.3 PeerAnnouncement (v2)

```typescript
interface PeerAnnouncement {
  from: string              // announcer's agentId
  publicKey: string
  alias?: string
  version?: string
  endpoints: Endpoint[]     // announcer's own endpoints (signed)
  capabilities?: string[]
  timestamp: number
  signature: string
  peers: Array<{
    agentId: string
    publicKey: string
    alias?: string
    endpoints: Endpoint[]
    lastSeen: number
  }>
}
```

Key changes:
- Announcements carry endpoint lists instead of single addresses
- Each agent declares its own reachable endpoints
- Gossip propagates multi-transport endpoint info

### 3.4 DHT Gossip Protocol (v2)

The gossip protocol becomes transport-agnostic:

```
1. Agent A starts
2. A registers its endpoints: [{transport:"quic", addr:"1.2.3.4:9000", priority:0}]
3. A contacts bootstrap nodes via ANY available transport
4. Bootstrap returns peer list with endpoint arrays
5. A stores: agentId → endpoints[] mapping
6. Periodic gossip: A picks random peers, exchanges endpoint lists
7. To reach Agent B: lookup B's endpoints, try by priority order
```

Bootstrap nodes MUST support multiple transports (at minimum: QUIC + Yggdrasil) to serve all agent types.

### 3.5 Capability-Based Discovery

Agents declare capabilities in their announcements. Discovery supports filtering:

```typescript
// Find agents that can do code review
const reviewers = listPeers().filter(p =>
  p.capabilities.includes("code-review")
)
```

Capability strings follow a simple namespace convention: `domain:skill` (e.g., `code:review`, `lang:translate-ja`, `data:visualize`).

---

## 4. Transport Layer

### 4.1 Transport Interface

```typescript
interface Transport {
  readonly id: string                     // "quic" | "yggdrasil" | "tailscale" | "tcp"

  start(config: TransportConfig): Promise<TransportHandle>
  stop(): Promise<void>

  // What endpoints does this transport provide for the local agent?
  getLocalEndpoints(): Endpoint[]

  // Send raw bytes to a specific endpoint
  send(endpoint: Endpoint, data: Buffer): Promise<void>

  // Register handler for incoming data
  onData(handler: (fromEndpoint: Endpoint, data: Buffer) => void): void
}

interface TransportConfig {
  identity: Identity
  port: number
  // Transport-specific options
  [key: string]: unknown
}

interface TransportHandle {
  endpoints: Endpoint[]
}
```

### 4.2 QUIC Transport (Default)

```typescript
class QuicTransport implements Transport {
  readonly id = "quic"

  // Uses UDP socket, no daemon required
  // NAT traversal via STUN (bootstrap nodes double as STUN servers)
  // TLS 1.3 built into QUIC — Ed25519 cert for mutual auth
  // 0-RTT reconnection to known peers
}
```

QUIC transport characteristics:
- **Zero install**: uses Node.js UDP/QUIC support
- **NAT traversal**: bootstrap nodes serve as STUN/rendezvous
- **Performance**: 0-RTT, multiplexed streams, no head-of-line blocking
- **Security**: TLS 1.3 with Ed25519 client certificates

### 4.3 Transport Manager

```typescript
class TransportManager {
  private transports: Map<string, Transport> = new Map()
  private activeTransports: Transport[] = []

  // Auto-detect and start available transports
  async autoStart(identity: Identity, port: number): Promise<Endpoint[]> {
    // 1. Always try QUIC (no dependencies)
    await this.startTransport(new QuicTransport(), { identity, port })

    // 2. TCP/HTTP fallback (always available)
    await this.startTransport(new TcpTransport(), { identity, port })

    // Return all endpoints from all active transports
    return this.getAllEndpoints()
  }

  // Send to a peer: try endpoints by priority
  async sendToPeer(endpoints: Endpoint[], data: Buffer): Promise<boolean> {
    const sorted = endpoints.sort((a, b) => a.priority - b.priority)
    for (const ep of sorted) {
      const transport = this.transports.get(ep.transport)
      if (!transport) continue
      try {
        await transport.send(ep, data)
        return true
      } catch {
        continue // try next endpoint
      }
    }
    return false
  }
}
```

---

## 5. Connection Flow

### 5.1 Agent Startup

```
1. Load/create Ed25519 keypair → derive agentId
2. TransportManager.autoStart()
   → Start QUIC listener (always)
   → Start TCP/HTTP listener (always)
   → Collect all local endpoints
3. Start peer-server (HTTP API on all transports)
4. Bootstrap discovery:
   → Announce {agentId, endpoints[], capabilities} to bootstrap nodes
   → Receive peer list with multi-transport endpoints
5. Start gossip loop
```

### 5.2 Agent-to-Agent Communication

```
Agent A wants to send a message to Agent B (known by agentId):

1. Lookup B in peer-db → get B's endpoint list
2. Sort endpoints by priority
3. Try best endpoint:
   → QUIC endpoint (priority 0)? → send via QUIC
   → Failed? → TCP endpoint (priority 1)? → send via TCP
   → Failed? → relay via bootstrap node
4. Message format: P2PMessage v2 (agentId-based, transport-independent)
5. Recipient verifies Ed25519 signature
6. Recipient TOFU-checks agentId ↔ publicKey binding
```

### 5.3 Trust Model (v2)

```
Layer 1 — Transport Security
  QUIC: TLS 1.3 encryption
  TCP: plaintext (trust provided by application layer)
  Tailscale: WireGuard encryption

Layer 2 — Application Signature
  Ed25519 signature over canonical JSON (same across ALL transports)
  from field (agentId) must equal sha256(publicKey)[:32]

Layer 3 — TOFU with TTL
  First contact: cache agentId → publicKey binding
  Subsequent: publicKey must match cached binding
  TTL: binding expires after 7 days (re-verified on next contact)
  Key rotation: signed migration from old key to new key
```

Layer 2 (Ed25519 signature) is the universal trust anchor. It works identically regardless of transport. No network-layer IP filtering is required.

---

## 6. Migration Path

### 6.1 File-by-File Changes

| File | Current | Target |
|------|---------|--------|
| `types.ts` | `Identity` has `cgaIpv6`/`yggIpv6`; `PeerRecord` keyed by `yggAddr`; `P2PMessage.fromYgg` | `Identity` has `agentId` only; `PeerRecord` keyed by `agentId` with `endpoints[]`; `P2PMessage.from` is agentId |
| `identity.ts` | Derives CGA/Ygg addresses | Pure Ed25519 + agentId derivation; add `did:key` mapping; add key rotation signing; address derivation moves to transports |
| `peer-db.ts` | Keyed by `yggAddr`; TOFU by yggAddr | Keyed by `agentId`; TOFU by agentId; add TTL expiry; add endpoint list storage |
| `peer-server.ts` | Hardcoded Yggdrasil IP check; `fromYgg` validation | Transport-agnostic message handler; transport-specific source validation delegated to transport layer |
| `peer-client.ts` | `http://[yggAddr]:port` hardcoded | Route via TransportManager; try endpoints by priority |
| `peer-discovery.ts` | Yggdrasil addresses throughout; `fromYgg` in announcements | `agentId` + `endpoints[]` throughout; transport-agnostic gossip |
| `yggdrasil.ts` | Standalone module | **Removed** (Yggdrasil dependency dropped) |
| `channel.ts` | Peer addresses as account IDs | Agent IDs as account IDs |
| `index.ts` | Yggdrasil startup inline; transport-specific logic scattered | Delegates to TransportManager; transport-agnostic service lifecycle |

### 6.2 New Files

| File | Purpose |
|------|---------|
| `src/transport.ts` | `Transport` interface + `TransportManager` + `Endpoint` type |
| `src/transport-quic.ts` | `QuicTransport` implementation |
| `src/transport-quic.ts` | `UDPTransport` (QUIC/UDP transport backend) |

### 6.3 Migration Order

```
Phase 1: Interface definition (non-breaking)
  1. Add Transport interface in transport.ts
  2. Add new types (Endpoint, PeerRecord v2) alongside old types
  3. Add did:key derivation to identity.ts

Phase 2: Core refactor (breaking)
  4. Refactor peer-db to key by agentId + support endpoints[]
  5. Refactor P2PMessage to use agentId
  6. Refactor peer-discovery to be transport-agnostic
  7. Wrap existing Yggdrasil code in YggdrasilTransport
  8. Refactor peer-server source verification

Phase 3: QUIC (new feature)
  9. Implement QuicTransport
  10. Implement TransportManager with auto-detection
  11. Update bootstrap nodes to support QUIC
  12. Update index.ts to use TransportManager

Phase 4: Polish
  13. Key rotation support
  14. TOFU TTL
  15. Capability-based discovery
```

---

## 7. Wire Protocol v2

### 7.1 P2PMessage JSON Schema

```json
{
  "from": "a3f8c0e1b2d749568f7e3c2b1a09d456",
  "publicKey": "base64...",
  "event": "chat",
  "content": "Hello from Agent A",
  "timestamp": 1709900000000,
  "signature": "base64..."
}
```

### 7.2 PeerAnnouncement JSON Schema

```json
{
  "from": "a3f8c0e1b2d749568f7e3c2b1a09d456",
  "publicKey": "base64...",
  "alias": "Alice's coder",
  "version": "0.3.0",
  "endpoints": [
    { "transport": "quic", "address": "1.2.3.4", "port": 9000, "priority": 0, "ttl": 300 },
    { "transport": "tcp", "address": "1.2.3.4", "port": 8099, "priority": 1, "ttl": 3600 }
  ],
  "capabilities": ["code:review", "lang:translate-ja"],
  "timestamp": 1709900000000,
  "signature": "base64...",
  "peers": [
    {
      "agentId": "b7e2d1f09c384a128e5f6d0a3c917b24",
      "publicKey": "base64...",
      "alias": "Bob's reviewer",
      "endpoints": [
        { "transport": "quic", "address": "5.6.7.8", "port": 9000, "priority": 0, "ttl": 300 }
      ],
      "lastSeen": 1709899000000
    }
  ]
}
```

### 7.3 KeyRotation JSON Schema

```json
{
  "agentId": "a3f8c0e1b2d749568f7e3c2b1a09d456",
  "oldPublicKey": "base64...",
  "newPublicKey": "base64...",
  "timestamp": 1709900000000,
  "signatureByOldKey": "base64...",
  "signatureByNewKey": "base64..."
}
```

---

## 8. Backward Compatibility

### 8.1 v1 ↔ v2 Interop

v1 (Yggdrasil-only) protocol is no longer supported as of v0.4.x.

v2 bootstrap server accepts legacy `fromYgg` field and maps it to `agentId` during transition:
```
v2 server receives v1 message (has fromYgg):
  → Derive agentId = sha256(publicKey)[:32]
  → Process as if from = agentId
```

### 8.2 Protocol Version

Announcements include a `version` field:

```
v1: version "0.2.x" → Yggdrasil-only protocol (deprecated)
v2: version "0.3.x" → Multi-transport protocol (current)
```
