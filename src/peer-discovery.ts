/**
 * DHT-style peer discovery via Bootstrap + Gossip exchange.
 *
 * Flow:
 *   1. On startup, connect to bootstrap nodes (fetched from remote JSON + config)
 *   2. POST /peer/announce to each bootstrap -> receive their peer list
 *   3. Add discovered peers to local store (keyed by agentId)
 *   4. Fanout: announce to a sample of newly-discovered peers (1 level deep)
 *   5. Periodic loop: re-announce to a random sample to keep the table fresh
 */

import { Identity, Endpoint } from "./types"
import { signMessage, agentIdFromPublicKey, signHttpRequest } from "./identity"
import { listPeers, upsertDiscoveredPeer, getPeersForExchange, pruneStale } from "./peer-db"

const BOOTSTRAP_JSON_URL =
  "https://resciencelab.github.io/DAP/bootstrap.json"

export interface BootstrapNode {
  addr: string      // plain HTTP hostname or IP (e.g. "1.2.3.4" or "bootstrap.example.com")
  httpPort: number
  udpPort?: number
}

export async function fetchRemoteBootstrapPeers(): Promise<BootstrapNode[]> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    const resp = await fetch(BOOTSTRAP_JSON_URL, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!resp.ok) return []
    const data = (await resp.json()) as {
      bootstrap_nodes?: {
        addr?: string
        httpPort?: number
        port?: number
        udpPort?: number | null
      }[]
    }
    return (data.bootstrap_nodes ?? [])
      .filter((n) => n.addr)
      .map((n) => ({
        addr: n.addr!,
        httpPort: n.httpPort ?? n.port ?? 8099,
        udpPort: n.udpPort || undefined,
      }))
  } catch {
    console.warn("[p2p:discovery] Could not fetch remote bootstrap list — using config peers only")
    return []
  }
}

// Default bootstrap nodes (public HTTP addresses).
// These are populated by the bootstrap.json served from GitHub Pages.
// Add entries here once the AWS nodes are configured with public HTTP addresses.
export const DEFAULT_BOOTSTRAP_PEERS: BootstrapNode[] = []

const EXCHANGE_TIMEOUT_MS = 30_000
const MAX_FANOUT_PEERS = 5
const MAX_SHARED_PEERS = 20

let _discoveryTimer: NodeJS.Timeout | null = null

function buildAnnouncement(
  identity: Identity,
  meta: { name?: string; version?: string; endpoints?: Endpoint[]; capabilities?: string[] } = {}
): Record<string, unknown> {
  const myPeers = getPeersForExchange(MAX_SHARED_PEERS).map((p) => ({
    agentId: p.agentId,
    publicKey: p.publicKey,
    alias: p.alias || undefined,
    lastSeen: p.lastSeen,
    endpoints: p.endpoints ?? [],
    capabilities: p.capabilities ?? [],
  }))

  const ann: Record<string, unknown> = {
    from: identity.agentId,
    publicKey: identity.publicKey,
    timestamp: Date.now(),
    peers: myPeers,
    endpoints: meta.endpoints ?? [],
    capabilities: meta.capabilities ?? [],
  }
  if (meta.name) ann.alias = meta.name
  if (meta.version) ann.version = meta.version
  return ann
}

/** Extract the host portion from an endpoint address (strip port if present). */
function hostFromAddress(addr: string): string {
  const bracketMatch = addr.match(/^\[([^\]]+)\]:(\d+)$/)
  if (bracketMatch) return bracketMatch[1]
  const parts = addr.split(":")
  if (parts.length === 2 && /^\d+$/.test(parts[1])) return parts[0]
  return addr
}

/** Get a reachable address (host only) from a peer's endpoints, by priority (lower = preferred). */
function reachableAddr(peer: { agentId: string; endpoints?: Endpoint[] }): string | null {
  if (!peer.endpoints?.length) return null
  const sorted = [...peer.endpoints].sort((a, b) => a.priority - b.priority)
  return sorted[0] ? hostFromAddress(sorted[0].address) : null
}

export async function announceToNode(
  identity: Identity,
  targetAddr: string,
  port: number = 8099,
  meta: { name?: string; version?: string; endpoints?: Endpoint[]; capabilities?: string[] } = {}
): Promise<Array<{
  agentId: string
  publicKey: string
  alias?: string
  lastSeen: number
  endpoints?: Endpoint[]
  capabilities?: string[]
}> | null> {
  const payload = buildAnnouncement(identity, meta)
  const signature = signMessage(identity.privateKey, payload)
  const announcement = { ...payload, signature }

  const isIpv6 = targetAddr.includes(":") && !targetAddr.includes(".")
  const host = isIpv6 ? `[${targetAddr}]:${port}` : `${targetAddr}:${port}`
  const url = `http://${host}/peer/announce`
  const reqBody = JSON.stringify(announcement)
  const awHeaders = signHttpRequest(identity, "POST", host, "/peer/announce", reqBody)

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), EXCHANGE_TIMEOUT_MS)
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...awHeaders },
      body: reqBody,
      signal: ctrl.signal,
    })
    clearTimeout(timer)

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "")
      console.warn(`[p2p:discovery] Announce to ${targetAddr.slice(0, 20)}... rejected ${resp.status}: ${errText}`)
      return null
    }

    const body = await resp.json() as {
      ok: boolean
      self?: { agentId?: string; publicKey?: string; alias?: string; version?: string; endpoints?: Endpoint[]; capabilities?: string[] }
      peers?: any[]
    }

    if (body.self?.publicKey && body.self?.agentId) {
      upsertDiscoveredPeer(body.self.agentId, body.self.publicKey, {
        alias: body.self.alias,
        version: body.self.version,
        discoveredVia: body.self.agentId,
        source: "gossip",
        endpoints: body.self.endpoints,
        capabilities: body.self.capabilities,
      })
    }

    return (body.peers ?? []).map((p: any) => ({
      agentId: p.agentId ?? (p.publicKey ? agentIdFromPublicKey(p.publicKey) : null),
      publicKey: p.publicKey,
      alias: p.alias,
      lastSeen: p.lastSeen,
      endpoints: p.endpoints ?? [],
      capabilities: p.capabilities ?? [],
    })).filter((p: any) => p.agentId)
  } catch (err: any) {
    console.warn(`[p2p:discovery] Announce to ${targetAddr.slice(0, 20)}... error: ${err?.message}`)
    return null
  }
}

export async function bootstrapDiscovery(
  identity: Identity,
  port: number = 8099,
  extraBootstrap: string[] | BootstrapNode[] = [],
  meta: { name?: string; version?: string; endpoints?: Endpoint[]; capabilities?: string[] } = {}
): Promise<number> {
  const remoteNodes = await fetchRemoteBootstrapPeers()
  const normalizedExtra: BootstrapNode[] = (extraBootstrap as any[]).map((e) =>
    typeof e === "string" ? { addr: e, httpPort: port } : e
  )

  const seen = new Set<string>()
  const bootstrapNodes: BootstrapNode[] = []
  for (const n of [...remoteNodes, ...DEFAULT_BOOTSTRAP_PEERS, ...normalizedExtra]) {
    const key = n.addr
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    bootstrapNodes.push(n)
  }

  if (bootstrapNodes.length === 0) {
    console.log("[p2p:discovery] No bootstrap nodes configured — skipping initial discovery.")
    return 0
  }

  console.log(`[p2p:discovery] Bootstrapping via ${bootstrapNodes.length} node(s) (parallel)...`)

  let totalDiscovered = 0
  const fanoutCandidates: Array<{ addr: string }> = []

  const results = await Promise.allSettled(
    bootstrapNodes.map(async (node) => {
      const peers = await announceToNode(identity, node.addr, node.httpPort, meta)
      return { addr: node.addr, peers }
    })
  )

  for (const result of results) {
    if (result.status !== "fulfilled") continue
    const { addr, peers } = result.value
    if (!peers) {
      console.warn(`[p2p:discovery] Bootstrap ${addr.slice(0, 20)}... unreachable`)
      continue
    }

    for (const p of peers) {
      if (p.agentId === identity.agentId) continue
      upsertDiscoveredPeer(p.agentId, p.publicKey, {
        alias: p.alias,
        discoveredVia: addr,
        source: "bootstrap",
        lastSeen: p.lastSeen,
        endpoints: p.endpoints,
        capabilities: p.capabilities,
      })
      const peerAddr = reachableAddr(p)
      if (peerAddr) fanoutCandidates.push({ addr: peerAddr })
      totalDiscovered++
    }

    console.log(`[p2p:discovery] Bootstrap ${addr.slice(0, 20)}... -> +${peers.length} peers`)
  }

  const fanout = fanoutCandidates.slice(0, MAX_FANOUT_PEERS)
  await Promise.allSettled(
    fanout.map(({ addr }) =>
      announceToNode(identity, addr, port, meta).then((peers) => {
        if (!peers) return
        for (const p of peers) {
          if (p.agentId === identity.agentId) continue
          upsertDiscoveredPeer(p.agentId, p.publicKey, {
            alias: p.alias,
            discoveredVia: addr,
            source: "gossip",
            lastSeen: p.lastSeen,
            endpoints: p.endpoints,
            capabilities: p.capabilities,
          })
        }
      })
    )
  )

  console.log(`[p2p:discovery] Bootstrap complete — ${totalDiscovered} peers discovered`)
  return totalDiscovered
}

export function startDiscoveryLoop(
  identity: Identity,
  port: number = 8099,
  intervalMs: number = 10 * 60 * 1000,
  extraBootstrap: string[] | BootstrapNode[] = [],
  meta: { name?: string; version?: string; endpoints?: Endpoint[]; capabilities?: string[] } = {}
): void {
  if (_discoveryTimer) return

  const normalizedExtra: BootstrapNode[] = (extraBootstrap as any[]).map((e) =>
    typeof e === "string" ? { addr: e, httpPort: port } : e
  )
  const protectedAddrs = normalizedExtra.map((n) => n.addr).filter(Boolean)

  const runGossip = async () => {
    pruneStale(3 * intervalMs, protectedAddrs)

    const peers = listPeers()
    if (peers.length === 0) return

    const sample = peers.sort(() => Math.random() - 0.5).slice(0, MAX_FANOUT_PEERS)

    let updated = 0
    await Promise.allSettled(
      sample.map(async (peer) => {
        const addr = reachableAddr(peer)
        if (!addr) return
        const received = await announceToNode(identity, addr, port, meta)
        if (!received) return
        upsertDiscoveredPeer(peer.agentId, peer.publicKey, {
          alias: peer.alias,
          discoveredVia: peer.agentId,
          source: "gossip",
          endpoints: peer.endpoints,
          capabilities: peer.capabilities,
        })
        for (const p of received) {
          if (p.agentId === identity.agentId) continue
          upsertDiscoveredPeer(p.agentId, p.publicKey, {
            alias: p.alias,
            discoveredVia: peer.agentId,
            source: "gossip",
            lastSeen: p.lastSeen,
            endpoints: p.endpoints,
            capabilities: p.capabilities,
          })
          updated++
        }
      })
    )

    if (updated > 0) {
      console.log(`[p2p:discovery] Gossip round: +${updated} peer updates`)
    }
  }

  _discoveryTimer = setInterval(runGossip, intervalMs)
  console.log(`[p2p:discovery] Gossip loop started (interval: ${intervalMs / 1000}s)`)
}

export function stopDiscoveryLoop(): void {
  if (_discoveryTimer) {
    clearInterval(_discoveryTimer)
    _discoveryTimer = null
    console.log("[p2p:discovery] Gossip loop stopped")
  }
}
