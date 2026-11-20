# InfraFlow on Vercel

This deployment runs the existing DEMO application. It does not connect to company infrastructure. The three components are the static Vite frontend, the Express HTTP Function, and a dedicated Vercel Daemon consuming the existing PostgreSQL queue.

## Configuration

Use Node 24 and the repository root. `vercel.json` defines the frontend build, same-origin API routing, and one 1 GiB worker instance in Singapore. A persistent external PostgreSQL database is required. Do not put the database URL or any secrets in frontend variables.

Production environment values:

- `DATABASE_URL`: a pooled PostgreSQL connection URL supplied by the dedicated database provider.
- `APP_MODE=DEMO` and `ALLOW_HOSTED_DEMO=true`: explicit permission to host the simulator.
- `APP_ORIGIN`: the exact stable HTTPS application origin, without a trailing slash.
- `SESSION_SECRET` and `WEBHOOK_SECRET`: separate randomly generated secrets of at least 32 characters.
- `INITIAL_DEMO_PASSWORD`: a unique initial password, at least 12 characters, used only by the seed subprocess. Do not define `DEMO_PASSWORD` on the deployed API or worker.
- `WORKER_POLL_MS=5000`: worker polling interval.

`npm run build:vercel` builds the application and, for a production DEMO build only, applies the repository migrations and runs the idempotent seed. Preview builds do not migrate or seed production data. The existing seed does not overwrite existing passwords or reset workflow state.

## Checks

Run `npm run test:hosted-config`, `npm run lint`, `npm run typecheck`, and a build. The existing database integration suite requires an independent `TEST_DATABASE_URL` ending in `_test` and must never be run against the hosted demo database.

After deployment, test `/healthz`, `/readyz`, login/session refresh, cross-role approval, worker progression, and evidence. A request must finish based on the existing verifier, not simply an HTTP success. Test API routing and cookies on the actual stable domain before sharing the demo.

## Limits

The application retains its RBAC, team scopes, CSRF/origin checks, production-resource deny policy, approval binding, resource locks, replay deduplication, and no automatic redispatch for uncertain outcomes. The hosted flag changes only deployment eligibility. Connected adapters remain disabled.

Vercel Daemons currently run in production deployments only. Preview deployments do not have a continuous worker. Hobby daemon quotas are finite: 5 active CPU-hours and 420 provisioned GB-hours per month at the time of configuration. One 1 GiB instance can consume the memory quota after about 17.5 days if left running continuously. Stop it after the challenge if it is no longer needed; Hobby quota exhaustion stops workers. See https://vercel.com/docs/daemons/limits for current limits.

Hosted deployment and Docker runtime checks must be reported separately from local build and unit checks. Do not claim an untested provider connection or daemon as working.
