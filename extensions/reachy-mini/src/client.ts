import type { ReachyMiniConfig } from "./config.js";

export type InjectOptions = {
  text?: string;
  image_b64?: string;
  response_instructions?: string;
};

export type BridgeStatus = {
  connected: boolean;
  ws_clients: number;
};

export class ReachyBridgeClient {
  private baseUrl: string;
  private secret?: string;

  constructor(config: ReachyMiniConfig) {
    this.baseUrl = config.reachyUrl.replace(/\/+$/, "");
    this.secret = config.apiSecret;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.secret) {
      h["x-bridge-secret"] = this.secret;
    }
    return h;
  }

  async inject(opts: InjectOptions): Promise<{ ok: boolean; status?: string; error?: string }> {
    const res = await fetch(`${this.baseUrl}/bridge/inject`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(opts),
    });
    return (await res.json()) as { ok: boolean; status?: string; error?: string };
  }

  async status(): Promise<BridgeStatus> {
    const res = await fetch(`${this.baseUrl}/bridge/status`, {
      headers: this.headers(),
    });
    return (await res.json()) as BridgeStatus;
  }

  wsUrl(): string {
    const url = this.baseUrl.replace(/^http/, "ws");
    const params = this.secret ? `?secret=${encodeURIComponent(this.secret)}` : "";
    return `${url}/bridge/ws${params}`;
  }
}
