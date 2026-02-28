# Reachy Mini + OpenClaw: Peer Agent Architecture

## Overview

Two independent AI agents that share context and communicate:

- **Reachy Mini** — Voice-first robot powered by OpenAI Realtime API (`gpt-realtime-1.5`). Handles face-to-face conversation with the user.
- **OpenClaw** — Text-first agent powered by `openai-codex/gpt-5.3-codex`. Handles Discord messages, link research, and browser tools.

They are peers, not master/slave. Each has its own LLM session. The reachy-mini extension bridges them.

## Data Flow

```
User speaks to Reachy: "I'm sending you a link about quantum computing"
    │
    ▼
Reachy transcript ──► WebSocket ──► reachy-mini extension
    ├─ Stored in transcriptBuffer (sliding window of 50 entries)
    └─ Forwarded to Discord #reachy-log as [You]/[Reachy] messages

User sends link in Discord #general
    │
    ▼
OpenClaw receives message via Discord channel
    │
    ├─► message_received hook fires
    │     └─ Reachy gets notification via bridge inject:
    │        "tyson sent a message on Discord. OpenClaw is processing it."
    │        (includes trimmed message content, ~1500 token cap)
    │
    ├─► before_prompt_build hook fires
    │     └─ Voice transcript context prepended to OpenClaw's prompt:
    │        "[Recent voice conversation...]
    │         User (voice): I'm sending you a link about quantum computing
    │         Reachy: Got it, I'll keep an eye out for it
    │         [End voice context]"
    │
    ├─► OpenClaw agent processes message WITH voice context
    │     └─ Knows WHY the link was sent (user mentioned it to Reachy)
    │
    ├─► llm_output hook fires (after LLM returns reply)
    │     └─ OpenClaw's research forwarded to Reachy via bridge inject:
    │        "[From OpenClaw] Here's what I found about quantum computing..."
    │        (~10K token cap)
    │
    └─► Reply delivered to Discord #general

Reachy discusses findings verbally with user
    └─ Transcript ──► #reachy-log
```

## Components

### Bridge API (Reachy side)

Lives in `reachy_mini_conversation_app`. FastAPI server on port 8100.

| Endpoint              | Purpose                                                 |
| --------------------- | ------------------------------------------------------- |
| `POST /bridge/inject` | Inject text/image into Reachy's OpenAI Realtime session |
| `GET /bridge/status`  | Check connection status                                 |
| `WS /bridge/ws`       | Stream voice transcripts (user + Reachy)                |

The `inject` endpoint accepts `response_instructions` to guide Reachy's response style for that specific injection.

### Extension (OpenClaw side)

`extensions/reachy-mini/` — OpenClaw plugin that bridges both agents.

| File                        | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `index.ts`                  | Plugin entry: hooks, commands, transcript service        |
| `src/client.ts`             | HTTP client for bridge API (`inject`, `status`, `wsUrl`) |
| `src/config.ts`             | Config resolution with defaults                          |
| `src/transcript-service.ts` | WebSocket client for transcript stream (auto-reconnect)  |
| `src/link-extractor.ts`     | URL extraction (legacy, no longer called from main flow) |

### Hooks Used

| Hook                  | Direction         | Purpose                                                  |
| --------------------- | ----------------- | -------------------------------------------------------- |
| `before_prompt_build` | Reachy → OpenClaw | Inject voice transcripts as context for OpenClaw's agent |
| `message_received`    | OpenClaw → Reachy | Notify Reachy that a Discord message arrived             |
| `llm_output`          | OpenClaw → Reachy | Forward OpenClaw's processed reply to Reachy             |

### Why `llm_output` instead of `message_sending`?

Discord same-channel replies go through a direct delivery path (`deliverDiscordReply` → `sendMessageDiscord`) that bypasses `deliverOutboundPayloads` and the `message_sending` hook entirely. The hook only fires for cross-channel routing.

`llm_output` fires after every LLM response with `assistantTexts[]` containing the full reply, regardless of delivery path.

## Config

In `~/.openclaw/openclaw.json` under `plugins.entries.reachy-mini.config`:

```json
{
  "reachyUrl": "http://localhost:8100",
  "apiSecret": "openclaw-reachy-hackathon",
  "forwardMessages": true,
  "transcriptChannels": ["discord:CHANNEL_ID"],
  "forwardAgentResponse": true,
  "notifyOnReceive": true
}
```

| Key                    | Default                 | Purpose                                             |
| ---------------------- | ----------------------- | --------------------------------------------------- |
| `reachyUrl`            | `http://localhost:8100` | Bridge API base URL                                 |
| `apiSecret`            | —                       | Shared secret (must match `REACHY_BRIDGE_SECRET`)   |
| `forwardMessages`      | `true`                  | Enable message_received notifications               |
| `notifyOnReceive`      | `true`                  | Send Reachy a heads-up when Discord messages arrive |
| `forwardAgentResponse` | `true`                  | Forward OpenClaw's LLM reply to Reachy              |
| `transcriptChannels`   | `[]`                    | Where to log transcripts (e.g. `discord:123456`)    |

## Loop Prevention

- `message_received` skips `[You]`/`[Reachy]` prefixed messages (transcript echoes)
- `llm_output` only fires for OpenClaw's own agent, not for injected Reachy responses
- Transcript forwarding to Discord log channel uses a separate channel from #general

## Observability

The #reachy-log Discord channel shows:

- `[You] ...` — User's voice transcripts
- `[Reachy] ...` — Reachy's voice responses
- `[→ Reachy] Notified: ...` — When we notify Reachy of a Discord message
- `[→ Reachy] Forwarded OpenClaw response (N chars)` — When we forward findings
- `[→ Reachy] ERROR ...` — When an injection fails
