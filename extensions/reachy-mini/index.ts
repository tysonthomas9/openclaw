import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { ReachyBridgeClient } from "./src/client.js";
import { resolveConfig } from "./src/config.js";
import { extractUrls, fetchPageText } from "./src/link-extractor.js";
import { TranscriptService } from "./src/transcript-service.js";

export default function register(api: OpenClawPluginApi) {
  const config = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
  const client = new ReachyBridgeClient(config);
  const transcriptService = new TranscriptService(client, config, api.logger);

  // ── /reachy command ──────────────────────────────────────────────
  api.registerCommand({
    name: "reachy",
    description: "Interact with Reachy Mini robot (status, say, dance)",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const tokens = args.split(/\s+/).filter(Boolean);
      const action = tokens[0]?.toLowerCase() ?? "status";

      if (action === "status") {
        try {
          const s = await client.status();
          return {
            text: [
              `Reachy Mini Bridge Status`,
              `  Connected: ${s.connected ? "yes" : "no"}`,
              `  WebSocket clients: ${s.ws_clients}`,
              `  URL: ${config.reachyUrl}`,
            ].join("\n"),
          };
        } catch (err) {
          return {
            text: `Error reaching Reachy: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      if (action === "say") {
        const text = tokens.slice(1).join(" ");
        if (!text) {
          return { text: "Usage: /reachy say <message>" };
        }
        try {
          const result = await client.inject({ text: `[Message from ${ctx.channel}] ${text}` });
          return { text: result.ok ? `Sent to Reachy: "${text}"` : `Error: ${result.error}` };
        } catch (err) {
          return { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      if (action === "dance") {
        try {
          const result = await client.inject({
            text: "[Command] Please do a dance move!",
            response_instructions:
              "Use the dance tool to perform an energetic dance move. Speak your response out loud.",
          });
          return { text: result.ok ? "Told Reachy to dance!" : `Error: ${result.error}` };
        } catch (err) {
          return { text: `Error: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      return {
        text: [
          "Usage: /reachy <command>",
          "",
          "Commands:",
          "  status  — Check robot connection",
          "  say <text>  — Make Reachy speak",
          "  dance  — Make Reachy dance",
        ].join("\n"),
      };
    },
  });

  // ── message_received hook — forward messages to Reachy ──────────
  if (config.forwardMessages) {
    api.on("message_received", async (event, ctx) => {
      const content = event.content?.trim();
      if (!content) return;

      // Skip messages that look like our own transcript forwarding to avoid loops
      if (content.startsWith("[You] ") || content.startsWith("[Reachy] ")) return;

      const channelId = ctx.channelId ?? "unknown";
      const prefix = `[${channelId} from ${event.from}]`;

      // Check for URLs — two-phase injection
      const urls = config.extractLinks ? extractUrls(content) : [];

      if (urls.length > 0) {
        // Phase 1: instant ack with message text
        await client.inject({
          text: `${prefix} ${content}\n\n[Reading ${urls.length} link(s)...]`,
          response_instructions:
            "Acknowledge the message briefly. Mention you're reading the link(s). Keep it short.",
        });

        // Phase 2: fetch each URL and inject content
        for (const url of urls) {
          const pageText = await fetchPageText(url, config.linkMaxChars);
          await client.inject({
            text: `[Link content from ${url}]\n\n${pageText}`,
            response_instructions:
              "Now discuss the link content the user shared. Be conversational and speak out loud.",
          });
        }
      } else {
        // Plain text — single injection
        await client.inject({
          text: `${prefix} ${content}`,
        });
      }
    });
  }

  // ── Transcript forwarding service ──────────────────────────────
  if (config.transcriptChannels.length > 0) {
    transcriptService.onTranscript((msg) => {
      const roleLabel = msg.role === "user" ? "You" : "Reachy";
      const text = `[${roleLabel}] ${msg.content}`;

      for (const target of config.transcriptChannels) {
        const [channel, id] = target.split(":", 2);
        if (!channel || !id) continue;

        try {
          const sendFn = getSendFunction(api, channel);
          if (sendFn) {
            const recipient = channel === "discord" ? `channel:${id}` : id;
            sendFn(recipient, text).catch((err: unknown) => {
              api.logger.error(
                `[reachy-mini] Failed to send transcript to ${target}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
        } catch {
          // channel not available
        }
      }
    });

    api.registerService({
      id: "reachy-mini-transcripts",
      start: () => {
        transcriptService.start();
      },
      stop: () => {
        transcriptService.stop();
      },
    });
  }
}

function getSendFunction(
  api: OpenClawPluginApi,
  channel: string,
): ((to: string, text: string) => Promise<unknown>) | null {
  const rt = api.runtime?.channel;
  if (!rt) return null;

  switch (channel) {
    case "telegram":
      return rt.telegram?.sendMessageTelegram
        ? (to, text) => rt.telegram.sendMessageTelegram(to, text)
        : null;
    case "discord":
      return rt.discord?.sendMessageDiscord
        ? (to, text) => rt.discord.sendMessageDiscord(to, text)
        : null;
    case "whatsapp":
      return rt.whatsapp?.sendMessageWhatsApp
        ? (to, text) => rt.whatsapp.sendMessageWhatsApp(to, text)
        : null;
    case "signal":
      return rt.signal?.sendMessageSignal
        ? (to, text) => rt.signal.sendMessageSignal(to, text)
        : null;
    case "slack":
      return rt.slack?.sendMessageSlack ? (to, text) => rt.slack.sendMessageSlack(to, text) : null;
    default:
      return null;
  }
}
