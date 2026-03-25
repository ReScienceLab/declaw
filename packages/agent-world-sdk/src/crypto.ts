import crypto from "node:crypto";
import nacl from "tweetnacl";
import { PROTOCOL_VERSION } from "./version.js";

// ── Domain-Separated Signatures ──────────────────────────────────────────────
//
// Domain separation prevents cross-context signature replay attacks.
// Each signing context prepends a unique separator before signing:
//
//   message = DomainSeparator + JSON.stringify(canonicalize(payload))
//   signature = Ed25519(message, secretKey)
//
// A signature valid in one context (e.g., HTTP requests) will NOT verify
// in another context (e.g., Agent Cards) because the domain separator differs.
//
// Format: "AgentWorld-{Context}-{VERSION}\0"
// - AgentWorld: Protocol namespace
// - {Context}: Specific context (Req, Res, Card, etc.)
// - {VERSION}: Protocol version from package.json
// - \0: NULL byte terminator (prevents JSON confusion)
//
export const DOMAIN_SEPARATORS = {
  HTTP_REQUEST: `AgentWorld-Req-${PROTOCOL_VERSION}\0`,
  HTTP_RESPONSE: `AgentWorld-Res-${PROTOCOL_VERSION}\0`,
  AGENT_CARD: `AgentWorld-Card-${PROTOCOL_VERSION}\0`,
  KEY_ROTATION: `AgentWorld-Rotation-${PROTOCOL_VERSION}\0`,
  ANNOUNCE: `AgentWorld-Announce-${PROTOCOL_VERSION}\0`,
  MESSAGE: `AgentWorld-Message-${PROTOCOL_VERSION}\0`,
  WORLD_STATE: `AgentWorld-WorldState-${PROTOCOL_VERSION}\0`,
  HEARTBEAT: `AgentWorld-Heartbeat-${PROTOCOL_VERSION}\0`,
} as const;

/**
 * Sign with domain separation to prevent cross-context replay attacks.
 *
 * Prepends domain separator before canonicalized JSON, then signs with Ed25519.
 * The domain separator ensures a signature valid in one context cannot be
 * replayed in another context.
 *
 * @param domainSeparator - Context-specific separator (e.g., DOMAIN_SEPARATORS.HTTP_REQUEST)
 * @param payload - Object to sign (will be canonicalized)
 * @param secretKey - Ed25519 secret key (64 bytes from TweetNaCl)
 * @returns Base64-encoded signature
 */
export function signWithDomainSeparator(
  domainSeparator: string,
  payload: unknown,
  secretKey: Uint8Array
): string {
  const canonicalJson = JSON.stringify(canonicalize(payload));
  const domainPrefix = Buffer.from(domainSeparator, "utf8");
  const payloadBytes = Buffer.from(canonicalJson, "utf8");
  const message = Buffer.concat([domainPrefix, payloadBytes]);

  const sig = nacl.sign.detached(message, secretKey);
  return Buffer.from(sig).toString("base64");
}

/**
 * Verify signature with domain separation.
 *
 * Reconstructs the domain-separated message and verifies the Ed25519 signature.
 * MUST use the same domain separator as the signer.
 *
 * @param domainSeparator - Same separator used during signing
 * @param publicKeyB64 - Base64-encoded Ed25519 public key
 * @param payload - Object that was signed (will be canonicalized)
 * @param signatureB64 - Base64-encoded signature
 * @returns true if signature is valid, false otherwise
 */
export function verifyWithDomainSeparator(
  domainSeparator: string,
  publicKeyB64: string,
  payload: unknown,
  signatureB64: string
): boolean {
  try {
    const canonicalJson = JSON.stringify(canonicalize(payload));
    const domainPrefix = Buffer.from(domainSeparator, "utf8");
    const payloadBytes = Buffer.from(canonicalJson, "utf8");
    const message = Buffer.concat([domainPrefix, payloadBytes]);

    const pubKey = Buffer.from(publicKeyB64, "base64");
    const sig = Buffer.from(signatureB64, "base64");
    return nacl.sign.detached.verify(message, sig, pubKey);
  } catch {
    return false;
  }
}

export function agentIdFromPublicKey(publicKeyB64: string): string {
  const fullHex = crypto
    .createHash("sha256")
    .update(Buffer.from(publicKeyB64, "base64"))
    .digest("hex");
  return `aw:sha256:${fullHex}`;
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

export function verifySignature(
  publicKeyB64: string,
  obj: unknown,
  signatureB64: string
): boolean {
  try {
    const pubKey = Buffer.from(publicKeyB64, "base64");
    const sig = Buffer.from(signatureB64, "base64");
    const msg = Buffer.from(JSON.stringify(canonicalize(obj)));
    return nacl.sign.detached.verify(msg, sig, pubKey);
  } catch {
    return false;
  }
}

export function signPayload(payload: unknown, secretKey: Uint8Array): string {
  const sig = nacl.sign.detached(
    Buffer.from(JSON.stringify(canonicalize(payload))),
    secretKey
  );
  return Buffer.from(sig).toString("base64");
}

// ── AgentWorld HTTP header signing ─────────────────────────────────────────────

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function computeContentDigest(body: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(Buffer.from(body, "utf8"))
    .digest("base64");
  return `sha-256=:${hash}:`;
}

export interface AwRequestHeaders {
  "X-AgentWorld-Version": string;
  "X-AgentWorld-From": string;
  "X-AgentWorld-KeyId": string;
  "X-AgentWorld-Timestamp": string;
  "Content-Digest": string;
  "X-AgentWorld-Signature": string;
}

function buildRequestSigningInput(opts: {
  from: string;
  kid: string;
  ts: string;
  method: string;
  authority: string;
  path: string;
  contentDigest: string;
  v?: string;
}): Record<string, string> {
  return {
    v: opts.v ?? PROTOCOL_VERSION,
    from: opts.from,
    kid: opts.kid,
    ts: opts.ts,
    method: opts.method.toUpperCase(),
    authority: opts.authority,
    path: opts.path,
    contentDigest: opts.contentDigest,
  };
}

/**
 * Produce AgentWorld HTTP request signing headers.
 * Include alongside Content-Type in outbound fetch calls.
 */
export function signHttpRequest(
  identity: { agentId: string; secretKey: Uint8Array },
  method: string,
  authority: string,
  path: string,
  body: string
): AwRequestHeaders {
  const ts = new Date().toISOString();
  const kid = "#identity";
  const contentDigest = computeContentDigest(body);
  const signingInput = buildRequestSigningInput({
    from: identity.agentId,
    kid,
    ts,
    method,
    authority,
    path,
    contentDigest,
  });
  const signature = signWithDomainSeparator(
    DOMAIN_SEPARATORS.HTTP_REQUEST,
    signingInput,
    identity.secretKey
  );
  return {
    "X-AgentWorld-Version": PROTOCOL_VERSION,
    "X-AgentWorld-From": identity.agentId,
    "X-AgentWorld-KeyId": kid,
    "X-AgentWorld-Timestamp": ts,
    "Content-Digest": contentDigest,
    "X-AgentWorld-Signature": signature,
  };
}

/**
 * Verify AgentWorld HTTP request headers.
 * Returns { ok: true } if valid, { ok: false, error } otherwise.
 */
export function verifyHttpRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  method: string,
  path: string,
  authority: string,
  body: string,
  publicKeyB64: string
): { ok: boolean; error?: string } {
  // Normalize to lowercase so callers can pass either Fastify req.headers or raw AwRequestHeaders
  const h: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;

  const sig = h["x-agentworld-signature"] as string | undefined;
  const from = h["x-agentworld-from"] as string | undefined;
  const kid = h["x-agentworld-keyid"] as string | undefined;
  const ts = h["x-agentworld-timestamp"] as string | undefined;
  const cd = h["content-digest"] as string | undefined;
  const senderVersion = h["x-agentworld-version"] as string | undefined;

  if (!sig || !from || !kid || !ts || !cd) {
    return { ok: false, error: "Missing required AgentWorld headers" };
  }

  const tsDiff = Math.abs(Date.now() - new Date(ts).getTime());
  if (isNaN(tsDiff) || tsDiff > MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      error: "X-AgentWorld-Timestamp outside acceptable skew window",
    };
  }

  const expectedDigest = computeContentDigest(body);
  if (cd !== expectedDigest) {
    return { ok: false, error: "Content-Digest mismatch" };
  }

  const signingInput = buildRequestSigningInput({
    from,
    kid,
    ts,
    method,
    authority,
    path,
    contentDigest: cd,
    v: senderVersion,
  });
  const ok = verifyWithDomainSeparator(
    DOMAIN_SEPARATORS.HTTP_REQUEST,
    publicKeyB64,
    signingInput,
    sig
  );
  return ok
    ? { ok: true }
    : { ok: false, error: "Invalid X-AgentWorld-Signature" };
}

// ── AgentWorld HTTP response signing ───────────────────────────────────────────

export interface AwResponseHeaders {
  "X-AgentWorld-Version": string;
  "X-AgentWorld-From": string;
  "X-AgentWorld-KeyId": string;
  "X-AgentWorld-Timestamp": string;
  "Content-Digest": string;
  "X-AgentWorld-Signature": string;
}

function buildResponseSigningInput(opts: {
  from: string;
  kid: string;
  ts: string;
  status: number;
  contentDigest: string;
  v?: string;
}): Record<string, unknown> {
  return {
    v: opts.v ?? PROTOCOL_VERSION,
    from: opts.from,
    kid: opts.kid,
    ts: opts.ts,
    status: opts.status,
    contentDigest: opts.contentDigest,
  };
}

/**
 * Produce AgentWorld HTTP response signing headers.
 * Add to Fastify reply before sending the body.
 */
export function signHttpResponse(
  identity: { agentId: string; secretKey: Uint8Array },
  status: number,
  body: string
): AwResponseHeaders {
  const ts = new Date().toISOString();
  const kid = "#identity";
  const contentDigest = computeContentDigest(body);
  const signingInput = buildResponseSigningInput({
    from: identity.agentId,
    kid,
    ts,
    status,
    contentDigest,
  });
  const signature = signWithDomainSeparator(
    DOMAIN_SEPARATORS.HTTP_RESPONSE,
    signingInput,
    identity.secretKey
  );
  return {
    "X-AgentWorld-Version": PROTOCOL_VERSION,
    "X-AgentWorld-From": identity.agentId,
    "X-AgentWorld-KeyId": kid,
    "X-AgentWorld-Timestamp": ts,
    "Content-Digest": contentDigest,
    "X-AgentWorld-Signature": signature,
  };
}

/**
 * Verify AgentWorld HTTP response headers from an inbound response.
 * Returns { ok: true } if valid, { ok: false, error } otherwise.
 */
export function verifyHttpResponseHeaders(
  headers: Record<string, string | null>,
  status: number,
  body: string,
  publicKeyB64: string
): { ok: boolean; error?: string } {
  // Normalize to lowercase so callers can pass title-cased AwResponseHeaders or fetch Headers
  const h: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;

  const sig = h["x-agentworld-signature"];
  const from = h["x-agentworld-from"];
  const kid = h["x-agentworld-keyid"];
  const ts = h["x-agentworld-timestamp"];
  const cd = h["content-digest"];
  const senderVersion = h["x-agentworld-version"];

  if (!sig || !from || !kid || !ts || !cd) {
    return { ok: false, error: "Missing required AgentWorld response headers" };
  }

  const tsDiff = Math.abs(Date.now() - new Date(ts).getTime());
  if (isNaN(tsDiff) || tsDiff > MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      error: "X-AgentWorld-Timestamp outside acceptable skew window",
    };
  }

  const expectedDigest = computeContentDigest(body);
  if (cd !== expectedDigest) {
    return { ok: false, error: "Content-Digest mismatch" };
  }

  const signingInput = buildResponseSigningInput({
    from,
    kid,
    ts,
    status,
    contentDigest: cd,
    v: senderVersion ?? undefined,
  });
  const ok = verifyWithDomainSeparator(
    DOMAIN_SEPARATORS.HTTP_RESPONSE,
    publicKeyB64,
    signingInput,
    sig
  );
  return ok
    ? { ok: true }
    : { ok: false, error: "Invalid X-AgentWorld-Signature" };
}
