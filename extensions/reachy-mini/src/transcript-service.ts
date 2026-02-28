import type { PluginLogger } from "../../../../src/plugins/types.js";
import type { ReachyBridgeClient } from "./client.js";
import type { ReachyMiniConfig } from "./config.js";

type TranscriptMessage = {
  type: "transcript";
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

type TranscriptHandler = (msg: TranscriptMessage) => void;

/**
 * Maintains a WebSocket connection to the Reachy bridge,
 * receiving transcripts and forwarding them to configured channels.
 */
export class TranscriptService {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private handler: TranscriptHandler | null = null;

  constructor(
    private client: ReachyBridgeClient,
    private config: ReachyMiniConfig,
    private logger: PluginLogger,
  ) {}

  onTranscript(handler: TranscriptHandler): void {
    this.handler = handler;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const url = this.client.wsUrl();
    const safeUrl = url.replace(/secret=[^&]+/, "secret=***");
    this.logger.info(`[reachy-mini] Connecting to transcript stream: ${safeUrl}`);

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.logger.error(
        `[reachy-mini] WebSocket creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.logger.info("[reachy-mini] Transcript WebSocket connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        const msg = JSON.parse(data) as TranscriptMessage;
        if (msg.type === "transcript" && this.handler) {
          this.handler(msg);
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.logger.info("[reachy-mini] Transcript WebSocket closed");
      this.ws = null;
      this.scheduleReconnect();
    };

    this.ws.onerror = (event) => {
      this.logger.error(`[reachy-mini] WebSocket error: ${String(event)}`);
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }
}
