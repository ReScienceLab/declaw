/**
 * OpenClaw channel registration for DAP P2P messaging.
 * Account IDs are agentIds.
 */
import { Identity } from "./types"
import { sendP2PMessage, SendOptions } from "./peer-client"
import { listPeers, getPeerIds, getPeer } from "./peer-db"
import { getEndpointAddress } from "./peer-db"
import { onMessage } from "./peer-server"

export const CHANNEL_CONFIG_SCHEMA = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      dmPolicy: {
        type: "string",
        enum: ["open", "pairing", "allowlist"],
        default: "pairing",
      },
      allowFrom: {
        type: "array",
        items: { type: "string" },
        description: "Agent IDs allowed to DM (dmPolicy=allowlist)",
      },
    },
  },
  uiHints: {
    dmPolicy: {
      label: "DM Policy",
      help: "open: anyone, pairing: one-time code, allowlist: specific agent IDs only",
    },
    allowFrom: {
      label: "Allow From",
      help: "Agent IDs permitted to send DMs",
    },
  },
}

export function buildChannel(identity: Identity, port: number, getSendOpts?: (id: string) => SendOptions) {
  return {
    id: "dap",
    meta: {
      id: "dap",
      label: "DAP",
      selectionLabel: "DAP (P2P)",
      docsPath: "/channels/dap",
      blurb: "Direct encrypted P2P messaging. No servers, no middlemen.",
      aliases: ["p2p", "ygg", "yggdrasil"],
    },
    capabilities: { chatTypes: ["direct"] },
    configSchema: CHANNEL_CONFIG_SCHEMA,
    config: {
      listAccountIds: (_cfg: unknown) => getPeerIds(),
      resolveAccount: (_cfg: unknown, accountId: string | undefined) => {
        const id = accountId ?? ""
        const peer = getPeer(id)
        return {
          accountId: id,
          agentId: peer?.agentId ?? id,
          alias: peer?.alias ?? id,
        }
      },
    },
    outbound: {
      deliveryMode: "direct" as const,
      sendText: async ({ text, account }: { text: string; account: { agentId?: string } }) => {
        const agentId = account.agentId ?? ""
        const peer = getPeer(agentId)
        const targetAddr = (peer ? getEndpointAddress(peer, "yggdrasil") : null) ?? agentId
        const opts = getSendOpts?.(agentId)
        const result = await sendP2PMessage(identity, targetAddr, "chat", text, port, 10_000, opts)
        if (!result.ok) {
          console.error(`[dap] Failed to send to ${agentId}: ${result.error}`)
        }
        return { ok: result.ok }
      },
    },
  }
}

export function wireInboundToGateway(api: any): void {
  onMessage((msg) => {
    if (msg.event !== "chat") return
    try {
      api.gateway?.receiveChannelMessage?.({
        channelId: "dap",
        accountId: msg.from,
        text: msg.content,
        senderId: msg.from,
      })
    } catch {
      console.log(`[dap] Message from ${msg.from}: ${msg.content}`)
    }
  })
}
