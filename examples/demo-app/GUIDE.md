# Demo app

A minimal monorepo demo for the full Auto-Factory flow: a **JS frontend** and a
**Python backend**, deployed as two independent Railway services.

> **What this is:** a reference/starting point. The Phase 1 action targets *whatever
> repo installs the workflow* (`bootstrap/github-action-template/auto-factory.yml`) —
> not this in-repo copy specifically. Use it to see the shape of an app the pipeline
> works on; the live demo runs against a separate app repo wired with that template.

```
demo-app/
├── frontend/        Node/Express — GET /api/status, serves a page
├── backend/         Python/Flask — GET /api/status, GET /api/greeting (flag-gated)
└── .release-flags/  release intent checked in alongside guarded code
```

## The status contract (Phase 2)

Each service exposes `GET /api/status` → `{ "service": "...", "version": "<deployed SHA>" }`.
Beacon's fullstack check reads the **other** service's `version` to confirm both sides have
deployed the same `.release-flags/` file before releasing.

`version` comes from `RAILWAY_GIT_COMMIT_SHA` at deploy time.

## How it ties together

1. **Phase 1** — open a PR that adds a feature behind a flag; the agents create the flag
   + metrics and wire it in. (The committed example uses `new-greeting`, but agents derive
   a flag key per-PR from the change — don't expect that exact key on your own PRs.)
2. A `.release-flags/<flag-key>.json` lands (see `pr-1.json` for the shape) declaring the
   flag + scope + rollout.
3. **Phase 2** — on deploy, the Notifier pings Beacon, which discovers the new release flag and
   starts a guarded rollout via LaunchDarkly.

## Running locally

- Backend: `pip install -r backend/requirements.txt && python backend/app.py` (`:8000`)
- Frontend: `cd frontend && npm install && npm start` (`:3000`)
- Set `LD_SDK_KEY` to evaluate the flag for real; without it, flags default to `false`.

## Deploying (Railway)

Create two services from this repo (root `frontend/` and `backend/`). Railway auto-detects Node
and Python. Add a post-deploy step running the Notifier (`auto-factory-notify`) per service.
Account/service setup is environment-specific (your Railway account, service creation, and the
actual deploy) — the app code + status endpoints here are a scaffold, not a verified deploy.
