/**
 * AgentWorld Agent Card builder.
 *
 * Builds and JWS-signs a standard A2A-compatible Agent Card with an
 * `extensions.agentworld` block. The card is served at /.well-known/agent.json.
 *
 * Signing uses jose FlattenedSign (EdDSA/Ed25519). The `payload` field is
 * omitted from the stored signature entry — the card body itself is the
 * signed payload.
 */
import { FlattenedSign } from "jose";
import { createPrivateKey } from "node:crypto";
import nacl from "tweetnacl";
import {
  canonicalize,
  DOMAIN_SEPARATORS,
  verifyWithDomainSeparator,
} from "./crypto.js";
import { deriveDidKey, toPublicKeyMultibase } from "./identity.js";
import { PROTOCOL_VERSION } from "./version.js";
import type { Identity } from "./types.js";

// PKCS8 DER header for an Ed25519 32-byte seed (RFC 8410)
const PKCS8_ED25519_HEADER = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
);

function toNodePrivateKey(secretKey: Uint8Array) {
  const seed = Buffer.from(secretKey.subarray(0, 32));
  const der = Buffer.concat([PKCS8_ED25519_HEADER, seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export interface AgentCardOpts {
  /** Human-readable agent name */
  name: string;
  description?: string;
  /** Canonical public URL of this card, e.g. https://gateway.example.com/.well-known/agent.json */
  cardUrl: string;
  /** A2A JSON-RPC endpoint URL (optional) */
  rpcUrl?: string;
  /** AgentWorld profiles to declare. Defaults to ["core"] */
  profiles?: string[];
  /** Conformance node class. Defaults to "CoreNode" */
  nodeClass?: string;
  /** Capabilities advertised in conformance block. */
  capabilities?: string[];
}

/**
 * Build and JWS-sign an AgentWorld Agent Card.
 *
 * Returns the canonical JSON string that MUST be served verbatim as
 * `application/json`. The JWS signature covers
 * `JSON.stringify(canonicalize(cardWithoutSignatures))`, so verification
 * requires the verifier to strip the `signatures` field, re-canonicalize,
 * and attach the result as the JWS payload.
 */
export async function buildSignedAgentCard(
  opts: AgentCardOpts,
  identity: Identity
): Promise<string> {
  const profiles = opts.profiles ?? ["core"];
  const nodeClass = opts.nodeClass ?? "CoreNode";
  const did = deriveDidKey(identity.pubB64);
  const publicKeyMultibase = toPublicKeyMultibase(identity.pubB64);

  const card: Record<string, unknown> = {
    id: opts.cardUrl,
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.rpcUrl ? { a2a: { rpcUrl: opts.rpcUrl } } : {}),
    extensions: {
      agentworld: {
        version: PROTOCOL_VERSION,
        agentId: identity.agentId,
        identityMode: "direct",
        identity: {
          did,
          kid: "#identity",
          alg: "Ed25519",
          publicKeyMultibase,
        },
        requestSigning: {
          headers: [
            "X-AgentWorld-Version",
            "X-AgentWorld-From",
            "X-AgentWorld-KeyId",
            "X-AgentWorld-Timestamp",
            "Content-Digest",
            "X-AgentWorld-Signature",
          ],
        },
        profiles,
        conformance: {
          nodeClass,
          profiles: profiles.map((id) => ({
            id,
            required: id === "core",
          })),
          capabilities: opts.capabilities ?? [
            "signed-card-jws",
            "signed-http-requests",
            "signed-http-responses",
            "tofu-key-binding",
            "domain-separated-signatures",
          ],
        },
      },
    },
  };

  // Sign the card body (without the signatures field) using FlattenedSign (EdDSA)
  // with domain separation to prevent cross-context replay attacks
  const canonicalCard = JSON.stringify(canonicalize(card));
  const domainPrefix = Buffer.from(DOMAIN_SEPARATORS.AGENT_CARD, "utf8");
  const cardBytes = Buffer.from(canonicalCard, "utf8");
  const payload = Buffer.concat([domainPrefix, cardBytes]);
  const privateKey = toNodePrivateKey(identity.secretKey);

  const jws = await new FlattenedSign(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: "#identity" })
    .sign(privateKey);

  // Return the signed card as a canonical JSON string.
  // Serving this string verbatim ensures the bytes on the wire exactly match
  // what was signed, making verification unambiguous.
  const signedCard = {
    ...(canonicalize(card) as object),
    signatures: [{ protected: jws.protected, signature: jws.signature }],
  };
  return JSON.stringify(canonicalize(signedCard));
}

/**
 * Verify an Agent Card JWS signature.
 *
 * Reconstructs the domain-separated payload and verifies the EdDSA signature
 * using the AGENT_CARD domain separator. The card must have been signed with
 * buildSignedAgentCard().
 *
 * This helper function implements the AgentWire-compliant JWS verification flow:
 * 1. Extract the signatures field and protected header from the card
 * 2. Strip signatures to get the unsigned card
 * 3. Canonicalize the unsigned card
 * 4. Prepend DOMAIN_SEPARATORS.AGENT_CARD
 * 5. Reconstruct JWS signing input: BASE64URL(protected) + '.' + BASE64URL(payload)
 * 6. Verify the Ed25519 signature over the JWS signing input
 *
 * @param cardJson - The signed Agent Card JSON string
 * @param expectedPublicKeyB64 - Base64-encoded Ed25519 public key to verify against
 * @returns true if signature is valid, false otherwise
 */
export function verifyAgentCard(
  cardJson: string,
  expectedPublicKeyB64: string
): boolean {
  try {
    const card = JSON.parse(cardJson);

    // Extract signature entry
    const signatures = card.signatures;
    if (!signatures || signatures.length === 0) {
      return false;
    }

    const jwsProtected = signatures[0].protected;
    const jwsSignature = signatures[0].signature;

    // Remove signatures field to get unsigned card
    const { signatures: _, ...unsignedCard } = card;

    // Reconstruct domain-separated payload
    const canonicalCard = JSON.stringify(canonicalize(unsignedCard));
    const domainPrefix = Buffer.from(DOMAIN_SEPARATORS.AGENT_CARD, "utf8");
    const cardBytes = Buffer.from(canonicalCard, "utf8");
    const payload = Buffer.concat([domainPrefix, cardBytes]);

    // Convert payload to base64url for JWS signing input
    const payloadBase64url = Buffer.from(payload)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    // Reconstruct JWS signing input: protected + '.' + payload
    const jwsSigningInput = Buffer.from(
      jwsProtected + "." + payloadBase64url,
      "utf8"
    );

    // Verify signature (JWS signatures are base64url encoded)
    const signatureBytes = Buffer.from(jwsSignature, "base64url");
    const publicKeyBytes = Buffer.from(expectedPublicKeyB64, "base64");

    // Verify the Ed25519 signature over the JWS signing input
    return nacl.sign.detached.verify(
      jwsSigningInput,
      signatureBytes,
      publicKeyBytes
    );
  } catch {
    return false;
  }
}
