const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

export function extractUrls(text: string): string[] {
  const raw = [...text.matchAll(URL_REGEX)].map((m) => m[0].replace(/[.,!?;:)'">\]]+$/, ""));
  return [...new Set(raw)];
}

function isPrivateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0")
      return true;
    if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
    if (host.startsWith("169.254.")) return true;
    const parts = host.split(".");
    if (parts[0] === "172") {
      const second = parseInt(parts[1] ?? "", 10);
      if (second >= 16 && second <= 31) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export async function fetchPageText(url: string, maxChars: number): Promise<string> {
  if (isPrivateUrl(url)) {
    return `[Skipped private/internal URL: ${url}]`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "OpenClaw-ReachyMini/1.0" },
    });
    if (!res.ok) {
      return `[Error fetching ${url}: HTTP ${res.status}]`;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/") && !contentType.includes("json")) {
      return `[Non-text content at ${url}: ${contentType}]`;
    }
    const html = await res.text();
    // Strip HTML tags for a rough text extraction
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > maxChars ? text.slice(0, maxChars) + "..." : text;
  } catch (err) {
    return `[Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}]`;
  } finally {
    clearTimeout(timeout);
  }
}
