/**
 * DAP Pokemon Battle World Agent
 * Turn-based Pokemon battle powered by @pkmn/sim.
 *
 * Each agent that joins gets matched into a 1v1 battle (3 random Gen 1 Pokemon).
 * If no opponent is available, the agent fights a built-in RandomAI.
 *
 * Endpoints (same DAP World Agent interface as server.mjs):
 *   GET  /peer/ping        — health check
 *   GET  /peer/peers       — known DAP peers
 *   POST /peer/announce    — accept signed peer announcement
 *   POST /peer/message     — world.join / world.action / world.leave
 *   GET  /world/state      — current world snapshot
 *
 * Actions (sent via world.action):
 *   { action: "move",   slot: 1-4 }   — use move in slot N
 *   { action: "switch", slot: 1-6 }   — switch to Pokemon in slot N
 *
 * Env:
 *   WORLD_ID      — unique world id (default "pokemon-arena")
 *   WORLD_NAME    — display name (default "Pokemon Battle Arena")
 *   PEER_PORT     — DAP HTTP port (default 8099)
 *   DATA_DIR      — persistence directory (default /data)
 *   BOOTSTRAP_URL — bootstrap.json URL
 *   PUBLIC_ADDR   — own public IP/hostname for announce
 *   TEAM_SIZE     — Pokemon per team (default 3)
 *   GEN           — generation for random teams (default 1)
 */
import Fastify from "fastify";
import nacl from "tweetnacl";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Dex, BattleStreams, RandomPlayerAI, Teams } = require("@pkmn/sim");
const { TeamGenerators } = require("@pkmn/randoms");
Teams.setGeneratorFactory(TeamGenerators);

const WORLD_ID = process.env.WORLD_ID ?? "pokemon-arena";
const WORLD_NAME = process.env.WORLD_NAME ?? "Pokemon Battle Arena";
const PORT = parseInt(process.env.PEER_PORT ?? "8099");
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const PUBLIC_ADDR = process.env.PUBLIC_ADDR ?? null;
const BOOTSTRAP_URL = process.env.BOOTSTRAP_URL ?? "https://resciencelab.github.io/DAP/bootstrap.json";
const TEAM_SIZE = parseInt(process.env.TEAM_SIZE ?? "3");
const GEN = parseInt(process.env.GEN ?? "1");
const FORMAT = `gen${GEN}randombattle`;
const MAX_PEERS = 200;
const MAX_EVENTS = 100;

// ---------------------------------------------------------------------------
// Crypto helpers (mirrors bootstrap/server.mjs)
// ---------------------------------------------------------------------------

function agentIdFromPublicKey(publicKeyB64) {
  return crypto.createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").slice(0, 32);
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
  } catch { return false; }
}

function signPayload(payload, secretKey) {
  const sig = nacl.sign.detached(Buffer.from(JSON.stringify(canonicalize(payload))), secretKey);
  return Buffer.from(sig).toString("base64");
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
fs.mkdirSync(DATA_DIR, { recursive: true });

const idFile = path.join(DATA_DIR, "world-identity.json");
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

console.log(`[pokemon] agentId=${selfAgentId} world=${WORLD_ID}`);

// ---------------------------------------------------------------------------
// Peer DB
// ---------------------------------------------------------------------------
const peers = new Map();

function upsertPeer(agentId, publicKey, opts = {}) {
  const existing = peers.get(agentId);
  peers.set(agentId, {
    agentId,
    publicKey: publicKey || existing?.publicKey || "",
    alias: opts.alias ?? existing?.alias ?? "",
    endpoints: opts.endpoints ?? existing?.endpoints ?? [],
    capabilities: opts.capabilities ?? existing?.capabilities ?? [],
    lastSeen: Date.now(),
  });
  if (peers.size > MAX_PEERS) {
    const oldest = [...peers.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
    peers.delete(oldest.agentId);
  }
}

function getPeersForExchange(limit = 50) {
  return [...peers.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, limit)
    .map(({ agentId, publicKey, alias, endpoints, capabilities, lastSeen }) => ({
      agentId, publicKey, alias, endpoints: endpoints ?? [], capabilities: capabilities ?? [], lastSeen,
    }));
}

// ---------------------------------------------------------------------------
// World Manifest
// ---------------------------------------------------------------------------

const MANIFEST = {
  name: WORLD_NAME,
  theme: "pokemon-battle",
  description: `Turn-based Pokemon battle arena (Gen ${GEN}). Each player gets ${TEAM_SIZE} random Pokemon. Defeat all opponent Pokemon to win. You battle against a built-in AI opponent.`,
  objective: "Knock out all opponent Pokemon to win the battle.",
  rules: [
    "Each battle is 1v1 with random teams.",
    "On each turn you must choose a move (slot 1-4) or switch Pokemon (slot 1-6).",
    "Type matchups matter: Fire > Grass > Water > Fire, etc.",
    "You can only switch to Pokemon that are not fainted.",
    "The battle ends when all Pokemon on one side faint.",
  ],
  actions: {
    move: {
      params: { slot: "1-4 (index of the move to use)" },
      desc: "Use the move in the given slot. Check your active Pokemon's moves in the battle state.",
    },
    switch: {
      params: { slot: "1-6 (index of the Pokemon to switch to)" },
      desc: "Switch your active Pokemon to the one in the given slot. Cannot switch to fainted Pokemon or the currently active one.",
    },
  },
  state_fields: [
    "battleId — unique battle identifier",
    "turn — current turn number",
    "active — your active Pokemon (name, hp, maxHp, moves with pp)",
    "team — your full team (name, hp, maxHp, active, fainted)",
    "opponent — opponent's active Pokemon (name, hp% estimate)",
    "log — recent battle log lines describing what happened",
    "waitingForAction — true when it is your turn to act",
    "battleOver — true when the battle has ended",
    "winner — the winner's name when battleOver is true",
  ],
};

// ---------------------------------------------------------------------------
// Battle Manager
// ---------------------------------------------------------------------------

// agentId -> BattleSession
const battles = new Map();

// recent events
const events = [];
function addEvent(type, data) {
  const ev = { type, ...data, ts: Date.now() };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
  return ev;
}

class BattleSession {
  constructor(agentId, alias) {
    this.agentId = agentId;
    this.alias = alias;
    this.battleId = crypto.randomUUID();
    this.battleOver = false;
    this.winner = null;
    this.turn = 0;
    this.log = [];
    this.pendingRequest = null;
    this.team = null;
    this.startedAt = Date.now();

    this._initBattle();
  }

  _initBattle() {
    const stream = new BattleStreams.BattleStream();
    this.streams = BattleStreams.getPlayerStreams(stream);

    // p2 is the built-in RandomAI
    this.ai = new RandomPlayerAI(this.streams.p2);
    void this.ai.start();

    // Generate teams
    const fullTeam1 = Teams.generate(FORMAT);
    const fullTeam2 = Teams.generate(FORMAT);
    const team1 = fullTeam1.slice(0, TEAM_SIZE);
    const team2 = fullTeam2.slice(0, TEAM_SIZE);
    this.team = team1;

    const p1spec = { name: this.alias, team: Teams.pack(team1) };
    const p2spec = { name: "Wild AI", team: Teams.pack(team2) };

    // Listen to p1 stream for battle events
    this._listenP1();

    // Start the battle
    void this.streams.omniscient.write(
      `>start ${JSON.stringify({ formatid: FORMAT })}\n>player p1 ${JSON.stringify(p1spec)}\n>player p2 ${JSON.stringify(p2spec)}`
    );
  }

  async _listenP1() {
    try {
      for await (const chunk of this.streams.p1) {
        this._processChunk(chunk);
      }
    } catch {}
  }

  _processChunk(chunk) {
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("|request|")) {
        const req = JSON.parse(line.slice(9));
        this.pendingRequest = req;
        if (req.active) {
          this.turn++;
        }
      } else if (line.startsWith("|win|")) {
        this.winner = line.slice(5);
        this.battleOver = true;
        this.pendingRequest = null;
        this.log.push(`Battle over! Winner: ${this.winner}`);
        addEvent("battle.end", { agentId: this.agentId, battleId: this.battleId, winner: this.winner });
      } else if (line === "|tie" || line.startsWith("|tie|")) {
        this.winner = "tie";
        this.battleOver = true;
        this.pendingRequest = null;
        this.log.push("Battle ended in a tie!");
        addEvent("battle.end", { agentId: this.agentId, battleId: this.battleId, winner: "tie" });
      } else if (line.startsWith("|turn|")) {
        this.turn = parseInt(line.split("|")[2]);
      } else if (line.startsWith("|error|")) {
        this.log.push(`Error: ${line.slice(7)}`);
      } else if (
        line.startsWith("|move|") || line.startsWith("|-damage|") ||
        line.startsWith("|-supereffective") || line.startsWith("|-resisted") ||
        line.startsWith("|switch|") || line.startsWith("|faint|") ||
        line.startsWith("|-crit") || line.startsWith("|-miss") ||
        line.startsWith("|-status|") || line.startsWith("|-heal|") ||
        line.startsWith("|-boost|") || line.startsWith("|-unboost|")
      ) {
        this.log.push(this._formatLogLine(line));
        if (this.log.length > 30) this.log.shift();
      }
    }
  }

  _formatLogLine(line) {
    const parts = line.split("|").filter(Boolean);
    const type = parts[0];
    switch (type) {
      case "move": return `${this._shortName(parts[1])} used ${parts[2]}!`;
      case "-damage": return `${this._shortName(parts[1])} took damage → ${parts[2]}`;
      case "-supereffective": return "It's super effective!";
      case "-resisted": return "It's not very effective...";
      case "switch": return `${this._shortName(parts[1])} sent out ${parts[2].split(",")[0]}!`;
      case "faint": return `${this._shortName(parts[1])} fainted!`;
      case "-crit": return "A critical hit!";
      case "-miss": return `${this._shortName(parts[1])} missed!`;
      case "-status": return `${this._shortName(parts[1])} was ${parts[2]}!`;
      case "-heal": return `${this._shortName(parts[1])} healed → ${parts[2]}`;
      case "-boost": return `${this._shortName(parts[1])}'s ${parts[2]} rose!`;
      case "-unboost": return `${this._shortName(parts[1])}'s ${parts[2]} fell!`;
      default: return line;
    }
  }

  _shortName(ident) {
    if (!ident) return "???";
    // "p1a: Pikachu" -> "Pikachu"
    return ident.includes(":") ? ident.split(": ")[1] : ident;
  }

  getState() {
    const req = this.pendingRequest;
    const state = {
      battleId: this.battleId,
      turn: this.turn,
      battleOver: this.battleOver,
      winner: this.winner,
      log: this.log.slice(-10),
      waitingForAction: false,
      active: null,
      team: [],
      opponent: null,
    };

    if (!req) return state;

    // Parse team from request
    if (req.side?.pokemon) {
      state.team = req.side.pokemon.map((p, i) => {
        const [hp, maxHp] = (p.condition || "0 fnt").split("/").map(s => parseInt(s));
        return {
          slot: i + 1,
          name: p.details.split(",")[0],
          hp: isNaN(hp) ? 0 : hp,
          maxHp: isNaN(maxHp) ? 0 : maxHp,
          active: p.active || false,
          fainted: p.condition.includes("fnt"),
        };
      });
      const activePoke = req.side.pokemon.find(p => p.active);
      if (activePoke && req.active?.[0]) {
        const [hp, maxHp] = activePoke.condition.split("/").map(s => parseInt(s));
        state.active = {
          name: activePoke.details.split(",")[0],
          hp, maxHp,
          moves: req.active[0].moves.map((m, i) => ({
            slot: i + 1,
            name: m.move,
            pp: m.pp,
            maxPp: m.maxpp,
            disabled: m.disabled || false,
          })),
        };
      }
    }

    // forceSwitch means we must switch, not move
    if (req.forceSwitch) {
      state.waitingForAction = true;
      state.mustSwitch = true;
    } else if (req.active) {
      state.waitingForAction = true;
      state.mustSwitch = false;
    }

    return state;
  }

  submitAction(action, slot) {
    if (this.battleOver) return { ok: false, error: "Battle is already over." };
    if (!this.pendingRequest) return { ok: false, error: "Not waiting for action." };

    const req = this.pendingRequest;

    if (action === "move") {
      if (req.forceSwitch) return { ok: false, error: "You must switch Pokemon, not use a move." };
      if (!req.active?.[0]?.moves) return { ok: false, error: "No moves available." };
      const moveIdx = parseInt(slot);
      if (isNaN(moveIdx) || moveIdx < 1 || moveIdx > req.active[0].moves.length) {
        return { ok: false, error: `Invalid move slot. Choose 1-${req.active[0].moves.length}.` };
      }
      const move = req.active[0].moves[moveIdx - 1];
      if (move.disabled) return { ok: false, error: `Move ${move.move} is disabled.` };
      if (move.pp <= 0) return { ok: false, error: `Move ${move.move} has no PP left.` };
      this.pendingRequest = null;
      this.streams.p1.write(`move ${moveIdx}`);
      return { ok: true, chose: `move ${moveIdx} (${move.move})` };
    }

    if (action === "switch") {
      const switchIdx = parseInt(slot);
      if (!req.side?.pokemon) return { ok: false, error: "No team data." };
      if (isNaN(switchIdx) || switchIdx < 1 || switchIdx > req.side.pokemon.length) {
        return { ok: false, error: `Invalid switch slot. Choose 1-${req.side.pokemon.length}.` };
      }
      const target = req.side.pokemon[switchIdx - 1];
      if (target.active) return { ok: false, error: "That Pokemon is already active." };
      if (target.condition.includes("fnt")) return { ok: false, error: "That Pokemon has fainted." };
      this.pendingRequest = null;
      this.streams.p1.write(`switch ${switchIdx}`);
      return { ok: true, chose: `switch ${switchIdx} (${target.details.split(",")[0]})` };
    }

    return { ok: false, error: `Unknown action "${action}". Use "move" or "switch".` };
  }
}

// ---------------------------------------------------------------------------
// Bootstrap discovery (same as server.mjs)
// ---------------------------------------------------------------------------

async function fetchBootstrapNodes() {
  try {
    const resp = await fetch(BOOTSTRAP_URL, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.bootstrap_nodes ?? []).filter((n) => n.addr).map((n) => ({
      addr: n.addr, httpPort: n.httpPort ?? 8099,
    }));
  } catch { return []; }
}

async function announceToNode(addr, httpPort) {
  const isIpv6 = addr.includes(":") && !addr.includes(".");
  const url = isIpv6 ? `http://[${addr}]:${httpPort}/peer/announce` : `http://${addr}:${httpPort}/peer/announce`;
  const selfAddr = PUBLIC_ADDR ?? null;
  const endpoints = selfAddr
    ? [{ transport: "tcp", address: selfAddr, port: PORT, priority: 1, ttl: 3600 }]
    : [];
  const payload = {
    from: selfAgentId,
    publicKey: selfPubB64,
    alias: WORLD_NAME,
    version: "1.0.0",
    endpoints,
    capabilities: [`world:${WORLD_ID}`],
    timestamp: Date.now(),
  };
  payload.signature = signPayload(payload, selfKeypair.secretKey);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    for (const peer of data.peers ?? []) {
      if (peer.agentId && peer.agentId !== selfAgentId) {
        upsertPeer(peer.agentId, peer.publicKey, {
          alias: peer.alias, endpoints: peer.endpoints, capabilities: peer.capabilities,
        });
      }
    }
    console.log(`[pokemon] Announced to ${addr}:${httpPort}, got ${data.peers?.length ?? 0} peers`);
  } catch (e) {
    console.warn(`[pokemon] Could not reach bootstrap ${addr}:${httpPort}: ${e.message}`);
  }
}

async function bootstrapDiscovery() {
  const nodes = await fetchBootstrapNodes();
  if (!nodes.length) { console.warn("[pokemon] No bootstrap nodes found"); return; }
  await Promise.allSettled(nodes.map((n) => announceToNode(n.addr, n.httpPort)));
}

// ---------------------------------------------------------------------------
// Outbound messaging
// ---------------------------------------------------------------------------

async function sendMessage(endpoints, event, content) {
  if (!endpoints?.length) return;
  const sorted = [...endpoints].sort((a, b) => a.priority - b.priority);
  const payload = {
    from: selfAgentId,
    publicKey: selfPubB64,
    event,
    content: typeof content === "string" ? content : JSON.stringify(content),
    timestamp: Date.now(),
  };
  payload.signature = signPayload(payload, selfKeypair.secretKey);
  for (const ep of sorted) {
    try {
      const addr = ep.address;
      const port = ep.port ?? 8099;
      const isIpv6 = addr.includes(":") && !addr.includes(".");
      const url = isIpv6 ? `http://[${addr}]:${port}/peer/message` : `http://${addr}:${port}/peer/message`;
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      });
      return;
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Fastify server
// ---------------------------------------------------------------------------

const fastify = Fastify({ logger: false });

fastify.get("/peer/ping", async () => ({
  ok: true, ts: Date.now(), worldId: WORLD_ID, worldName: WORLD_NAME,
  activeBattles: battles.size,
}));

fastify.get("/peer/peers", async () => ({
  peers: getPeersForExchange(),
}));

fastify.get("/world/state", async () => ({
  worldId: WORLD_ID,
  worldName: WORLD_NAME,
  theme: "pokemon-battle",
  activeBattles: battles.size,
  agents: [...battles.values()].map(b => ({
    agentId: b.agentId,
    alias: b.alias,
    battleId: b.battleId,
    turn: b.turn,
    battleOver: b.battleOver,
    winner: b.winner,
  })),
  recentEvents: events.slice(-20),
  ts: Date.now(),
}));

fastify.post("/peer/announce", async (req, reply) => {
  const ann = req.body;
  const { signature, ...signable } = ann;
  if (!verifySignature(ann.publicKey, signable, signature)) {
    return reply.code(403).send({ error: "Invalid signature" });
  }
  const agentId = ann.from;
  if (!agentId) return reply.code(400).send({ error: "Missing from" });
  if (agentIdFromPublicKey(ann.publicKey) !== agentId) {
    return reply.code(400).send({ error: "agentId does not match publicKey" });
  }
  upsertPeer(agentId, ann.publicKey, {
    alias: ann.alias, endpoints: ann.endpoints, capabilities: ann.capabilities,
  });
  return { peers: getPeersForExchange() };
});

fastify.post("/peer/message", async (req, reply) => {
  const msg = req.body;
  const { signature, ...signable } = msg;

  if (!verifySignature(msg.publicKey, signable, signature)) {
    return reply.code(403).send({ error: "Invalid signature" });
  }
  const agentId = msg.from;
  if (!agentId) return reply.code(400).send({ error: "Missing from" });

  const knownPeer = peers.get(agentId);
  if (knownPeer?.publicKey) {
    if (knownPeer.publicKey !== msg.publicKey) {
      return reply.code(403).send({ error: "publicKey does not match TOFU binding for this agentId" });
    }
  } else {
    if (agentIdFromPublicKey(msg.publicKey) !== agentId) {
      return reply.code(400).send({ error: "agentId does not match publicKey" });
    }
  }

  upsertPeer(agentId, msg.publicKey, {});

  let data = {};
  try { data = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content; } catch {}

  switch (msg.event) {
    case "world.join": {
      // If agent already has a battle, return its state
      if (battles.has(agentId)) {
        const existing = battles.get(agentId);
        return {
          ok: true, worldId: WORLD_ID,
          manifest: MANIFEST,
          battleId: existing.battleId,
          state: existing.getState(),
        };
      }
      const alias = data.alias ?? msg.alias ?? agentId.slice(0, 8);
      const session = new BattleSession(agentId, alias);
      battles.set(agentId, session);
      addEvent("join", { agentId, alias, worldId: WORLD_ID, battleId: session.battleId });
      console.log(`[pokemon] ${alias} (${agentId.slice(0, 8)}) joined — battle ${session.battleId.slice(0, 8)}`);

      // Give the battle stream a moment to process initial state
      await new Promise(r => setTimeout(r, 100));

      return {
        ok: true, worldId: WORLD_ID,
        manifest: MANIFEST,
        battleId: session.battleId,
        state: session.getState(),
      };
    }

    case "world.leave": {
      const session = battles.get(agentId);
      if (session) {
        battles.delete(agentId);
        addEvent("leave", { agentId, alias: session.alias, worldId: WORLD_ID, battleId: session.battleId });
        console.log(`[pokemon] ${session.alias} left`);
      }
      return { ok: true };
    }

    case "world.action": {
      const session = battles.get(agentId);
      if (!session) return reply.code(400).send({ error: "Not in a battle — send world.join first." });

      const action = data.action;
      const slot = data.slot;

      if (!action) return reply.code(400).send({ error: 'Missing "action" field. Use "move" or "switch".' });
      if (slot == null) return reply.code(400).send({ error: 'Missing "slot" field.' });

      const result = session.submitAction(action, slot);

      // Wait briefly for battle engine to process
      await new Promise(r => setTimeout(r, 100));

      const state = session.getState();

      // If battle just ended, clean up after response
      if (state.battleOver) {
        addEvent("battle.end", { agentId, alias: session.alias, battleId: session.battleId, winner: state.winner });
      }

      return { ...result, state };
    }

    default:
      return { ok: true };
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await fastify.listen({ port: PORT, host: "::" });
console.log(`[pokemon] Listening on [::]:${PORT}  world=${WORLD_ID}`);
console.log(`[pokemon] Format: ${FORMAT}, team size: ${TEAM_SIZE}`);

setTimeout(bootstrapDiscovery, 3_000);
setInterval(bootstrapDiscovery, 10 * 60 * 1000);

// Clean up finished battles older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, session] of battles) {
    if (session.battleOver && session.startedAt < cutoff) {
      battles.delete(id);
    }
  }
}, 5 * 60 * 1000);
