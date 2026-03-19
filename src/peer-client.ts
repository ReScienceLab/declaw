/**
 * P2P client — sends signed messages to other DAP nodes.
 *
 * Delivery strategy by endpoint priority:
 *   1. QUIC/UDP transport (if available)
 *   2. HTTP over TCP (direct fallback)
 */
import * as nacl from "tweetnacl"
import { P2PMessage, Identity, Endpoint } from "./types"
import { signWithDomainSeparator, DOMAIN_SEPARATORS, signHttpRequest } from "./identity"
import { Transport } from "./transport"

function buildSignedMessage(identity: Identity, event: string, content: string): P2PMessage {
  const timestamp = Date.now()
  const payload: Omit<P2PMessage, "signature"> = {
    from: identity.agentId,
    publicKey: identity.publicKey,
    event,
    content,
    timestamp,
  }
  const privFull = nacl.sign.keyPair.fromSeed(Buffer.from(identity.privateKey, "base64"))
  const signature = signWithDomainSeparator(DOMAIN_SEPARATORS.MESSAGE, payload, privFull.secretKey)
  return { ...payload, signature }
}

async function sendViaHttp(
  msg: P2PMessage,
  identity: Identity,
  targetAddr: string,
  port: number,
  timeoutMs: number,
  urlPath: string = "/peer/message",
): Promise<{ ok: boolean; error?: string }> {
  const isIpv6 = targetAddr.includes(":") && !targetAddr.includes(".")
  const host = isIpv6 ? `[${targetAddr}]:${port}` : `${targetAddr}:${port}`
  const url = `http://${host}${urlPath}`
  const body = JSON.stringify(msg)
  const awHeaders = signHttpRequest(identity, "POST", host, urlPath, body)
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...awHeaders },
      body,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) {
      const text = await resp.text().catch(() => "")
      return { ok: false, error: `HTTP ${resp.status}: ${text}` }
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) }
  }
}

async function sendViaTransport(
  msg: P2PMessage,
  target: string,
  transport: Transport,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const data = Buffer.from(JSON.stringify(msg))
    await transport.send(target, data)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) }
  }
}

export interface SendOptions {
  endpoints?: Endpoint[]
  quicTransport?: Transport
}

/**
 * Send a signed message to a peer. Tries QUIC first if available,
 * then falls back to HTTP.
 */
export async function sendP2PMessage(
  identity: Identity,
  targetAddr: string,
  event: string,
  content: string,
  port: number = 8099,
  timeoutMs: number = 10_000,
  opts?: SendOptions,
): Promise<{ ok: boolean; error?: string }> {
  const msg = buildSignedMessage(identity, event, content)

  if (opts?.quicTransport?.isActive() && opts?.endpoints?.length) {
    const quicEp = opts.endpoints
      .filter((e) => e.transport === "quic")
      .sort((a, b) => a.priority - b.priority)[0]
    if (quicEp) {
      const target = quicEp.port ? `${quicEp.address}:${quicEp.port}` : quicEp.address
      const result = await sendViaTransport(msg, target, opts.quicTransport)
      if (result.ok) return result
      console.warn(`[p2p:client] QUIC send to ${quicEp.address} failed, falling back to HTTP`)
    }
  }

  // Pick the best HTTP endpoint from peer's endpoint list, or fall back to targetAddr
  if (opts?.endpoints?.length) {
    const httpEp = opts.endpoints
      .filter((e) => e.transport === "tcp")
      .sort((a, b) => a.priority - b.priority)[0]
    if (httpEp) {
      return sendViaHttp(msg, identity, httpEp.address, httpEp.port || port, timeoutMs)
    }
  }

  return sendViaHttp(msg, identity, targetAddr, port, timeoutMs)
}

export async function broadcastLeave(
  identity: Identity,
  peers: Array<{ agentId: string; endpoints?: Endpoint[] }>,
  port: number = 8099,
  opts?: SendOptions,
): Promise<void> {
  if (peers.length === 0) return
  const reachable = peers.filter((p) => p.endpoints && p.endpoints.length > 0)
  await Promise.allSettled(
    reachable.map((p) => {
      const ep = p.endpoints!.sort((a, b) => a.priority - b.priority)[0]
      const addr = ep?.address ?? p.endpoints![0].address
      return sendP2PMessage(identity, addr, "leave", "", port, 3_000, {
        ...opts,
        endpoints: p.endpoints ?? opts?.endpoints,
      })
    })
  )
  console.log(`[p2p] Leave broadcast sent to ${reachable.length} peer(s)`)
}

export async function pingPeer(
  targetAddr: string,
  port: number = 8099,
  timeoutMs: number = 5_000,
  endpoints?: Endpoint[],
): Promise<boolean> {
  if (endpoints?.length) {
    const ep = endpoints.sort((a, b) => a.priority - b.priority)[0]
    if (ep) {
      targetAddr = ep.address
      port = ep.port || port
    }
  }
  const isIpv6 = targetAddr.includes(":") && !targetAddr.includes(".")
  const url = isIpv6
    ? `http://[${targetAddr}]:${port}/peer/ping`
    : `http://${targetAddr}:${port}/peer/ping`
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const resp = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    return resp.ok
  } catch {
    return false
  }
}
