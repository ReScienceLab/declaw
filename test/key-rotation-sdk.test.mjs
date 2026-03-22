import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"

const nacl = (await import("tweetnacl")).default

const {
  registerPeerRoutes,
  PeerDb,
  PROTOCOL_VERSION,
  agentIdFromPublicKey,
  signWithDomainSeparator,
  DOMAIN_SEPARATORS,
  toPublicKeyMultibase,
} = await import("../packages/agent-world-sdk/dist/index.js")

function makeIdentity() {
  const keypair = nacl.sign.keyPair()
  const pubB64 = Buffer.from(keypair.publicKey).toString("base64")
  return {
    agentId: agentIdFromPublicKey(pubB64),
    pubB64,
    secretKey: keypair.secretKey,
    keypair,
  }
}

function makeProof(secretKey, signable) {
  const header = JSON.stringify({ alg: "EdDSA", kid: "#identity" })
  return {
    protected: Buffer.from(header).toString("base64url"),
    signature: signWithDomainSeparator(
      DOMAIN_SEPARATORS.KEY_ROTATION,
      signable,
      secretKey
    ),
  }
}

test("sdk /peer/key-rotation rejects mismatched newAgentId binding with stable 400 error", async (t) => {
  const fastify = Fastify({ logger: false })
  t.after(async () => {
    await fastify.close()
  })

  registerPeerRoutes(fastify, {
    identity: makeIdentity(),
    peerDb: new PeerDb(),
  })

  const oldKey = makeIdentity()
  const newKey = makeIdentity()
  const otherNewKey = makeIdentity()
  const timestamp = Date.now()
  const signable = {
    agentId: oldKey.agentId,
    oldPublicKey: oldKey.pubB64,
    newPublicKey: newKey.pubB64,
    timestamp,
  }

  const response = await fastify.inject({
    method: "POST",
    url: "/peer/key-rotation",
    headers: { "content-type": "application/json" },
    payload: {
      type: "agentworld-identity-rotation",
      version: PROTOCOL_VERSION,
      oldAgentId: oldKey.agentId,
      newAgentId: otherNewKey.agentId,
      oldIdentity: {
        agentId: oldKey.agentId,
        kid: "#identity",
        publicKeyMultibase: toPublicKeyMultibase(oldKey.pubB64),
      },
      newIdentity: {
        agentId: otherNewKey.agentId,
        kid: "#identity",
        publicKeyMultibase: toPublicKeyMultibase(newKey.pubB64),
      },
      timestamp,
      proofs: {
        signedByOld: makeProof(oldKey.secretKey, signable),
        signedByNew: makeProof(newKey.secretKey, signable),
      },
    },
  })

  assert.equal(response.statusCode, 400)
  assert.deepEqual(response.json(), {
    error: "newAgentId does not match newPublicKey",
  })
})
