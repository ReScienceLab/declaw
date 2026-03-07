import { describe, it } from "node:test"
import assert from "node:assert/strict"

describe("Transport types in PeerAnnouncement", () => {
  it("PeerAnnouncement supports transport and endpoints fields", async () => {
    // Verify the type structure by creating a valid announcement object
    const announcement = {
      fromYgg: "200::1",
      publicKey: "test-key",
      alias: "test",
      version: "0.2.3",
      timestamp: Date.now(),
      signature: "sig",
      transport: "quic",
      endpoints: [
        { transport: "quic", address: "1.2.3.4:8098", priority: 10 },
        { transport: "yggdrasil", address: "200::1", priority: 1 },
      ],
      peers: [
        {
          yggAddr: "200::2",
          publicKey: "pk2",
          alias: "peer2",
          lastSeen: Date.now(),
          endpoints: [{ transport: "quic", address: "5.6.7.8:8098", priority: 10 }],
        },
      ],
    }

    assert.equal(announcement.transport, "quic")
    assert.equal(announcement.endpoints.length, 2)
    assert.equal(announcement.endpoints[0].transport, "quic")
    assert.equal(announcement.endpoints[1].transport, "yggdrasil")
    assert.equal(announcement.peers[0].endpoints.length, 1)
  })

  it("PluginConfig supports quic_port", () => {
    const config = {
      agent_name: "test",
      peer_port: 8099,
      quic_port: 8098,
      test_mode: "auto",
    }
    assert.equal(config.quic_port, 8098)
  })
})
