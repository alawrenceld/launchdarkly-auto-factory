/**
 * Railway webhook adapter — translates Railway's deploy webhook payload into
 * the generic deploy notification Beacon acts on.
 *
 * Design: Beacon's front door is the provider-agnostic `/flag-releases`
 * contract; provider adapters like this one are thin translators in front of
 * the same handler, so supporting another CD system means another ~50-line
 * parser, not a Beacon change.
 *
 * Railway payload notes:
 *  - Railway has shipped several webhook generations; this parser accepts the
 *    CURRENT layout (captured live 2026-06-11: `type: "Deployment.deployed"`,
 *    `details.status`/`details.commitHash`, `resource.service.name`,
 *    `resource.environment.name`) plus the two older field layouts (top-level
 *    `status` + `service.name` + `deployment.meta.*`, and variants nesting
 *    status/meta differently). Anything else is reported as `unrecognized`
 *    with the payload logged, never thrown.
 *  - Only a SUCCESSful deploy event triggers releases; other statuses
 *    (BUILDING, DEPLOYING, FAILED, REMOVED…) are acknowledged and ignored.
 *  - The Railway service name must match a key in `config/services.yaml`.
 */

export type RailwayParseResult =
  | { kind: "deploy_success"; service: string; sha: string; railwayEnvironment?: string }
  | { kind: "ignored"; reason: string }
  | { kind: "unrecognized"; reason: string };

/** Dig a string out of `obj` at the first dotted path that holds one. */
function firstString(obj: Record<string, unknown>, paths: string[]): string | undefined {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const part of path.split(".")) {
      cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[part] : undefined;
    }
    if (typeof cur === "string" && cur) return cur;
  }
  return undefined;
}

export function parseRailwayWebhook(body: unknown): RailwayParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { kind: "unrecognized", reason: "payload is not a JSON object" };
  }
  const obj = body as Record<string, unknown>;

  const status = firstString(obj, ["status", "details.status", "deployment.status", "deploymentStatus"]);
  if (!status) {
    return { kind: "unrecognized", reason: `no status field (top-level keys: ${Object.keys(obj).join(", ")})` };
  }
  // The GraphQL API reports SUCCESS; the webhook event picker says Deployed /
  // Redeployed — accept all three spellings of "this deploy is live".
  const SUCCESS_STATUSES = new Set(["SUCCESS", "DEPLOYED", "REDEPLOYED"]);
  if (!SUCCESS_STATUSES.has(status.toUpperCase())) {
    return { kind: "ignored", reason: `deploy status ${status} (only a successful deploy triggers releases)` };
  }

  const service = firstString(obj, ["service.name", "resource.service.name", "deployment.meta.serviceName", "serviceName"]);
  const sha = firstString(obj, [
    "details.commitHash",
    "deployment.meta.commitHash",
    "deployment.meta.commitSha",
    "meta.commitHash",
    "commitHash",
  ]);
  if (!service || !sha) {
    return {
      kind: "unrecognized",
      reason: `SUCCESS event but missing ${!service ? "service name" : "commit SHA"} (top-level keys: ${Object.keys(obj).join(", ")})`,
    };
  }

  const railwayEnvironment = firstString(obj, ["environment.name", "resource.environment.name", "environmentName"]);
  return { kind: "deploy_success", service, sha, ...(railwayEnvironment ? { railwayEnvironment } : {}) };
}
