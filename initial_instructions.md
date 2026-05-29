# Introduction

This project is an early prototype of something LaunchDarkly is building. So, while this is not the final product, it should be directionally accurate, representative of the final product, and informed by the existing plans.

It will draw on various sources, such as confluence pages, existing LaunchDarkly configs, and github repositories. It's possible that the shape of this prototype project will change based on feedback from early customers, and the upstream production plans. As such, it should be designed and built with modularity as a core principle.

# Overview

The high level goal of this prototype project, and the resulting production version, is to enable fully autonomous, safe software releases using LaunchDarkly. While LaunchDarkly is not the only mechanism needed, it is the primary production safety layer for autonomous delivery.

The large elements include:

- Phase 1: Automatic flag and metric creation in CI
- Phase 2: Automatic releases triggered in LaunchDarkly based on successful deployment signals
- Phase 3: Automatic flag and metric cleanup once they are fully released and safe to remove

Phase 3 is out of scope for this prototype, since that already exists in LaunchDarkly. Phases 1 and 2 are what we need to build. For this prototype, we do not need to make this generic to any CI/CD toolset. Focus on GitHub Actions for CI, and something lightweight (like Railway) for CD.

# Goal

This prototype will be shared with early design partners. We want the implementation to be as frictionless as possible. Even though we, the LaunchDarkly team, will be hands-on to help, we want to ensure a few key things:

1. Easy setup. Bake in automation of pipeline setup wherever possible. Make it as simple as possible, but not simpler.
2. Clear customization points.
3. Modular.

# Some details on this prototype

## Phase 1: Automatic resource creation

In this flow, developers will write code, and submit PRs. It is not expected that those developers need to consider where to implement LaunchDarkly's runtime control flags and configurations as they're writing and committing code. The flags, configurations, and metrics to measure them will be automatically created where appropriate in CI.

The automatic creation will be handled by a series of agents, executed by LaunchDarkly's AI. LaunchDarkly's AI uses a Claude model in our bedrock instance to facilitate this. The specific configuration of the agents will be defined by LaunchDarkly's AgentControl configs: [https://launchdarkly.com/docs/home/agentcontrol/create](https://launchdarkly.com/docs/home/agentcontrol/create)

And the handoff among agents will be defined and coordinated by an Agent Graph: [https://launchdarkly.com/docs/home/agentcontrol/agent-graphs](https://launchdarkly.com/docs/home/agentcontrol/agent-graphs)

The agent flow has these steps:

1. Research and Planning Agent
  - This agent is responsible for exploring the codebase, building a structured understanding of a PR, then producing a detailed implementation brief for downstream agents.
2. Implementation Agent
  - Receives the Research and Planner brief, creates resources in LaunchDarkly, and wires PR code to include flags and metrics.
3. Testing Agent
  - Receives Research and Planner brief + implementation agent output. Generates general test coverage and per-variation flag path tests.
4. Code Review Agent
  - Receives all prior agent outputs, performs independent code quality analysis, and produces an APPROVE or REJECT decision.

Those steps are subject to change. For example, we may find that it produces higher quality output to separate flagging and metric implementation. We may also expand the definitions to go beyond flagging, and include automatic instrumentation of agent configs. This is why modularity is critical.

We'll start with three human approval modes:

1. Yolo. Auto-approve everything the review agent approves, with no human in the loop.
2. Middle ground. Based on risk assessment, have humans approve high risk changes, but let lower risk changes auto-approve.
3. Manual. Humans approve everything the review agent approved.

TBD on where those approvals should happen. It should be flexible - within GitHub? Within LaunchDarkly? Within Slack? All are valid. To keep it tightly scoped, we can leave the prototype approvals in GitHub.

## Phase 2: Automatic releases

Once phase 1 is complete, eventually the PR will be merged, tested, and deployed. There could be multiple flags included in a single deploy.

In this phase, there needs to be multiple checks. Some key concepts:

- `.release-flags/pr-N.json`: A small JSON file checked into the repo alongside the code it guards. Contains the flag key, scope, and optional rollout overrides.
- Scope: Declares which deploy path(s) must complete before the flag release triggers: frontend, backend, or fullstack. (These scope definitions may not be appropriate for all environments, they're just the currently used definitions.)
- Notifier: A post-deploy Spinnaker stage that POSTs the deployed SHA range to ThumbSeeker. Runs in parallel with promotion notifications — never delays subsequent deploys.
- ThumbSeeker: Central orchestrator. Receives deploy notifications, discovers which flags are new by diffing the `.release-flags/` directory via GitHub API, routes by scope, and triggers Spinnaker pipelines.
- Fullstack check: Stateless coordination — ThumbSeeker checks whether the other service's currently-deployed SHA already contains the same .`release-flags/` file. If yes, both services have the code, so the release triggers. If no, it waits for the other pipeline's Notifier to re-evaluate.
- Release overrides: Optional fields in the `.release-flags/` file (metrics, stages, randomization unit) that override the flag's release policy for this specific rollout.

Note that ThumbSeeker is the current internal tool. The name doesn't need to remain ThumbSeeker for this public prototype.

Also note that the `.release-flags/` file pattern isn't set. It's possible this workflow would be better served by a configuration in LaunchDarkly, or another method.

There are many more details in source documentation, which is out of scope for these initial instructions. Those details include discovery, notification, scoping, and examples.

# Initial instructions

Help me formulate a plan for tackling this project. Because the prototype will be drawing from many external sources, I want to be able to pull repos, reference pages, and read existing configs stored in LaunchDarkly. We're not ready to write anything yet - just suggest the directory structure, ask clarifying questions, and push back on anything I've written in these initial instructions.

One critical note to inform your suggestions: some of the upstream resources are proprietary, and should not be shared in a public repository. However, this prototype repository will be publicly shared.

Please save the plan as a human readable HTML file with nice but basic formatting. Include whatever directory diagrams, charts, and questions you have.