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

### Bidirectional Tasks (Reachy → OpenClaw)

Reachy can delegate tasks to OpenClaw using the `ask_openclaw` tool. The flow:

```
User says to Reachy: "Can you look up the latest robotics news?"
    │
    ▼
Reachy LLM calls ask_openclaw tool
    │
    ▼
Tool broadcasts {"type": "task", "task": "..."} over bridge WebSocket
    │
    ▼
TranscriptService (OpenClaw extension) receives task message
    │
    ▼
Posts to Discord via webhook as "Reachy Mini" user
    │
    ▼
OpenClaw bot picks up the webhook message and processes it
    │
    ├─► Agent runs with voice context (before_prompt_build)
    ├─► llm_output hook forwards result back to Reachy
    └─► Reply delivered to Discord
```

**Why a webhook?** Discord bots ignore their own messages. The webhook posts as a different user ("Reachy Mini"), so OpenClaw's bot sees it as an inbound message. Requires `allowBots: true` in Discord channel config since webhook authors have `bot: true`.

**Reachy side:**

- `tools/ask_openclaw.py` — Python tool that broadcasts task over bridge WebSocket
- `bridge_state` injected via `ToolDependencies` dataclass
- System prompt tells Reachy when to use the tool (web research, link analysis, Discord messaging)

**OpenClaw side:**

- `TranscriptService.onTask()` handles `type: "task"` WebSocket messages
- Posts task to Discord via configured webhook URL
- OpenClaw processes as normal message; result flows back via existing `llm_output` → bridge inject path

## Config

In `~/.openclaw/openclaw.json` under `plugins.entries.reachy-mini.config`:

```json
{
  "reachyUrl": "http://localhost:8100",
  "apiSecret": "openclaw-reachy-hackathon",
  "forwardMessages": true,
  "transcriptChannels": ["discord:CHANNEL_ID"],
  "forwardAgentResponse": true,
  "notifyOnReceive": true,
  "taskWebhookUrl": "https://discord.com/api/webhooks/..."
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
| `taskWebhookUrl`       | —                       | Discord webhook URL for Reachy → OpenClaw tasks     |
| `taskChannelId`        | —                       | Fallback: Discord channel ID for task posting       |

### Discord Config

`allowBots` must be enabled in `~/.openclaw/openclaw.json` for OpenClaw to process webhook messages:

```json
{
  "channels": {
    "discord": {
      "allowBots": true
    }
  }
}
```

### Discord Webhook Setup

1. Open Discord server → **Server Settings → Integrations → Webhooks → New Webhook**
2. Set channel to the one OpenClaw monitors (e.g. #general)
3. Name it "Reachy Mini"
4. Copy the webhook URL and set it as `taskWebhookUrl` in plugin config

## Loop Prevention

- `message_received` skips `[You]`/`[Reachy]` prefixed messages (transcript echoes)
- `llm_output` only fires for OpenClaw's own agent, not for injected Reachy responses
- Transcript forwarding to Discord log channel uses a separate channel from #general

## Running the System

### Prerequisites

- macOS: Grant **Microphone** permission to Terminal/iTerm in **System Settings > Privacy & Security > Microphone**
- Node 22+, pnpm installed
- Python 3.11+ with the reachy conversation app venv set up

### 1. Start OpenClaw Gateway

From the `openclaw` repo root:

```bash
pnpm openclaw gateway run --force
```

This starts:

- OpenClaw gateway with Discord bot (@ReachyClaw)
- reachy-mini plugin (connects to Bridge API WebSocket)
- Browser control on `http://127.0.0.1:18791/`

### 2. Start Reachy Conversation App

From the `reachy_mini_conversation_app` repo:

```bash
cd reachy_mini_conversation_app
source .venv/bin/activate
reachy-mini-conversation-app --no-camera
```

Options:

- `--no-camera` — Skip camera (avoids macOS camera permission issues)
- `--gradio` — Launch Gradio web UI on port 7860 (requires `OPENAI_API_KEY` env var)
- `--debug` — Enable verbose logging

This starts:

- OpenAI Realtime voice session (API key downloaded from HuggingFace)
- Bridge API on `http://localhost:8100`
- Audio input/output via SoundDevice (auto-selects "Reachy Mini Audio" device)

### 3. Verify Connection

Once both are running, you should see in OpenClaw logs:

```
[reachy-mini] Transcript WebSocket connected
```

And in Reachy logs:

```
Bridge WS client connected (1 total)
```

### Quick Restart (both)

```bash
# Terminal 1 — OpenClaw
pnpm openclaw gateway run --force

# Terminal 2 — Reachy
cd reachy_mini_conversation_app && source .venv/bin/activate && reachy-mini-conversation-app --no-camera
```

### Environment (.env)

The Reachy app uses `reachy_mini_conversation_app/.env`:

```
MODEL_NAME=gpt-realtime-1.5
HF_HOME=./cache
REACHY_BRIDGE_SECRET=openclaw-reachy-hackathon
```

The API key is auto-downloaded from HuggingFace. Only set `OPENAI_API_KEY` if using `--gradio` mode or if the HuggingFace download is unavailable.

## Observability

The #reachy-log Discord channel shows:

- `[You] ...` — User's voice transcripts
- `[Reachy] ...` — Reachy's voice responses
- `[→ Reachy] Notified: ...` — When we notify Reachy of a Discord message
- `[→ Reachy] Forwarded OpenClaw response (N chars)` — When we forward findings
- `[← Reachy] Task: ...` — When Reachy delegates a task to OpenClaw
- `[→ Reachy] ERROR ...` — When an injection fails
