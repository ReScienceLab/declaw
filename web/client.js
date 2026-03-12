/**
 * DAP Playground — browser client
 * WebSocket → Gateway → DAP network → World Agent
 */

const GATEWAY_WS = (window.GATEWAY_WS_URL ?? `ws://${location.host}/ws`);
const GATEWAY_HTTP = (window.GATEWAY_HTTP_URL ?? `http://${location.host}`);

// ── State ──────────────────────────────────────────────────────────────────
let ws = null;
let myAgentId = null;
let currentWorldId = null;
let joined = false;
let worldState = { agents: [] };
const worlds = [];

// Canvas config
const TILE = 16;  // pixels per cell on canvas
const COLS = 32;
const ROWS = 32;
const CANVAS_W = COLS * TILE;
const CANVAS_H = ROWS * TILE;

// Pixel art color palette
const COLORS = [
  "#0047ab", "#3a7fff", "#00ff88", "#ffcc00",
  "#ff4466", "#cc44ff", "#00ccff", "#ff8800",
];

function agentColor(agentId) {
  let h = 0;
  for (let i = 0; i < agentId.length; i++) h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

// ── DOM refs ───────────────────────────────────────────────────────────────
const $statusDot = document.getElementById("status-dot");
const $statusText = document.getElementById("status-text");
const $agentIdDisplay = document.getElementById("agent-id-display");
const $worldsList = document.getElementById("worlds-list");
const $canvas = document.getElementById("world-canvas");
const $canvasOverlay = document.getElementById("canvas-overlay");
const $overlayMsg = document.getElementById("overlay-msg");
const $eventsList = document.getElementById("events-list");
const $aliasInput = document.getElementById("alias-input");
const $joinBtn = document.getElementById("join-btn");
const $leaveBtn = document.getElementById("leave-btn");
const ctx = $canvas.getContext("2d");

$canvas.width = CANVAS_W;
$canvas.height = CANVAS_H;

// ── Rendering ──────────────────────────────────────────────────────────────
function renderWorld() {
  // Background grid
  ctx.fillStyle = "#050508";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.strokeStyle = "#0e0e18";
  ctx.lineWidth = 1;
  for (let x = 0; x <= COLS; x++) {
    ctx.beginPath(); ctx.moveTo(x * TILE, 0); ctx.lineTo(x * TILE, CANVAS_H); ctx.stroke();
  }
  for (let y = 0; y <= ROWS; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * TILE); ctx.lineTo(CANVAS_W, y * TILE); ctx.stroke();
  }

  // Agents
  for (const agent of worldState.agents ?? []) {
    const px = agent.x * TILE;
    const py = agent.y * TILE;
    const color = agentColor(agent.agentId);
    const isMe = agent.agentId === myAgentId;

    // Body (pixel sprite: 10×10 centered in tile)
    ctx.fillStyle = color;
    ctx.fillRect(px + 3, py + 3, 10, 10);

    // Highlight own agent
    if (isMe) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 2, py + 2, 12, 12);
    }

    // Alias label
    ctx.font = "8px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = isMe ? "#fff" : "#ccc";
    const label = (agent.alias ?? agent.agentId.slice(0, 6)).slice(0, 8);
    ctx.fillText(label, px + TILE / 2, py - 2);
  }
}

// ── Events log ─────────────────────────────────────────────────────────────
function addEvent(type, text) {
  const el = document.createElement("div");
  el.className = `event-item ${type}`;
  const t = new Date().toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  el.innerHTML = `<span class="ev-time">${t}</span>${text}`;
  $eventsList.prepend(el);
  if ($eventsList.children.length > 60) $eventsList.lastChild.remove();
}

// ── World list ─────────────────────────────────────────────────────────────
async function fetchWorlds() {
  try {
    const res = await fetch(`${GATEWAY_HTTP}/worlds`);
    const data = await res.json();
    worlds.length = 0;
    worlds.push(...(data.worlds ?? []));
    renderWorldList();
  } catch (e) {
    console.warn("Could not fetch worlds:", e.message);
  }
}

function renderWorldList() {
  $worldsList.innerHTML = "";
  if (!worlds.length) {
    $worldsList.innerHTML = '<div style="padding:12px;color:#7070a0;font-size:11px;">No worlds found</div>';
    return;
  }
  for (const w of worlds) {
    const el = document.createElement("div");
    el.className = "world-item" + (w.worldId === currentWorldId ? " active" : "");
    el.innerHTML = `
      <div class="world-name">
        <span class="world-dot ${w.reachable ? "" : "offline"}"></span>${w.name || w.worldId}
      </div>
      <div class="world-meta">${w.worldId}${w.reachable ? "" : " · offline"}</div>
    `;
    el.addEventListener("click", () => connectToWorld(w.worldId));
    $worldsList.appendChild(el);
  }
}

// ── WebSocket connection ───────────────────────────────────────────────────
function connectToWorld(worldId) {
  if (ws) { ws.close(); ws = null; }

  currentWorldId = worldId;
  joined = false;
  worldState = { agents: [] };
  renderWorldList();
  renderWorld();
  showOverlay(`Connecting to ${worldId}...`);
  setStatus(false, "connecting...");

  ws = new WebSocket(`${GATEWAY_WS}?world=${encodeURIComponent(worldId)}`);

  ws.onopen = () => {
    setStatus(true, `world:${worldId}`);
    showOverlay(`Press Join to enter ${worldId}`);
    addEvent("action", `Connected to ${worldId}`);
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case "connected":
        myAgentId = msg.agentId;
        $agentIdDisplay.textContent = `agent: ${myAgentId.slice(0, 12)}...`;
        break;

      case "join_result":
        if (msg.ok) {
          joined = true;
          hideOverlay();
          $joinBtn.disabled = true;
          $leaveBtn.disabled = false;
          addEvent("join", "You joined the world");
        } else {
          addEvent("action", `Join failed: ${msg.error ?? "unknown"}`);
        }
        break;

      case "action_result":
        break;

      case "world.state":
        worldState = msg;
        renderWorld();
        break;

      case "error":
        addEvent("action", `Error: ${msg.message}`);
        break;
    }
  };

  ws.onclose = () => {
    setStatus(false, "disconnected");
    joined = false;
    $joinBtn.disabled = false;
    $leaveBtn.disabled = true;
    showOverlay("Disconnected. Select a world to reconnect.");
    addEvent("leave", "Disconnected");
  };

  ws.onerror = () => addEvent("action", "WebSocket error");
}

// ── Controls ───────────────────────────────────────────────────────────────
$joinBtn.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "join", alias: $aliasInput.value.trim() || undefined }));
});

$leaveBtn.addEventListener("click", () => {
  if (!ws) return;
  ws.send(JSON.stringify({ type: "leave" }));
  ws.close();
  joined = false;
  $joinBtn.disabled = false;
  $leaveBtn.disabled = true;
  showOverlay("Select a world to enter");
  addEvent("leave", "You left the world");
});

// Click canvas to move
$canvas.addEventListener("click", (e) => {
  if (!joined || !ws || ws.readyState !== WebSocket.OPEN) return;
  const rect = $canvas.getBoundingClientRect();
  const scaleX = CANVAS_W / rect.width;
  const scaleY = CANVAS_H / rect.height;
  const cx = Math.floor((e.clientX - rect.left) * scaleX / TILE);
  const cy = Math.floor((e.clientY - rect.top) * scaleY / TILE);
  ws.send(JSON.stringify({ type: "action", action: "move", x: cx, y: cy }));
});

// Arrow key movement
document.addEventListener("keydown", (e) => {
  if (!joined || !ws || ws.readyState !== WebSocket.OPEN) return;
  const me = worldState.agents?.find((a) => a.agentId === myAgentId);
  if (!me) return;
  let { x, y } = me;
  if (e.key === "ArrowLeft" || e.key === "a") x = Math.max(0, x - 1);
  else if (e.key === "ArrowRight" || e.key === "d") x = Math.min(COLS - 1, x + 1);
  else if (e.key === "ArrowUp" || e.key === "w") y = Math.max(0, y - 1);
  else if (e.key === "ArrowDown" || e.key === "s") y = Math.min(ROWS - 1, y + 1);
  else return;
  e.preventDefault();
  ws.send(JSON.stringify({ type: "action", action: "move", x, y }));
});

// ── Helpers ────────────────────────────────────────────────────────────────
function setStatus(connected, text) {
  $statusDot.className = connected ? "connected" : "";
  $statusText.textContent = text;
}

function showOverlay(msg) {
  $overlayMsg.textContent = msg;
  $canvasOverlay.classList.remove("hidden");
}

function hideOverlay() {
  $canvasOverlay.classList.add("hidden");
}

// ── Init ───────────────────────────────────────────────────────────────────
setStatus(false, "not connected");
showOverlay("Select a world from the left panel");
renderWorld();
fetchWorlds();
setInterval(fetchWorlds, 15_000);
