/**
 * Vega client — dispatches agent work to LaunchDarkly's hosted AI (Vega) and
 * polls for the result.
 *
 * This is the **transport seam** for the Vega provider: `VegaClient` owns the
 * dispatch→poll loop and codes against the `VegaTransport` interface, never a
 * concrete transport. `GraphQLVegaTransport` (vegaTransport.ts) is the real
 * implementation (endpoint + auth owned by the transport); `StubVegaTransport`
 * is the no-config fallback that throws (used when VEGA_ENDPOINT/VEGA_TOKEN are
 * unset and the provider flag still selects vega).
 *
 * Shape:
 *   - dispatch(configKey, prompt, context) -> { conversationId }   (async)
 *   - getStatus(conversationId) -> { status, messages, tags }      (poll to terminal)
 */

export type VegaStatus = "pending" | "running" | "completed" | "failed" | "stopped" | "cancelled";

const TERMINAL: ReadonlySet<VegaStatus> = new Set(["completed", "failed", "stopped", "cancelled"]);

export interface VegaDispatchRequest {
  /** AI Config key for the agent/node to run (e.g. "research-planner"). */
  configKey: string;
  /** Rendered prompt (PR context already substituted). */
  prompt: string;
  /** Free-form context variables (PR number/title/body, prior step output, …). */
  context?: Record<string, unknown>;
  /** Optional cap on agent turns (from a graph edge handoff). */
  maxTurns?: number;
}

export interface VegaDispatchResult {
  conversationId: string;
}

export interface VegaStatusResult {
  conversationId: string;
  status: VegaStatus;
  /** Agent messages; the final assistant message is the node's output. */
  messages: Array<{ role: string; content: string; isFinal?: boolean }>;
  /** Tags the agent set (drive graph edge conditions: skip_if/require). */
  tags: Record<string, string>;
}

/** Transport seam — swap the stub for the real implementation when docs land. */
export interface VegaTransport {
  dispatch(req: VegaDispatchRequest): Promise<VegaDispatchResult>;
  getStatus(conversationId: string): Promise<VegaStatusResult>;
}

export interface VegaClientOptions {
  pollMillis?: number;
  timeoutMillis?: number;
}

/**
 * No-config fallback transport: throws on use. Selected when the provider flag
 * serves `vega` but VEGA_ENDPOINT/VEGA_TOKEN aren't set. The real transport is
 * `GraphQLVegaTransport` (vegaTransport.ts).
 */
export class StubVegaTransport implements VegaTransport {
  async dispatch(_req: VegaDispatchRequest): Promise<VegaDispatchResult> {
    throw new Error(
      "Vega transport not configured — set VEGA_ENDPOINT + VEGA_TOKEN, or use the default 'anthropic' provider.",
    );
  }
  async getStatus(_conversationId: string): Promise<VegaStatusResult> {
    throw new Error("Vega transport not configured — set VEGA_ENDPOINT + VEGA_TOKEN.");
  }
}

/** High-level client: dispatch a node and poll it to completion. */
export class VegaClient {
  private readonly pollMillis: number;
  private readonly timeoutMillis: number;

  constructor(
    private readonly transport: VegaTransport = new StubVegaTransport(),
    opts: VegaClientOptions = {},
  ) {
    this.pollMillis = opts.pollMillis ?? 3_000;
    this.timeoutMillis = opts.timeoutMillis ?? 30 * 60 * 1000;
  }

  /** Dispatch a single agent/node and wait for its terminal result. */
  async runNode(req: VegaDispatchRequest): Promise<VegaStatusResult> {
    const { conversationId } = await this.transport.dispatch(req);
    const deadline = Date.now() + this.timeoutMillis;
    for (;;) {
      const result = await this.transport.getStatus(conversationId);
      if (TERMINAL.has(result.status)) return result;
      if (Date.now() > deadline) {
        throw new Error(`Vega node ${req.configKey} timed out (status: ${result.status})`);
      }
      await new Promise((r) => setTimeout(r, this.pollMillis));
    }
  }
}
