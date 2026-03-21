/**
 * Transport abstraction layer for AWN P2P communication.
 *
 * Defines the interface that all transport backends must implement,
 * plus the TransportManager that handles automatic selection.
 */
import { Identity, Endpoint } from "./types"

export type TransportId = "quic" | "tcp"

export interface TransportEndpoint {
  transport: TransportId
  address: string    // host:port for QUIC/TCP
  port: number       // listening port
  priority: number   // lower = preferred
  ttl: number        // seconds until re-resolve
}

export interface Transport {
  readonly id: TransportId
  readonly address: string

  /**
   * Initialize and start the transport.
   * Returns true if the transport is available and started successfully.
   */
  start(identity: Identity, opts?: Record<string, unknown>): Promise<boolean>

  /** Gracefully shut down the transport. */
  stop(): Promise<void>

  /** Whether this transport is currently active and can send/receive. */
  isActive(): boolean

  /**
   * Send raw data to a target address on this transport.
   */
  send(target: string, data: Buffer): Promise<void>

  /** Register a handler for incoming data on this transport. */
  onMessage(handler: (from: string, data: Buffer) => void): void

  /** Get the endpoint descriptor for peer announcements. */
  getEndpoint(): TransportEndpoint
}

/**
 * TransportManager handles transport selection and lifecycle.
 *
 * Selection order: first registered transport that starts successfully becomes active.
 */
export class TransportManager {
  private _transports: Map<TransportId, Transport> = new Map()
  private _active: Transport | null = null
  private _all: Transport[] = []

  register(transport: Transport): void {
    this._all.push(transport)
  }

  async start(identity: Identity, opts?: Record<string, unknown>): Promise<Transport | null> {
    for (const t of this._all) {
      console.log(`[transport] Trying ${t.id}...`)
      const ok = await t.start(identity, opts)
      if (ok) {
        this._transports.set(t.id, t)
        if (!this._active) {
          this._active = t
          console.log(`[transport] Active transport: ${t.id} (${t.address})`)
        } else {
          console.log(`[transport] Fallback available: ${t.id} (${t.address})`)
        }
      } else {
        console.log(`[transport] ${t.id} not available`)
      }
    }
    return this._active
  }

  async stop(): Promise<void> {
    for (const t of this._transports.values()) {
      await t.stop()
    }
    this._transports.clear()
    this._active = null
  }

  get active(): Transport | null {
    return this._active
  }

  get(id: TransportId): Transport | undefined {
    return this._transports.get(id)
  }

  getAll(): Transport[] {
    return Array.from(this._transports.values())
  }

  getEndpoints(): Endpoint[] {
    const endpoints: Endpoint[] = []
    for (const t of this._transports.values()) {
      try {
        const ep = t.getEndpoint()
        endpoints.push({
          transport: ep.transport as Endpoint["transport"],
          address: ep.address,
          port: ep.port,
          priority: ep.priority,
          ttl: ep.ttl,
        })
      } catch {
        continue
      }
    }
    return endpoints
  }

  resolveTransport(address: string): Transport | null {
    // host:port with digits → QUIC
    if (address.includes(":") && /\d+$/.test(address)) {
      return this._transports.get("quic") ?? this._active
    }
    return this._active
  }
}
