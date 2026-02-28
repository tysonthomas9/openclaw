export type ReachyMiniConfig = {
  reachyUrl: string;
  apiSecret?: string;
  forwardMessages: boolean;
  transcriptChannels: string[];
  extractLinks: boolean;
  linkMaxChars: number;
};

export function resolveConfig(raw: Record<string, unknown> | undefined): ReachyMiniConfig {
  const cfg = raw ?? {};
  return {
    reachyUrl: typeof cfg.reachyUrl === "string" ? cfg.reachyUrl.trim() : "http://localhost:8100",
    apiSecret: typeof cfg.apiSecret === "string" ? cfg.apiSecret.trim() || undefined : undefined,
    forwardMessages: cfg.forwardMessages !== false,
    transcriptChannels: Array.isArray(cfg.transcriptChannels)
      ? cfg.transcriptChannels.filter((c): c is string => typeof c === "string")
      : [],
    extractLinks: cfg.extractLinks !== false,
    linkMaxChars: typeof cfg.linkMaxChars === "number" ? cfg.linkMaxChars : 4000,
  };
}
