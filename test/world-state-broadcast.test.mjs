import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const nacl = (await import("tweetnacl")).default
const { createWorldServer } = await import("../packages/agent-world-sdk/dist/world-server.js")
const {
  signHttpRequest,
  signWithDomainSeparator,
  DOMAIN_SEPARATORS,
  agentIdFromPublicKey,
} = await import("../packages/agent-world-sdk/dist/crypto.js")

const PORT = 18210

function makeKeypair() {
  const kp = nacl.sign.keyPair()
  const publicKey = Buffer.from(kp.publicKey).toString("base64")
  return { publicKey, secretKey: kp.secretKey }
}

async function joinAgent(agentId, pubKey, secretKey, endpoints) {
  const content = JSON.stringify({ alias: "Watcher", endpoints })
  const payload = {
    from: agentId,
    publicKey: pubKey,
    event: "world.join",
    content,
    timestamp: Date.now(),
  }
  const signature = signWithDomainSeparator(
    DOMAIN_SEPARATORS.MESSAGE,
    payload,
    secretKey
  )
  const msg = { ...payload, signature }
  const body = JSON.stringify(msg)
  const host = `[::1]:${PORT}`
  const sdkIdentity = {
    agentId,
    pubB64: pubKey,
    secretKey,
    keypair: { publicKey: Buffer.from(pubKey, "base64"), secretKey },
  }
  const awHeaders = signHttpRequest(sdkIdentity, "POST", host, "/peer/message", body)
  const resp = await fetch(`http://${host}/peer/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...awHeaders },
    body,
  })
  return resp.json()
}

async function waitFor(assertReady, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (assertReady()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail("Timed out waiting for broadcast")
}

describe("World state broadcast delivery", () => {
  let tmpDir
  let server
  let originalFetch

  before(async () => {
    originalFetch = globalThis.fetch
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "world-state-broadcast-"))
    server = await createWorldServer(
      {
        worldId: "broadcast-test",
        worldName: "Broadcast Test",
        port: PORT,
        dataDir: tmpDir,
        isPublic: false,
        broadcastIntervalMs: 100,
      },
      {
        onJoin: async () => ({
          manifest: { name: "Broadcast Test" },
          state: {},
        }),
        onAction: async () => ({ ok: true }),
        onLeave: async () => {},
        getState: () => ({ tick: 1 }),
      }
    )
  })

  after(async () => {
    globalThis.fetch = originalFetch
    await server.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("broadcasts world.state to each registered endpoint for an active member", async () => {
    const hits = []
    const endpointPorts = new Set([29001, 29002])

    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const parsed = new URL(url)
      if (parsed.pathname === "/peer/message" && endpointPorts.has(Number(parsed.port))) {
        hits.push({
          url,
          headers: init?.headers,
          body: JSON.parse(String(init?.body ?? "{}")),
        })
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }

    const kp = makeKeypair()
    const agentId = agentIdFromPublicKey(kp.publicKey)
    const full = nacl.sign.keyPair.fromSeed(kp.secretKey.slice(0, 32))

    const joinResp = await joinAgent(agentId, kp.publicKey, full.secretKey, [
      { transport: "tcp", address: "127.0.0.1", port: 29001, priority: 1 },
      { transport: "tcp", address: "127.0.0.1", port: 29002, priority: 2 },
    ])

    assert.equal(joinResp.ok, true)

    await waitFor(() => hits.length >= 2)

    assert.equal(hits[0].body.event, "world.state")
    assert.equal(hits[1].body.event, "world.state")
    assert.equal(new URL(hits[0].url).port, "29001")
    assert.equal(new URL(hits[1].url).port, "29002")

    const contentA = JSON.parse(hits[0].body.content)
    const contentB = JSON.parse(hits[1].body.content)
    assert.equal(contentA.worldId, "broadcast-test")
    assert.equal(contentB.worldId, "broadcast-test")
    assert.equal(contentA.tick, 1)
    assert.equal(contentB.tick, 1)
  })
})
