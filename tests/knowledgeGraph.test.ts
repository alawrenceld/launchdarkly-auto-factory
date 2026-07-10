import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SandboxToolExecutor,
  blastRadius,
  buildSandboxTools,
  codeRefEdges,
  composeGraph,
  deriveServiceEdges,
  neighbors,
  parseCodeRefsCsv,
  serviceForFile,
  serviceForHost,
  type GraphService,
  type SpanRecord,
} from "@auto-factory/shared";

/** ToggleMart-shaped registry: five services, one repo, dir-mapped. */
const SERVICES: GraphService[] = [
  { key: "togglemart-frontend", side: "frontend", dir: "frontend", hosts: ["frontend"] },
  { key: "togglemart-gateway", side: "backend", dir: "gateway", hosts: ["gateway"] },
  { key: "togglemart-catalog", side: "backend", dir: "catalog", hosts: ["catalog"] },
  { key: "togglemart-orders", side: "backend", dir: "orders", hosts: ["orders"] },
  { key: "togglemart-users", side: "backend", dir: "users", hosts: ["users"] },
];

const clientSpan = (from: string, host: string): SpanRecord => ({
  serviceName: from,
  spanKind: "Client",
  traceAttributes: { server: { address: host } },
});

const SPANS: SpanRecord[] = [
  // gateway fans out to the three backends (multiple observations → weight)
  clientSpan("togglemart-gateway", "catalog"),
  clientSpan("togglemart-gateway", "catalog"),
  clientSpan("togglemart-gateway", "orders"),
  clientSpan("togglemart-gateway", "users"),
  // orders calls catalog + users directly
  clientSpan("togglemart-orders", "catalog"),
  clientSpan("togglemart-orders", "users"),
  // noise that must be dropped: external host, non-client span, unknown caller
  clientSpan("togglemart-gateway", "events.launchdarkly.com"),
  { serviceName: "togglemart-catalog", spanKind: "Server", traceAttributes: { server: { address: "gateway" } } },
  clientSpan("someone-elses-service", "catalog"),
];

const CSV = [
  "flagKey,projKey,path,startingLineNumber,lines,aliases",
  "enable-storefront-cache,app,gateway/src/storefront.ts,5,3,CACHE_FLAG",
  "enable-storefront-cache,app,gateway/src/storefront.ts,38,1,",
  "enable-promo-codes,app,orders/promo.py,9,2,_FLAG_KEY",
  'enable-address-validation,app,"users/src/app.ts",17,1,VALIDATION_FLAG',
].join("\n");

describe("knowledge graph: sources", () => {
  it("derives weighted service_calls edges from client spans only", () => {
    const edges = deriveServiceEdges(SPANS, SERVICES);
    const byPair = new Map(edges.map((e) => [`${e.src}>${e.dst}`, e]));
    assert.equal(edges.length, 5);
    assert.equal(byPair.get("service:togglemart-gateway>service:togglemart-catalog")?.weight, 2);
    assert.ok(byPair.get("service:togglemart-orders>service:togglemart-users"));
    // external targets, server spans, and unknown callers are dropped
    assert.ok(![...byPair.keys()].some((k) => k.includes("launchdarkly") || k.includes("someone")));
    for (const e of edges) assert.equal(e.provenance, "traces");
  });

  it("resolves hosts by declared host, then key convention", () => {
    assert.equal(serviceForHost(SERVICES, "catalog")?.key, "togglemart-catalog");
    assert.equal(serviceForHost(SERVICES, "togglemart-users")?.key, "togglemart-users");
    assert.equal(serviceForHost(SERVICES, "api.github.com"), undefined);
  });

  it("parses find-code-refs CSV header-driven and merges per (flag,file)", () => {
    const rows = parseCodeRefsCsv(CSV);
    assert.equal(rows.length, 4);
    const edges = codeRefEdges(rows);
    assert.equal(edges.length, 3); // storefront's two rows merge into one edge
    const storefront = edges.find((e) => e.src === "flag:enable-storefront-cache");
    assert.equal(storefront?.dst, "file:gateway/src/storefront.ts");
    assert.equal(storefront?.evidence, "gateway/src/storefront.ts:5,38");
    assert.equal(storefront?.weight, 2);
  });

  it("tolerates unknown CSV shapes by returning no rows", () => {
    assert.deepEqual(parseCodeRefsCsv("a,b,c\n1,2,3"), []);
    assert.deepEqual(parseCodeRefsCsv(""), []);
  });

  it("maps files to services by longest dir match", () => {
    assert.equal(serviceForFile(SERVICES, "gateway/src/app.ts")?.key, "togglemart-gateway");
    assert.equal(serviceForFile(SERVICES, "/orders/promo.py")?.key, "togglemart-orders");
    assert.equal(serviceForFile(SERVICES, "docker-compose.yml"), undefined);
  });
});

describe("knowledge graph: compose + query", () => {
  const graph = composeGraph({ services: SERVICES, spans: SPANS, codeRefs: parseCodeRefsCsv(CSV), sha: "abc123" });

  it("composes nodes for services, flags, and referenced files with service attribution", () => {
    const file = graph.nodes.find((n) => n.id === "file:orders/promo.py");
    assert.equal(file?.kind, "file");
    assert.equal(file?.service, "togglemart-orders");
    assert.ok(graph.nodes.find((n) => n.id === "flag:enable-promo-codes"));
    assert.equal(graph.sha, "abc123");
  });

  it("reports telemetry gaps for silent services instead of staying quiet", () => {
    // frontend, catalog, users emit no client spans in the fixture
    assert.ok(graph.gaps.some((g) => g.includes("togglemart-frontend")));
    const empty = composeGraph({ services: SERVICES });
    assert.ok(empty.gaps.some((g) => g.startsWith("traces: no span data")));
    assert.ok(empty.gaps.some((g) => g.startsWith("code_refs: no rows")));
  });

  it("answers dependents/dependencies with depth and evidence", () => {
    const deps = neighbors(graph, "service:togglemart-catalog", "dependents", 3);
    const services = deps.filter((h) => h.kind === "service").map((h) => h.id);
    assert.ok(services.includes("service:togglemart-gateway"));
    assert.ok(services.includes("service:togglemart-orders"));
  });

  it("blastRadius: a catalog change reaches its callers and surfaces wrapped flags", () => {
    const radius = blastRadius(graph, ["catalog/handlers.go", "catalog/repository.go"]);
    assert.deepEqual(radius.changedServices, ["togglemart-catalog"]);
    const dependents = radius.dependentServices.map((d) => d.service).sort();
    assert.deepEqual(dependents, ["togglemart-gateway", "togglemart-orders"]);
    assert.equal(radius.flagsOnChangedCode.length, 0); // no refs in catalog fixture
    assert.ok(radius.gaps.length > 0);
  });

  it("query_dependencies tool: offered only with queryGraph, answers blast radius and node walks", async () => {
    const withGraph = buildSandboxTools({ createFlag: false, createMetric: false, editFiles: false, queryGraph: true });
    assert.ok(withGraph.some((t) => t.name === "query_dependencies"));
    const without = buildSandboxTools({ createFlag: false, createMetric: false, editFiles: false });
    assert.ok(!without.some((t) => t.name === "query_dependencies"));

    const executor = new SandboxToolExecutor(process.cwd());
    // no graph provided → honest error, not a fabricated answer
    const missing = await executor.execute("query_dependencies", {});
    assert.equal(missing.isError, true);
    assert.match(missing.content, /unavailable/);

    executor.provideKnowledgeGraph(graph, ["catalog/handlers.go"]);
    const radius = JSON.parse((await executor.execute("query_dependencies", {})).content);
    assert.deepEqual(radius.changedServices, ["togglemart-catalog"]);

    const walked = JSON.parse(
      (await executor.execute("query_dependencies", { node: "togglemart-catalog", direction: "dependents" })).content,
    );
    assert.equal(walked.node, "service:togglemart-catalog");
    assert.ok(walked.hits.some((h: { id: string }) => h.id === "service:togglemart-gateway"));

    const unknown = await executor.execute("query_dependencies", { node: "nope" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content, /Known services/);
  });

  it("blastRadius: a gateway change lists upstream targets and the wrapping flag", () => {
    const radius = blastRadius(graph, ["gateway/src/storefront.ts", "README.md"]);
    assert.deepEqual(radius.changedServices, ["togglemart-gateway"]);
    assert.deepEqual(radius.unmappedFiles, ["README.md"]);
    assert.deepEqual(
      radius.upstreamServices.map((u) => u.service).sort(),
      ["togglemart-catalog", "togglemart-orders", "togglemart-users"],
    );
    assert.deepEqual(radius.flagsOnChangedCode.map((f) => f.flag), ["enable-storefront-cache"]);
  });
});
