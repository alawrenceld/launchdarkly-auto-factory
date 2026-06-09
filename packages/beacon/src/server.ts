/**
 * Beacon HTTP service. A post-deploy Notifier POSTs a deploy notification; Beacon
 * discovers newly-added release flags, routes by scope (with fullstack
 * coordination), and triggers releases via the LaunchDarkly release adapter.
 */

import { LdClient, targetConnection } from "@auto-factory/shared";
import express, { type Express, type Request, type Response } from "express";
import { type BeaconConfig, loadBeaconConfig } from "./config.js";
import { discoverNewReleaseFlags } from "./discovery.js";
import { otherSideHasFile } from "./fullstack.js";
import { GitHubClient } from "./github.js";
import { decideScope } from "./scope.js";
import { triggerRelease } from "./trigger.js";

interface FlagOutcome {
  flag: string;
  scope: string;
  action: "released" | "skipped" | "waiting" | "error";
  detail?: unknown;
}

export function createApp(cfg: BeaconConfig, ld: LdClient): Express {
  const app = express();
  app.use(express.json());
  const gh = new GitHubClient(cfg.githubToken);

  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

  app.post("/flag-releases", async (req: Request, res: Response) => {
    if (req.header("x-beacon-secret") !== cfg.secret) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const body = req.body ?? {};
    const sha: string | undefined = body.sha;
    const previousSha: string | undefined = body.previousSha ?? body.previous_sha;
    const serviceKey: string | undefined = body.service;
    const environment: string = body.environment ?? cfg.ldEnvironmentKey;

    if (!sha || !serviceKey) {
      return res.status(400).json({ error: "missing required fields: sha, service" });
    }
    const service = cfg.services[serviceKey];
    if (!service) {
      return res.status(400).json({ error: `unknown service '${serviceKey}'` });
    }

    let discovered;
    try {
      discovered = await discoverNewReleaseFlags(gh, service.repo, cfg.releaseFlagsDir, sha, previousSha);
    } catch (e) {
      return res.status(502).json({ error: "discovery failed", detail: String(e) });
    }

    const outcomes: FlagOutcome[] = [];
    for (const flag of discovered) {
      const scope = flag.scope ?? "frontend";
      const decision = decideScope(scope, service.side);

      if (decision === "skip") {
        outcomes.push({ flag: flag.flagKey, scope, action: "skipped", detail: "other side handles this scope" });
        continue;
      }
      if (decision === "check_fullstack") {
        const ready = await otherSideHasFile(cfg, gh, service.side, flag.sourceFile).catch(() => false);
        if (!ready) {
          outcomes.push({ flag: flag.flagKey, scope, action: "waiting", detail: "other service not deployed yet" });
          // No retry queue in the prototype: a "waiting" flag is released only when
          // the OTHER service's deploy notification arrives and re-evaluates. Log
          // enough to act on if that notification is lost — the manual fix is to
          // re-POST this notification (same sha/service) once both sides are deployed.
          console.warn(
            `[beacon] WAITING: flag '${flag.flagKey}' (scope=${scope}, file=${flag.sourceFile}) — ` +
              `service '${serviceKey}' deployed at ${sha} but the other side hasn't yet. ` +
              `If its notification never arrives, re-POST /flag-releases for this service once both are deployed.`,
          );
          continue;
        }
      }
      try {
        const result = await triggerRelease(ld, flag, environment);
        outcomes.push({ flag: flag.flagKey, scope, action: "released", detail: result });
      } catch (e) {
        outcomes.push({ flag: flag.flagKey, scope, action: "error", detail: String(e) });
      }
    }

    return res.json({ service: serviceKey, environment, discovered: discovered.length, outcomes });
  });

  return app;
}

/** Entry point when run directly (e.g. on Railway). */
function main(): void {
  const cfg = loadBeaconConfig();
  const ld = new LdClient(targetConnection());
  const app = createApp(cfg, ld);
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, () => console.log(`Beacon listening on :${port}`));
}

// Run when this module is the entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
