export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ObjectData = { [key: string]: Json };

export class PenpotError extends Error {
  constructor(public readonly code: string, message: string, public readonly outcome = "not_applied", public details?: ObjectData) {
    super(message);
    this.name = "PenpotError";
  }
}

export interface ClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

// Omit pointer-map and objects-map so the backend returns complete JSON data.
// These are data-format capabilities, not a claim of full editor parity.
export const FEATURES = [
  "fdata/shape-data-type", "fdata/path-data", "components/v2", "styles/v2",
  "layout/grid", "plugins/runtime", "tokens/numeric-input", "design-tokens/v1",
  "text-editor/v2-html-paste", "text-editor/v2", "text-editor-wasm/v1",
  "render-wasm/v1", "variants/v1",
];

export class PenpotClient {
  readonly url: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions) {
    this.url = new URL(options.url);
    if (!["http:", "https:"].includes(this.url.protocol) || this.url.username || this.url.password ||
        this.url.search || this.url.hash) {
      throw new Error("PENPOT_URL must be an HTTP(S) instance URL without credentials, query, or fragment.");
    }
    this.url.pathname = this.url.pathname.replace(/\/$/, "") + "/";
    if (!options.token.trim() || /[\r\n]/.test(options.token)) throw new Error("PENPOT_ACCESS_TOKEN is required.");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetcher = options.fetch ?? fetch;
  }

  async rpc<T = Json>(command: string, params: ObjectData = {}, write = false): Promise<T> {
    if (!/^[a-z][a-z0-9-]+$/.test(command)) throw new Error("Invalid RPC command.");
    let response: Response;
    let body: string;
    try {
      response = await this.fetcher(new URL(`api/rpc/command/${command}`, this.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Token ${this.token}` },
        body: JSON.stringify(params),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Bound both streaming and Content-Length responses. Keep large files out of MCP output.
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > 64 * 1024 * 1024) throw new Error("Response exceeds 64 MiB.");
          chunks.push(chunk);
        }
      }
      body = Buffer.concat(chunks).toString("utf8");
    } catch {
      throw new PenpotError("transport_error",
        `Penpot request failed or timed out: ${command}. ${write ? "The write outcome is unknown. Read the file before any retry." : "Check the instance URL and connection."}`,
        write ? "unknown" : "not_applied");
    }
    let data: unknown;
    try { data = body ? JSON.parse(body) : null; }
    catch {
      throw new PenpotError("invalid_response", `Penpot returned non-JSON data (HTTP ${response.status}). Check the instance URL.`, write ? "unknown" : "not_applied");
    }
    if (!response.ok) {
      const error = data as Record<string, unknown> | null;
      const code = (typeof error?.code === "string" ? error.code : `http_${response.status}`).split(this.token).join("[REDACTED]").slice(0, 200);
      const hint = typeof error?.hint === "string" ? error.hint : "Check permissions, parameters, and Penpot version.";
      // Do not return backend explain/trace fields: they can contain request secrets and file data.
      const safeHint = hint.split(this.token).join("[REDACTED]").slice(0, 1000);
      throw new PenpotError(code, `Penpot ${command} failed (HTTP ${response.status}): ${safeHint}`,
        write && response.status >= 500 ? "unknown" : "not_applied");
    }
    return data as T;
  }
}

export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): ClientOptions {
  if (!env.PENPOT_URL) throw new Error("Set PENPOT_URL to your Penpot instance URL.");
  if (!env.PENPOT_ACCESS_TOKEN) throw new Error("Set PENPOT_ACCESS_TOKEN to a personal access token (not an MCP key).");
  const timeoutMs = Number(env.PENPOT_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new Error("PENPOT_TIMEOUT_MS must be an integer from 100 to 300000.");
  }
  return { url: env.PENPOT_URL, token: env.PENPOT_ACCESS_TOKEN, timeoutMs };
}
