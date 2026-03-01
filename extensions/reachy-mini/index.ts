import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { ReachyBridgeClient } from "./src/client.js";
import { resolveConfig } from "./src/config.js";
import { TranscriptService } from "./src/transcript-service.js";

type TranscriptEntry = { role: string; content: string; timestamp: number };

const MAX_TRANSCRIPT_ENTRIES = 50;

export default function register(api: OpenClawPluginApi) {
  const config = resolveConfig(api.pluginConfig as Record<string, unknown> | undefined);
  const client = new ReachyBridgeClient(config);
  const transcriptService = new TranscriptService(client, config, api.logger);

  // ── Sliding window of Reachy voice transcripts ─────────────────
  const transcriptBuffer: TranscriptEntry[] = [];

  // ── Helper: log a message to the Reachy Discord log channel ─────
  function logToDiscord(text: string) {
    for (const target of config.transcriptChannels) {
      const [channel, id] = target.split(":", 2);
      if (!channel || !id) continue;
      try {
        const sendFn = getSendFunction(api, channel);
        if (sendFn) {
          const recipient = channel === "discord" ? `channel:${id}` : id;
          sendFn(recipient, text).catch((err: unknown) => {
            api.logger.error(
              `[reachy-mini] Failed to log to ${target}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      } catch {
        // channel not available
      }
    }
  }

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

  // ── before_prompt_build — inject voice context into OpenClaw's agent ──
  api.on("before_prompt_build", async () => {
    if (transcriptBuffer.length === 0) return;

    const lines = transcriptBuffer.map((t) => {
      const role = t.role === "user" ? "User (voice)" : "Reachy";
      return `${role}: ${t.content}`;
    });

    return {
      prependContext:
        "[Recent voice conversation between user and Reachy Mini robot]\n" +
        lines.join("\n") +
        "\n[End voice context]",
    };
  });

  // ── message_received — notify Reachy that a message arrived ────
  if (config.forwardMessages && config.notifyOnReceive) {
    api.on("message_received", async (event) => {
      const content = event.content?.trim();
      if (!content) return;

      // Skip transcript echoes to avoid loops
      if (content.startsWith("[You] ") || content.startsWith("[Reachy] ")) return;

      const from = event.from ?? "someone";
      // ~1500 tokens ≈ 6000 chars
      const trimmed = content.length > 6000 ? content.slice(0, 6000) + "… [trimmed]" : content;

      try {
        await client.inject({
          text: `[Notification] ${from} sent a message on Discord. OpenClaw is processing it.\n\nMessage: ${trimmed}`,
          response_instructions:
            "A message just came in on Discord. Briefly acknowledge it and mention OpenClaw is looking into it. " +
            "You can reference what the message is about but keep it to one short sentence.",
        });
        logToDiscord(`[→ Reachy] Notified: ${from} sent a message (${content.length} chars)`);
      } catch (err) {
        api.logger.error(
          `[reachy-mini] Failed to notify Reachy: ${err instanceof Error ? err.message : String(err)}`,
        );
        logToDiscord(
          `[→ Reachy] ERROR notifying: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  // ── llm_output — forward OpenClaw's agent reply to Reachy ────
  if (config.forwardAgentResponse) {
    api.on("llm_output", async (event) => {
      const text = event.assistantTexts?.join("\n")?.trim();
      if (!text) return;

      // ~10K tokens ≈ 40000 chars
      const trimmed = text.length > 40000 ? text.slice(0, 40000) + "… [trimmed]" : text;

      try {
        await client.inject({
          text: `[From OpenClaw]\n\n${trimmed}`,
          response_instructions:
            "OpenClaw (your AI partner) just finished researching something from Discord. " +
            "Discuss the findings naturally with the user in a conversational voice. " +
            "You can summarize, highlight interesting parts, or ask follow-up questions. " +
            "Speak in 2-3 sentences max.",
        });
        logToDiscord(`[→ Reachy] Forwarded OpenClaw response (${text.length} chars)`);
      } catch (err) {
        api.logger.error(
          `[reachy-mini] Failed to forward agent response to Reachy: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        logToDiscord(
          `[→ Reachy] ERROR forwarding: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  // ── Task reception — Reachy asks OpenClaw to do something ─────
  transcriptService.onTask(async (msg) => {
    const task = msg.task?.trim();
    if (!task) return;

    api.logger.info(`[reachy-mini] Received task from Reachy: ${task.slice(0, 100)}`);
    logToDiscord(`[← Reachy] Task: ${task.slice(0, 200)}`);

    // Approach 1: Discord webhook (preferred — posts as a different user so the bot processes it)
    if (config.taskWebhookUrl) {
      try {
        const resp = await fetch(config.taskWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `[Task from Reachy] ${task}`,
            username: "Reachy Mini",
          }),
        });
        if (!resp.ok) {
          api.logger.error(`[reachy-mini] Webhook POST failed: ${resp.status} ${resp.statusText}`);
          logToDiscord(`[← Reachy] ERROR posting task via webhook: ${resp.status}`);
        }
      } catch (err) {
        api.logger.error(
          `[reachy-mini] Webhook POST error: ${err instanceof Error ? err.message : String(err)}`,
        );
        logToDiscord(
          `[← Reachy] ERROR posting task: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    // Approach 2: sendMessageDiscord fallback (note: bot may ignore its own messages)
    if (config.taskChannelId) {
      const sendFn = getSendFunction(api, "discord");
      if (sendFn) {
        try {
          await sendFn(`channel:${config.taskChannelId}`, `[Task from Reachy] ${task}`);
        } catch (err) {
          api.logger.error(
            `[reachy-mini] Failed to send task to Discord: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
    }

    api.logger.warn(
      "[reachy-mini] Received task but no taskWebhookUrl or taskChannelId configured",
    );
  });

  // ── Transcript forwarding service ──────────────────────────────
  if (config.transcriptChannels.length > 0) {
    transcriptService.onTranscript((msg) => {
      // Buffer transcripts for OpenClaw's agent context
      transcriptBuffer.push({ role: msg.role, content: msg.content, timestamp: msg.timestamp });
      if (transcriptBuffer.length > MAX_TRANSCRIPT_ENTRIES) transcriptBuffer.shift();

      // Forward to configured Discord log channel
      const roleLabel = msg.role === "user" ? "You" : "Reachy";
      logToDiscord(`[${roleLabel}] ${msg.content}`);
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
