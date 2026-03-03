/**
 * Yggdrasil daemon management.
 * Ported from agents/identity.py#start_yggdrasil and yggdrasil-router/entrypoint.sh
 * in the agent-economy-ipv6-mvp project.
 */
import { spawn, ChildProcess, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { YggdrasilInfo } from "./types";

const DEFAULT_BOOTSTRAP_PEERS = [
  "tcp://yggdrasil.mnpnk.com:10002",
  "tcp://ygg.mkg20001.io:80",
  "tcp://46.246.86.205:60002",
];

const WELL_KNOWN_TCP_ENDPOINTS = [
  "tcp://127.0.0.1:9001",
];

const WELL_KNOWN_SOCKETS = [
  "/var/run/yggdrasil.sock",
  "/run/yggdrasil.sock",
];

let yggProcess: ChildProcess | null = null;
let detectedEndpoint: string | null = null;

function tryYggdrasilctl(endpoint: string): YggdrasilInfo | null {
  try {
    const cmd = endpoint
      ? `yggdrasilctl -json -endpoint ${endpoint} getSelf`
      : `yggdrasilctl -json getSelf`
    const raw = execSync(cmd, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const data = JSON.parse(raw)
    const address = data.address || data.IPv6Address || data.ipv6_address
    const subnet = data.subnet || data.IPv6Subnet || data.ipv6_subnet || ""
    if (address) return { address, subnet, pid: 0 }
  } catch { /* endpoint unreachable */ }
  return null
}

/**
 * Try to detect an already-running Yggdrasil daemon.
 * Checks TCP admin endpoints first (no permission issues), then UNIX sockets.
 */
export function detectExternalYggdrasil(extraSocketPaths: string[] = []): YggdrasilInfo | null {
  // 1. Try TCP endpoints first — no permission issues
  for (const ep of WELL_KNOWN_TCP_ENDPOINTS) {
    const info = tryYggdrasilctl(ep)
    if (info) {
      console.log(`[ygg] Detected external Yggdrasil daemon via ${ep}`)
      detectedEndpoint = ep
      return info
    }
  }

  // 2. Try bare yggdrasilctl (uses its own defaults / config)
  const bare = tryYggdrasilctl("")
  if (bare) {
    console.log("[ygg] Detected external Yggdrasil daemon via default endpoint")
    detectedEndpoint = null
    return bare
  }

  // 3. Fall back to UNIX sockets
  const candidates = [...WELL_KNOWN_SOCKETS, ...extraSocketPaths]
  for (const sock of candidates) {
    if (!fs.existsSync(sock)) continue
    const endpoint = sock.startsWith("unix://") ? sock : `unix://${sock}`
    const info = tryYggdrasilctl(endpoint)
    if (info) {
      console.log(`[ygg] Detected external Yggdrasil daemon via ${sock}`)
      detectedEndpoint = endpoint
      return info
    }
    console.log(`[ygg] Socket ${sock} exists but yggdrasilctl failed — likely permission denied (run: scripts/setup-yggdrasil.sh to fix)`)
  }
  return null
}

/** Check if the yggdrasil binary is available on PATH. */
export function isYggdrasilAvailable(): boolean {
  try {
    execSync("yggdrasil -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate Yggdrasil config file with the given bootstrap peers.
 * Patches IfName to "auto" (creates TUN, making 200::/8 routable),
 * injects AdminListen socket, and sets bootstrap peers.
 */
function generateConfig(confFile: string, sockFile: string, extraPeers: string[]): void {
  const raw = execSync("yggdrasil -genconf", { encoding: "utf-8" });
  let conf = raw;

  // Inject AdminListen — prefer TCP to avoid UNIX socket permission issues
  const adminListen = WELL_KNOWN_TCP_ENDPOINTS[0] || `unix://${sockFile}`
  if (!conf.includes("AdminListen:")) {
    conf = conf.trimEnd();
    if (conf.endsWith("}")) {
      conf = conf.slice(0, -1).trimEnd() + `\n  AdminListen: "${adminListen}"\n}\n`;
    }
  } else {
    conf = conf.replace(/AdminListen:.*/, `AdminListen: "${adminListen}"`);
  }

  // Enable TUN interface so 200::/8 addresses are routable
  conf = conf.replace(/IfName:.*/, "IfName: auto");

  // Set bootstrap peers
  const allPeers = [...DEFAULT_BOOTSTRAP_PEERS, ...extraPeers];
  const peerStr = allPeers.map((p) => `    "${p}"`).join("\n");
  conf = conf.replace(/Peers:\s*\[\s*\]/, `Peers: [\n${peerStr}\n  ]`);

  fs.writeFileSync(confFile, conf);
}

/**
 * Start the Yggdrasil daemon and wait for it to obtain an address.
 * Returns null if yggdrasil binary is not found or startup fails.
 */
export async function startYggdrasil(
  dataDir: string,
  extraPeers: string[] = []
): Promise<YggdrasilInfo | null> {
  if (!isYggdrasilAvailable()) {
    console.warn("[ygg] yggdrasil binary not found — P2P via Yggdrasil disabled");
    return null;
  }

  // 1. Try to reuse an already-running system Yggdrasil
  const pluginSock = path.join(dataDir, "yggdrasil", "yggdrasil.sock");
  const external = detectExternalYggdrasil([pluginSock]);
  if (external) {
    console.log(`[ygg] Reusing external daemon — address: ${external.address}`);
    ensurePublicPeers();
    return external;
  }

  // 2. No external daemon found — spawn our own
  console.log("[ygg] No external Yggdrasil daemon detected — spawning managed instance");
  const yggDir = path.join(dataDir, "yggdrasil");
  fs.mkdirSync(yggDir, { recursive: true });

  const confFile = path.join(yggDir, "yggdrasil.conf");
  const sockFile = pluginSock;
  const logFile = path.join(yggDir, "yggdrasil.log");

  if (!fs.existsSync(confFile)) {
    generateConfig(confFile, sockFile, extraPeers);
  } else {
    let conf = fs.readFileSync(confFile, "utf-8");
    const updated = conf.replace(/IfName:.*/, "IfName: auto");
    if (updated !== conf) {
      fs.writeFileSync(confFile, updated);
    }
  }

  const logStream = fs.openSync(logFile, "w");
  yggProcess = spawn("yggdrasil", ["-useconffile", confFile], {
    stdio: ["ignore", logStream, logStream],
    detached: false,
  });

  // Wait up to 15s for address to appear in log
  const info = await waitForAddress(logFile, 15);
  if (!info) {
    yggProcess.kill();
    yggProcess = null;
    return null;
  }

  // Verify the spawned process is still alive (TUN creation may fail without root)
  await sleep(500);
  if (yggProcess.exitCode !== null) {
    const logContent = fs.readFileSync(logFile, "utf-8");
    const panicMatch = logContent.match(/panic: (.+)/);
    console.warn(`[ygg] Spawned Yggdrasil exited: ${panicMatch?.[1] ?? "unknown reason"}`);
    console.warn("[ygg] TUN creation requires root. Use a system-level Yggdrasil daemon instead.");
    yggProcess = null;
    return null;
  }

  console.log(`[ygg] Started — address: ${info.address}  pid: ${info.pid}`);
  return info;
}

async function waitForAddress(logFile: string, timeoutSec: number): Promise<YggdrasilInfo | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await sleep(1000);
    if (!fs.existsSync(logFile)) continue;
    const content = fs.readFileSync(logFile, "utf-8");
    const mAddr = content.match(/Your IPv6 address is (\S+)/);
    const mSub = content.match(/Your IPv6 subnet is (\S+)/);
    if (mAddr) {
      return {
        address: mAddr[1],
        subnet: mSub ? mSub[1] : "",
        pid: yggProcess?.pid ?? 0,
      };
    }
  }
  return null;
}

/** Build yggdrasilctl command prefix using the detected admin endpoint */
function yggctl(subcmd: string): string {
  if (detectedEndpoint) {
    return `yggdrasilctl -json -endpoint ${detectedEndpoint} ${subcmd}`
  }
  return `yggdrasilctl -json ${subcmd}`
}

/**
 * Ensure the running Yggdrasil daemon has at least one public peer.
 * If only multicast/LAN peers are connected, inject default public peers
 * via yggdrasilctl so the node can route to the wider Yggdrasil network.
 */
export function ensurePublicPeers(): void {
  try {
    const raw = execSync(yggctl("getPeers"), {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const peers: Array<{ uri?: string; remote?: string }> = JSON.parse(raw);
    const hasPublicPeer = peers.some((p) => {
      const uri = p.uri ?? p.remote ?? "";
      return uri.startsWith("tcp://") || uri.startsWith("tls://");
    });

    if (!hasPublicPeer || peers.length === 0) {
      console.log("[ygg] No public peers detected — injecting default peers");
      const addPrefix = detectedEndpoint
        ? `yggdrasilctl -endpoint ${detectedEndpoint}`
        : `yggdrasilctl`
      for (const peer of DEFAULT_BOOTSTRAP_PEERS) {
        try {
          execSync(`${addPrefix} addPeer uri="${peer}"`, {
            timeout: 5000,
            stdio: "ignore",
          });
        } catch {
          // Peer may already exist or be unreachable — best effort
        }
      }
      console.log(`[ygg] Injected ${DEFAULT_BOOTSTRAP_PEERS.length} public peer(s)`);
    }
  } catch {
    // yggdrasilctl not available or failed — skip
  }
}

export function stopYggdrasil(): void {
  if (yggProcess) {
    yggProcess.kill();
    yggProcess = null;
  }
}

/**
 * Query the running Yggdrasil daemon for peer count and routing table size.
 * Returns null if yggdrasilctl is not available.
 */
export function getYggdrasilNetworkInfo(): { peerCount: number; publicPeers: number; routeCount: number } | null {
  try {
    const peersRaw = execSync(yggctl("getPeers"), {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const peers: Array<{ uri?: string; remote?: string }> = JSON.parse(peersRaw);
    const publicPeers = peers.filter((p) => {
      const uri = p.uri ?? p.remote ?? "";
      return uri.startsWith("tcp://") || uri.startsWith("tls://");
    }).length;

    let routeCount = 0;
    try {
      const treeRaw = execSync(yggctl("getTree"), {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      routeCount = JSON.parse(treeRaw).length ?? 0;
    } catch { /* optional */ }

    return { peerCount: peers.length, publicPeers, routeCount };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
