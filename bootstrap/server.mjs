/**
 * AgentWorld Registry — World discovery service.
 *
 * Only accepts registrations from World Servers (peers with world:* capabilities).
 * Individual agent announcements are rejected.
 *
 * Endpoints:
 *   GET  /peer/ping       — health check
 *   GET  /worlds          — list registered worlds
 *   POST /peer/announce   — accept World Server announcement (must have world:* capability)
 */
import Fastify from "fastify";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const __require = createRequire(import.meta.url);
const pkgVersion = __require("./package.json").version;
const PROTOCOL_VERSION = pkgVersion.split(".").slice(0, 2).join(".");

const PORT = parseInt(process.env.PEER_PORT ?? "8099");
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const MAX_WORLDS = 500;
const AGENT_VERSION = process.env.AGENT_VERSION ?? "1.0.0";
const PERSIST_INTERVAL_MS = 30_000;

function agentIdFromPublicKey(publicKeyB64) {
  const pubBytes = Buffer.from(publicKeyB64, "base64");
  return `aw:sha256:${crypto.createHash("sha256").update(pubBytes).digest("hex")}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const k of Object.keys(value).sort()) sorted[k] = canonicalize(value[k]);
    return sorted;
  }
  return value;
}

function verifySignature(publicKeyB64, obj, signatureB64) {
  try {
    const pubKey = Buffer.from(publicKeyB64, "base64");
    const sig = Buffer.from(signatureB64, "base64");
    const msg = Buffer.from(JSON.stringify(canonicalize(obj)));
    return nacl.sign.detached.verify(msg, sig, pubKey);
  } catch {
    return false;
  }
}

function verifyDomainSeparatedSignature(domainSeparator, publicKeyB64, obj, signatureB64) {
  try {
    const pubKey = Buffer.from(publicKeyB64, "base64");
    const sig = Buffer.from(signatureB64, "base64");
    const prefix = Buffer.from(domainSeparator, "utf8");
    const payload = Buffer.from(JSON.stringify(canonicalize(obj)));
    const msg = Buffer.concat([prefix, payload]);
    return nacl.sign.detached.verify(msg, sig, pubKey);
  } catch {
    return false;
  }
}

const ANNOUNCE_SEPARATOR_PREFIX = "AgentWorld-Announce-";

function hasWorldCapability(capabilities) {
  return Array.isArray(capabilities) && capabilities.some(c => typeof c === "string" && c.startsWith("world:"));
}

function isRegistryOrWorld(capabilities) {
  return Array.isArray(capabilities) && capabilities.some(c =>
    typeof c === "string" && (c.startsWith("world:") || c === "registry")
  );
}

function normalizeSharedWorldRecord(record) {
  if (!record || typeof record !== "object") return null;
  if (typeof record.publicKey !== "string" || record.publicKey.length === 0) return null;
  if (!isRegistryOrWorld(record.capabilities)) return null;

  const derivedId = agentIdFromPublicKey(record.publicKey);
  if (record.agentId && record.agentId !== derivedId) return null;

  return {
    agentId: derivedId,
    publicKey: record.publicKey,
    alias: typeof record.alias === "string" ? record.alias : undefined,
    version: typeof record.version === "string" ? record.version : undefined,
    endpoints: Array.isArray(record.endpoints) ? record.endpoints : [],
    capabilities: record.capabilities,
    lastSeen: typeof record.lastSeen === "number" ? record.lastSeen : undefined,
  };
}

// ---------------------------------------------------------------------------
// World DB (in-memory + JSON persistence)
// ---------------------------------------------------------------------------
const worlds = new Map();

function loadWorlds() {
  const file = path.join(DATA_DIR, "worlds.json");
  if (!fs.existsSync(file)) return;
  try {
    const records = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const r of records) {
      const validated = normalizeSharedWorldRecord(r);
      if (validated) worlds.set(validated.agentId, validated);
    }
    console.log(`[registry] Loaded ${worlds.size} world(s) from disk`);
  } catch (e) {
    console.warn("[registry] Could not load worlds.json:", e.message);
  }
}

function saveWorlds() {
  const file = path.join(DATA_DIR, "worlds.json");
  try {
    fs.writeFileSync(file, JSON.stringify([...worlds.values()], null, 2));
  } catch (e) {
    console.warn("[registry] Could not save worlds.json:", e.message);
  }
}

function upsertWorld(agentId, publicKey, opts = {}) {
  const now = Date.now();
  const existing = worlds.get(agentId);
  let lastSeen;
  if (opts.lastSeen !== undefined) {
    lastSeen = Math.max(existing?.lastSeen ?? 0, opts.lastSeen);
  } else {
    lastSeen = now;
  }
  worlds.set(agentId, {
    agentId,
    publicKey,
    alias: opts.alias ?? existing?.alias ?? "",
    version: opts.version ?? existing?.version,
    endpoints: opts.endpoints ?? existing?.endpoints ?? [],
    capabilities: opts.capabilities ?? existing?.capabilities ?? [],
    firstSeen: existing?.firstSeen ?? now,
    lastSeen,
  });
  if (worlds.size > MAX_WORLDS) {
    const sorted = [...worlds.values()].sort((a, b) => a.lastSeen - b.lastSeen);
    worlds.delete(sorted[0].agentId);
  }
}

function pruneStaleWorlds(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [id, record] of worlds) {
    if (record.lastSeen < cutoff) {
      worlds.delete(id);
      pruned++;
    }
  }
  if (pruned > 0) console.log(`[registry] Pruned ${pruned} stale world(s)`);
  return pruned;
}

function getWorldsForExchange(limit = 50) {
  return [...worlds.values()]
    .filter((record) => hasWorldCapability(record.capabilities))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map(({ agentId, publicKey, alias, version, endpoints, capabilities, lastSeen }) => ({
      agentId,
      publicKey,
      alias,
      version,
      endpoints: endpoints ?? [],
      capabilities: capabilities ?? [],
      lastSeen,
    }));
}

// ---------------------------------------------------------------------------
// Registry identity
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });

const idFile = path.join(DATA_DIR, "registry-identity.json");
const legacyIdFile = path.join(DATA_DIR, "bootstrap-identity.json");
if (!fs.existsSync(idFile) && fs.existsSync(legacyIdFile)) {
  fs.renameSync(legacyIdFile, idFile);
  console.log("[registry] Migrated bootstrap-identity.json → registry-identity.json");
}
let selfKeypair;
if (fs.existsSync(idFile)) {
  const saved = JSON.parse(fs.readFileSync(idFile, "utf8"));
  selfKeypair = nacl.sign.keyPair.fromSeed(Buffer.from(saved.seed, "base64"));
} else {
  const seed = nacl.randomBytes(32);
  selfKeypair = nacl.sign.keyPair.fromSeed(seed);
  fs.writeFileSync(idFile, JSON.stringify({
    seed: Buffer.from(seed).toString("base64"),
    publicKey: Buffer.from(selfKeypair.publicKey).toString("base64"),
  }, null, 2));
}
const selfPubB64 = Buffer.from(selfKeypair.publicKey).toString("base64");
const selfAgentId = agentIdFromPublicKey(selfPubB64);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
loadWorlds();
setInterval(saveWorlds, PERSIST_INTERVAL_MS);
const STALE_TTL_MS = parseInt(process.env.STALE_TTL_MS ?? String(48 * 60 * 60 * 1000));
setInterval(() => pruneStaleWorlds(STALE_TTL_MS), 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = Fastify({ logger: false });

server.get("/peer/ping", async () => ({
  ok: true,
  ts: Date.now(),
  registry: true,
  worlds: worlds.size,
}));

server.get("/worlds", async () => ({
  ok: true,
  worlds: getWorldsForExchange(50),
}));

// Legacy compat: /peer/peers returns worlds only
server.get("/peer/peers", async () => ({
  peers: getWorldsForExchange(50),
}));

server.post("/peer/announce", async (req, reply) => {
  const ann = req.body;
  if (!ann || typeof ann !== "object") {
    return reply.code(400).send({ error: "Invalid body" });
  }

  const senderId = ann.from;
  if (!senderId) {
    return reply.code(400).send({ error: "Missing 'from' field" });
  }

  if (typeof ann.publicKey !== "string" || ann.publicKey.length === 0) {
    return reply.code(400).send({ error: "Missing 'publicKey' field" });
  }

  if (!isRegistryOrWorld(ann.capabilities)) {
    return reply.code(403).send({ error: "Only World Servers can register. Include a world:* capability." });
  }

  const { signature, ...signable } = ann;
  // Verify against registry-supported protocol separators; ann.version is payload metadata only.
  let sigValid = false;
  for (const announceSep of [ANNOUNCE_SEPARATOR_PREFIX + PROTOCOL_VERSION + "\0"]) {
    if (verifyDomainSeparatedSignature(announceSep, ann.publicKey, signable, signature)) {
      sigValid = true;
      break;
    }
  }
  if (!sigValid) sigValid = verifySignature(ann.publicKey, signable, signature);
  if (!sigValid) {
    return reply.code(403).send({ error: "Invalid Ed25519 signature" });
  }

  const derivedId = agentIdFromPublicKey(ann.publicKey);

  if (senderId !== derivedId) {
    return reply.code(400).send({ error: "from field does not match publicKey-derived agentId" });
  }

  upsertWorld(derivedId, ann.publicKey, {
    alias: ann.alias,
    version: ann.version,
    endpoints: ann.endpoints ?? [],
    capabilities: ann.capabilities ?? [],
  });

  const canShareWorlds = Array.isArray(ann.capabilities) && ann.capabilities.includes("registry");

  // Only sibling registries may share third-party world records, and each shared
  // entry must still bind its advertised agentId to its public key.
  if (canShareWorlds) {
    for (const p of ann.peers ?? []) {
      const sharedWorld = normalizeSharedWorldRecord(p);
      if (!sharedWorld || sharedWorld.agentId === derivedId) continue;
      upsertWorld(sharedWorld.agentId, sharedWorld.publicKey, {
        alias: sharedWorld.alias,
        version: sharedWorld.version,
        endpoints: sharedWorld.endpoints,
        capabilities: sharedWorld.capabilities,
        lastSeen: sharedWorld.lastSeen,
      });
    }
  }

  const worldCap = ann.capabilities.find(c => c.startsWith("world:"));
  console.log(`[registry] ↔ ${worldCap ?? derivedId.slice(0, 16)}  total=${worlds.size}`);

  return { ok: true, peers: getWorldsForExchange(50) };
});

await server.listen({ port: PORT, host: "::" });
console.log(`[registry] Listening on [::]:${PORT}`);
console.log(`[registry] Agent ID: ${selfAgentId}`);
console.log(`[registry] Data dir: ${DATA_DIR}`);

// ---------------------------------------------------------------------------
// Periodic sync with sibling registry nodes
// ---------------------------------------------------------------------------
const BOOTSTRAP_JSON_URL =
  "https://resciencelab.github.io/agent-world-network/bootstrap.json";
const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS ?? String(5 * 60 * 1000));

async function fetchSiblingEndpoints() {
  try {
    const resp = await fetch(BOOTSTRAP_JSON_URL, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.bootstrap_nodes ?? [])
      .filter((n) => n.addr)
      .map((n) => ({ addr: n.addr, port: n.httpPort ?? n.port ?? 8099 }));
  } catch {
    return [];
  }
}

async function syncWithSiblings() {
  const siblings = await fetchSiblingEndpoints();
  if (siblings.length === 0) return;

  const myWorlds = getWorldsForExchange(50);
  const signable = {
    from: selfAgentId,
    publicKey: selfPubB64,
    alias: `AgentWorld Registry (${selfAgentId.slice(0, 8)})`,
    version: AGENT_VERSION,
    timestamp: Date.now(),
    endpoints: [],
    capabilities: ["registry"],
    peers: myWorlds,
  };
  const domainSep = ANNOUNCE_SEPARATOR_PREFIX + PROTOCOL_VERSION + "\0";
  const sig = nacl.sign.detached(
    Buffer.concat([Buffer.from(domainSep, "utf8"), Buffer.from(JSON.stringify(canonicalize(signable)))]),
    selfKeypair.secretKey
  );
  const announcement = { ...signable, signature: Buffer.from(sig).toString("base64") };

  let ok = 0;
  for (const { addr, port } of siblings) {
    if (addr === process.env.PUBLIC_ADDR) continue;
    const isIpv6 = addr.includes(":") && !addr.includes(".");
    const url = isIpv6
      ? `http://[${addr}]:${port}/peer/announce`
      : `http://${addr}:${port}/peer/announce`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(announcement),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const body = await res.json();
        for (const p of body.peers ?? []) {
          const sharedWorld = normalizeSharedWorldRecord(p);
          if (!sharedWorld || sharedWorld.agentId === selfAgentId) continue;
          upsertWorld(sharedWorld.agentId, sharedWorld.publicKey, {
            alias: sharedWorld.alias,
            version: sharedWorld.version,
            endpoints: sharedWorld.endpoints,
            capabilities: sharedWorld.capabilities,
            lastSeen: sharedWorld.lastSeen,
          });
        }
        ok++;
      }
    } catch {}
  }
  if (ok > 0) console.log(`[registry] Synced with ${ok}/${siblings.length} siblings — total worlds: ${worlds.size}`);
}

setTimeout(syncWithSiblings, 10_000);
setInterval(syncWithSiblings, SYNC_INTERVAL_MS);
console.log(`[registry] Sibling sync enabled (interval: ${SYNC_INTERVAL_MS / 1000}s)`);
