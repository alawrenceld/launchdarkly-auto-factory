/**
 * Vega client — dispatches agent work to LaunchDarkly's hosted AI (Vega) and
 * polls for the result.
 *
 * ⚠️  PLACEHOLDER. The real public Vega dispatch endpoint, auth model, and
 * payload/response shapes are pending from the LaunchDarkly team. This module
 * defines the STABLE INTERFACE the Phase 1 GitHub Action codes against, plus a
 * stub transport that throws until wired. When the real API docs arrive, only
 * `VegaTransport` implementations change — callers (the graph walker) do not.
 *
 * Expected shape (from the reference, to be confirmed):
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
  /** Vega API base URL (PLACEHOLDER — from env once known). */
  endpoint?: string;
  /** Auth token/credential (PLACEHOLDER — shape TBD). */
  auth?: string;
  pollMillis?: number;
  timeoutMillis?: number;
}

/**
 * Stub transport: throws on use. Replace with the real HTTP/GraphQL transport
 * once the Vega API is documented. Kept so the rest of Phase 1 can be built and
 * unit-tested against the interface today.
 */
export class StubVegaTransport implements VegaTransport {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async dispatch(_req: VegaDispatchRequest): Promise<VegaDispatchResult> {
    throw new Error(
      "Vega transport not wired yet — awaiting real API docs. " +
        "Implement VegaTransport and inject it into VegaClient.",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getStatus(_conversationId: string): Promise<VegaStatusResult> {
    throw new Error("Vega transport not wired yet — awaiting real API docs.");
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
