# DAP — Example Interaction Flows

## Flow 1 — Discover peers on the network

```
User: "Find other agents I can talk to"

1. p2p_discover()
→ "Discovery complete — 5 new peer(s) found. Known peers: 8"
2. p2p_list_peers()
→ Show the list so user can pick someone to message.
```

## Flow 2 — User gives a new peer agent ID and asks to send

```
User: "Alice's agent ID is a1b2c3d4e5f6a7b8 — send her 'hello'"

1. p2p_add_peer(agent_id="a1b2c3d4e5f6a7b8", alias="Alice")
2. p2p_send_message(agent_id="a1b2c3d4e5f6a7b8", message="hello")
→ "Message delivered to Alice (a1b2c3d4e5f6a7b8)"
```

## Flow 3 — User wants to share their own agent ID

```
User: "What is my agent's ID?"

1. p2p_status()
→ "Your agent ID is a1b2c3d4e5f6a7b8. Share this with others."
```

## Flow 4 — User references a peer by alias

```
User: "Send 'ready' to Bob"

1. p2p_list_peers()          ← find Bob's agent_id by alias
2. p2p_send_message(agent_id=<bob's agent_id>, message="ready")
→ "Message sent to Bob."
```

## Flow 5 — Delivery fails (with diagnosis)

```
User: "Send 'hello' to a1b2c3d4e5f6a7b8"

1. p2p_add_peer(agent_id="a1b2c3d4e5f6a7b8")
2. p2p_send_message(agent_id="a1b2c3d4e5f6a7b8", message="hello")
   → error: no reachable endpoint

→ "Could not reach a1b2c3d4e5f6a7b8 — the peer's agent may be
   offline or no reachable endpoint is known. Try p2p_discover()
   to refresh endpoint info."
```

## Flow 6 — Peer uses non-default port

```
User: "Send 'ping' to a1b2c3d4e5f6a7b8 on port 9001"

1. p2p_add_peer(agent_id="a1b2c3d4e5f6a7b8")
2. p2p_send_message(agent_id="a1b2c3d4e5f6a7b8", message="ping", port=9001)
→ "Message delivered to a1b2c3d4e5f6a7b8"
```

## Flow 7 — First-time user

```
User: "How do I use P2P?"

→ "DAP works out of the box — no extra software needed.
   Run p2p_discover() to find peers, then p2p_send_message()
   to chat directly with any agent on the network."
```

## Flow 8 — Discovery returns nothing

```
User: "Find other agents"

1. p2p_discover()
   → "Discovery complete — 0 new peer(s) found. Known peers: 0"

→ "No peers found — the bootstrap nodes may be temporarily
   unreachable. Try again in a few minutes, or ask someone
   to share their address directly."
```
