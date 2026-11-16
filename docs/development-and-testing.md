# Development and Testing

This document covers local development, the Docker run in detail,
troubleshooting, the tests and their results. For the quick start, see the
[README](../README.md).

## Prerequisites

- **Node.js `^22.18.0 || ^24.0.0 || >=26.0.0`** (`engines` in `package.json`).
  This is the intersection of the tools' requirements: Vitest 5
  (`^22.12 || ^24 || >=26`), ESLint 9 (`^20.19 || ^22.13 || >=24`), Next.js 16
  (`>=20.9`), and the `.mts` scripts run directly by Node, which need native
  TypeScript type stripping (on by default from 22.18). Developed with
  Node.js 24.14.0.
- npm (developed with npm 11.9.0).
- Docker Desktop with Linux containers (for the local database).
- Git.

## Local Development (Windows PowerShell)

Next.js and the worker run directly on Windows; only MongoDB runs in Docker
(`compose.dev.yaml`, wrapped by `npm run db:up` / `db:stop`). PowerShell may
block `npm.ps1` and `npx.ps1`, so use `npm.cmd` and `npx.cmd` as below.

### First Run

```powershell
npm.cmd ci                        # install; postinstall runs `prisma generate`
Copy-Item .env.example .env       # DATABASE_URL and TEST_DATABASE_URL (git-ignored)
# Put a random secret into UPLOAD_SIGNING_SECRET in .env, for example:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npm.cmd run db:up                 # start MongoDB, wait until it is PRIMARY
npm.cmd run db:push               # apply the schema (indexes) to the dev database
npm.cmd run dev                   # http://localhost:3000
npm.cmd run worker:claims         # in a second terminal: claim-expiry worker
```

### Later Runs

```powershell
npm.cmd run db:up
npm.cmd run dev
npm.cmd run worker:claims         # second terminal; Ctrl+C stops it gracefully
```

After changing `prisma/schema.prisma`, run `npm.cmd run db:push` (dev) and
`npm.cmd run db:push:test` (tests; also run automatically by
`test:integration`).

### Worker Options

```powershell
npm.cmd run worker:claims                 # loop; Ctrl+C stops after the current sweep
npm.cmd run worker:claims -- --once       # one sweep, then exit
$env:CLAIM_SWEEP_INTERVAL_MS = "2000"; npm.cmd run worker:claims   # default 5000 ms
```

On Windows, Ctrl+C delivers SIGINT; `taskkill /F` cannot be handled
gracefully.

### Stopping the Database (Keeps Data)

```powershell
npm.cmd run db:stop               # docker compose -f compose.dev.yaml stop mongodb
```

`docker compose -f compose.dev.yaml down` (without `-v`) also keeps the data:
it removes the container and network but not the named volumes.

> **Warning:** `docker compose -f compose.dev.yaml down -v` or
> `docker volume rm sign-flow_mongodb_data` **permanently deletes all local
> development data.**

## Full Docker Run: Details

The quick start is in the [README](../README.md#run-with-docker).

| Task | Command |
| --- | --- |
| Status | `docker compose ps` |
| Logs (all / one service) | `docker compose logs -f` / `docker compose logs -f app` (or `worker`, `mongodb`, `schema`) |
| Stop, **keeping data** | `docker compose stop` |
| Start again | `docker compose up -d --wait` |
| Restart app and worker | `docker compose restart app worker` |
| Rebuild after code changes | `docker compose up -d --build --wait` |
| Remove containers and network, **keeping data** | `docker compose down` |

> **Warning:** `docker compose down -v` deletes the volumes of this project
> (`signflow_mongodb_data`, `signflow_mongodb_config`) and with them **all
> data** of the Docker run. It does not touch the development database.

### Services

`docker-compose.yml`, Compose project `signflow`:

| Service | Image target | Role |
| --- | --- | --- |
| `mongodb` | `mongo:8.0.38` | single-node replica set `rs0`, member `mongodb:27017`; **no published port** |
| `schema` | `schema` | one-shot `prisma db push` (indexes), then exits 0 |
| `app` | `app` | Next.js standalone server, published on `127.0.0.1:${APP_PORT:-3080}` |
| `worker` | `worker` | claim-expiry worker |

Start-up order uses real readiness, no sleeps: `mongodb` is healthy only when
its replica set is initiated and PRIMARY, then `schema` must exit
successfully, then `app` and `worker` start. `app` is healthy when
`GET /api/orders` answers (which also proves the database connection).
`--wait` returns at that point.

> **Local demo configuration, not a secure public deployment:** MongoDB has
> no authentication (reachable only inside the Compose network), there is no
> TLS, and the app is published on 127.0.0.1 only.

### How the Images Are Built

`Dockerfile` (multi-stage, base `node:24.14.0-bookworm-slim`, the same
Node.js version as development, plus `openssl` for the Prisma engine and
`tini`):

- `deps`: `npm ci` (its `postinstall` runs `prisma generate` for Linux).
- `builder`: `next build` with `BUILD_STANDALONE=1`, that is
  `output: "standalone"`. The build needs no database and no
  `UPLOAD_SIGNING_SECRET`.
- `app`: only the standalone server and static assets (about 130 MB).
- `worker`: only `scripts/claim-expiry-worker.mts`, the two shared `.mts`
  modules it imports (`src/lib/claims/store.mts`, `constants.mts`) and the
  generated Prisma client (about 115 MB). Node runs the `.mts` files directly
  (type stripping).
- `schema`: the full dependency tree (Prisma CLI), used once per start.
- All runtime targets run as the unprivileged `node` user, with `tini` as
  PID 1 forwarding `SIGTERM`. On `docker compose stop` the worker finishes
  its current sweep and exits 0; the app exits on the signal (Next.js
  standalone has no shutdown hook; exit code 143).
- `.dockerignore` keeps `.env*`, `node_modules`, `.next`, test results, Git
  data and `docs` out of the build context; no `.env` is copied into an
  image. `UPLOAD_SIGNING_SECRET` reaches the app only as a run-time
  environment variable from `.env` (Compose refuses to start the app without
  it).

### Development vs. Full Docker Run

| | Local development (Windows) | Full Docker run |
| --- | --- | --- |
| Compose file / project | `compose.dev.yaml` / `sign-flow` | `docker-compose.yml` / `signflow` |
| What runs in Docker | MongoDB only | MongoDB, schema, app, worker |
| App and worker | `npm run dev`, `npm run worker:claims` on Windows | containers |
| MongoDB port | `127.0.0.1:27017` | not published |
| Replica set member | `127.0.0.1:27017` | `mongodb:27017` |
| Volumes | `sign-flow_mongodb_data`, `sign-flow_mongodb_config` | `signflow_mongodb_data`, `signflow_mongodb_config` |
| Database URL | `.env` `DATABASE_URL` (127.0.0.1) | set in `docker-compose.yml` (`mongodb`) |

The replica set member address is stored inside each volume when the set is
initiated, and drivers switch to that address after discovery. Windows
processes need `127.0.0.1:27017`; containers need `mongodb:27017`. The two
setups therefore use **separate volumes**. `docker/mongodb/replica-set.js`
never reconfigures an existing set: if a volume was initiated with another
address, it stays unhealthy and logs the mismatch. Both setups can run at the
same time (different ports).

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Compose refuses to start `app` and mentions `UPLOAD_SIGNING_SECRET` | `.env` has no secret. Create it as shown in the [README](../README.md#run-with-docker); it must be at least 32 characters. |
| Port 3080 is already in use | Add `APP_PORT=<port>` to `.env` and run `docker compose up -d --wait` again. |
| `docker compose up --wait` does not return or a service is unhealthy | Check `docker compose ps` and `docker compose logs -f <service>`. `schema` must exit 0 before `app` and `worker` start. |
| `mongodb` stays unhealthy and logs a member address mismatch | The volume was initiated with another replica set address. The script never reconfigures it; use the matching setup (dev or Docker) or a new volume. |
| `npm run db:up` fails locally | Port 27017 on `127.0.0.1` must be free. Check with `Get-NetTCPConnection -LocalPort 27017 -State Listen -ErrorAction SilentlyContinue`. |
| PowerShell blocks `npm` or `npx` | Use `npm.cmd` and `npx.cmd`. |
| Prisma CLI cannot find `DATABASE_URL` | Keep it in `.env`; the Prisma CLI does not read `.env.local`. |
| The dashboard shows *Reconnecting…* for long | Check the `app` logs and the database connection. A short reconnect every 280 s is expected and does not show *Reconnecting…*. |

## Database

### Why a Replica Set

A replica set is a group of `mongod` processes that hold the same data, with
one PRIMARY that accepts writes. MongoDB only supports multi-document
transactions on replica sets, and Prisma's MongoDB connector uses
transactions internally for nested writes. Change Streams also require a
replica set. On a standalone server Prisma fails with `Transactions are not
supported by this deployment`. For local runs we therefore use a
**single-node** replica set named `rs0`: one member that is always PRIMARY.

### Setup

- `mongod --replSet rs0` runs in the `mongodb` service of either Compose
  file. Data lives in that project's named volumes (`/data/db` and
  `/data/configdb`).
- `docker/mongodb/replica-set.js` is the container healthcheck. It calls
  `rs.initiate()` only if the set is not initialized yet (safe to re-run),
  reports healthy only when the node is PRIMARY, and refuses (stays
  unhealthy, exit 2) if the volume's set uses a different member address
  than `MONGO_REPLICA_HOST`. It never reconfigures silently. To re-run it
  manually (development):

  ```powershell
  docker compose -f compose.dev.yaml exec mongodb mongosh --quiet --file /docker/replica-set.js
  ```

- With `?replicaSet=rs0` the driver first contacts the seed host, discovers
  the members from the replica set config, and then connects to the
  advertised member address. In development that is `127.0.0.1:27017`; in
  the full run it is `mongodb:27017` (set via `MONGO_REPLICA_HOST` in
  `docker-compose.yml`). If you change the development port, change it in
  `compose.dev.yaml`, in `MONGO_REPLICA_HOST` or the script default, and in
  both URLs, and use a new volume.

### Prisma

- Schema: `prisma/schema.prisma` (MongoDB provider).
- Schema changes are applied with `prisma db push` (`db:push`,
  `db:push:test`). `prisma migrate` is not supported for MongoDB. `db push`
  creates indexes but does not rewrite existing documents.
- Server code imports the shared client from `@/lib/prisma`. It is marked
  `server-only` and reuses one `PrismaClient` across hot reloads in
  development.

## Environment Variables

`.env` is git-ignored; the template is `.env.example`. In the full Docker
run, Compose reads only `UPLOAD_SIGNING_SECRET`, `APP_PORT` and
`CLAIM_SWEEP_INTERVAL_MS` from it; the containers' `DATABASE_URL` is fixed in
`docker-compose.yml`.

| Variable | Used by | Default / example |
| --- | --- | --- |
| `UPLOAD_SIGNING_SECRET` | upload URL signing (**required**; server-side only, at least 32 characters; Docker: injected at run time) | random, for example 32 random bytes in base64url |
| `APP_PORT` | Docker run: host port of the app on 127.0.0.1 (optional) | `3080` |
| `DATABASE_URL` | Next.js (Prisma and the change-stream client), Prisma CLI, worker | dev: `mongodb://127.0.0.1:27017/signflow?replicaSet=rs0`; Docker: `mongodb://mongodb:27017/signflow?replicaSet=rs0` (set in Compose) |
| `TEST_DATABASE_URL` | dev only: integration tests, DB checks, `db:push:test` | `mongodb://127.0.0.1:27017/signflow_test?replicaSet=rs0` |
| `CLAIM_SWEEP_INTERVAL_MS` | worker (optional) | `5000` |
| `REALTIME_RETRY_BASE_MS` | change-stream reconnect backoff base (optional) | `1000` (max 30 s) |
| `SSE_HEARTBEAT_MS` | SSE heartbeat interval (optional) | `15000` |
| `MONGO_REPLICA_HOST` | replica set member address used by `replica-set.js` | dev default `127.0.0.1:27017`; Docker `mongodb:27017` |
| `BUILD_STANDALONE` | build time only (set in the `Dockerfile`): `output: "standalone"` | unset locally |

`UPLOAD_SIGNING_SECRET` is never exposed to the browser: it has no
`NEXT_PUBLIC_` prefix and is only read in `src/lib/uploads/signing.ts`, which
is `server-only`. Rotating it invalidates outstanding upload URLs.

`.env.atlas.local` (git-ignored, also excluded by `.vercelignore` and
`.dockerignore`) holds the Atlas `DATABASE_URL` for one-off commands such as
the initial `prisma db push`. Nothing loads it automatically; pass it
explicitly, for example `node --env-file=.env.atlas.local ...`. Production
variables are listed in [docs/deployment.md](deployment.md#production-environment-variables).

Next.js and the Prisma CLI load `.env` automatically; Vitest loads it through
`loadEnv` in `vitest.config.mts`, and the `.mts` scripts through
`node --env-file=.env`. Do not put `DATABASE_URL` only in `.env.local`: the
Prisma CLI does not read that file. There is no `prisma.config.ts`, because
with one Prisma 6 stops loading `.env` automatically.

## Test Commands

```powershell
npm.cmd run typecheck            # Next.js route types + tsc --noEmit
npm.cmd run lint                 # ESLint
npm.cmd run build                # production build (no database needed)
npm.cmd run check                # all three, in order

npm.cmd test                     # unit tests (no database)

# The following need the database: npm.cmd run db:up
npm.cmd run test:integration     # db:push:test, then API, claims, uploads, demo limits and SSE tests on signflow_test
npm.cmd run test:db              # Prisma connectivity smoke test (signflow_test)
npm.cmd run test:db:persistence  # data survives a restart of the dev mongodb service (signflow_test)
```

### Test Database

All automated database tests write only to the database in
`TEST_DATABASE_URL` (`signflow_test`), never to `DATABASE_URL` (`signflow`).

- Vitest's integration project sets `DATABASE_URL` to `TEST_DATABASE_URL`
  (`vitest.config.mts`); `tests/integration/setup.ts` runs before every test
  file and throws, before any write, unless the guard passes.
- The guard (`tests/support/test-database.mts`, also used by the `scripts/`
  DB checks and `db:push:test`) refuses to run when `TEST_DATABASE_URL` is
  missing, when its database name does not end in `_test`, or when it names
  the same database as `DATABASE_URL`.
- `npm run test:integration` first applies the schema to the test database
  (`scripts/db-push-test.mts`).
- Tests record the id of every document they create and delete exactly those
  ids in `finally`, even when a test fails. Nothing clears a collection.
- Time-dependent claim tests inject a fixed clock (`now`) into the service or
  set a past expiry on their own test record. Nothing waits three minutes and
  the production TTL is not changed.

### UI Check (Two Browser Windows)

`tests/ui/ui-check.mts` drives two headless browser windows (A at 390 px,
B at desktop width) through the Chrome DevTools Protocol. It covers:

- order creation and a status change;
- two installers claiming at the same time, and verification;
- claim expiry with the worker;
- a simulated upload; the *Print files* dialog must fit at 390×844 and
  768×1024 before, during and with a history of long file names;
- an expired claim taken over by another installer who fails verification,
  claims again, passes and completes, with no stale "Claimed as …" or "open
  again" messages and no false expiry notice in either window;
- the verification buttons' layout at both widths;
- the demo-limit messages in the *New order* and *Print files* dialogs;
- live updates in the other window and the 390 px layout.

It starts its own `next start` (port 3100) and worker against
`signflow_test`, and deletes only the orders and uploads it created.

Prerequisites: Microsoft Edge or Google Chrome installed (or set
`UI_TEST_BROWSER` to a Chromium-based browser executable), MongoDB running,
the test schema applied, and a production build:

```powershell
npm.cmd run db:up
npm.cmd run db:push:test
npm.cmd run build
npm.cmd run test:ui            # about 1 minute; screenshots in test-results/ui/ (git-ignored)
```

`UI_TEST_PORT` changes the app port if 3100 is taken. No extra npm packages
are needed (it uses Node's built-in `WebSocket` and `fetch`).

## Test Results

The documentation distinguishes five kinds of checks. A check that was not
performed is never reported as passed.

### 1. Automated Tests (in the Repository)

The last full run was before the first commit. Later changes were
documentation only, so the tests were not run again.

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` | clean |
| `npm run build` | passes, also without a database and without `UPLOAD_SIGNING_SECRET` |
| `npm test` (unit) | 87 of 87 passed |
| `npm run test:integration` | 117 of 117 passed |
| `npm run test:ui` (two windows) | 23 of 23 checks passed |

### 2. One-Off Automated Checks (Temporary Scripts, Not in the Repository)

- **Final Docker check (16 Nov 2026, `main` at commit `3571ce7`):** the
  `signflow` stack was rebuilt with `docker compose -f docker-compose.yml -p
  signflow --env-file .env up -d --build --wait`, without deleting volumes.
  The worker files in the container are identical to `main` (SHA-256
  comparison). The check drove headless Edge and a direct SSE connection
  against `127.0.0.1:3080`, and **34 of 34 checks passed**:
  - order creation (`201`, `DRAFT`, version 0), read via `GET /api/orders`,
    and arrival in the SSE stream and in the browser without a reload;
  - vendor assignment and the status cycle up to `READY_FOR_INSTALL`; a stale
    `expectedVersion` was rejected with `409 VERSION_CONFLICT`, and an invalid
    transition with `400 INVALID_TRANSITION`;
  - simulated upload: authorization with a signed URL, completion to
    `COMPLETED`, and a modified URL rejected with
    `403 UPLOAD_SIGNATURE_INVALID`; the status arrived in the SSE stream, and
    `GET /api/orders` returned no signed URL, `storageKey` or token hash;
  - a claim as Jordan; a second claim while the first was active was
    rejected with `409 CLAIM_UNAVAILABLE`;
  - **worker:** 186 s after the claim (expiry at 180 s plus one sweep) the
    claim was released in the database, the worker log showed
    `released 1 expired claim(s)`, the release arrived in the SSE stream, and
    verification with the old token was rejected with
    `409 CLAIM_NOT_ACTIVE`;
  - **SSE renewal:** the server sent `reconnect` and ended the stream after
    279.9 s; the browser opened a new stream 280 s after the first and stayed
    **Live** for all 281 sampled seconds;
  - **update after the renewal:** Sam claimed and passed verification, the
    order moved to `COMPLETED`, and a second order was created; the new
    stream received the changes, and the second order appeared in the
    browser;
  - **cleanup:** the check's two orders and one upload were deleted by id, as
    was the `demo_limits` counter it created; the three orders and six
    uploads that existed before were not touched.
- **Earlier Docker check:** a two-window browser check against
  `127.0.0.1:3080` passed 20 of 20. It ran on a version before the demo
  limits and the SSE stream lifetime were added.
- **SSE renewal:** one browser window stayed open for 5 minutes against a
  local `next start`. Two stream requests were recorded, 281 s apart, and the
  indicator stayed **Live** the whole time.
- **MongoDB Atlas:** connection, `prisma db push` without a reset, creating
  and updating an order through the real app services, receiving a change
  stream event, and deletion by id.
- **Worker image for the deployment:** built from `Dockerfile#worker` with
  dummy build arguments. The values did not appear in the image config,
  history or files. The container started and stopped gracefully.

### 3. Manual Local Checks

| Width | Automated (`npm run test:ui`) | Manual (browser responsive mode) |
| --- | --- | --- |
| 390×844 (phone) | whole two-window flow in window A, no horizontal page overflow; Installer assignment buttons; *Print files* dialog before, during and with a history of long file names | *Print files* dialog on the Docker build: found a horizontal overflow, which was fixed and added to the automated check; after the fix, *Print files* was re-checked manually at this size |
| 768×1024 (tablet) | *Print files* dialog only, in the same three states | dashboard and the *New order*, *Vendor*, *Change status*, *Installer assignment* (with the verification buttons) and *Print files* dialogs, all checked before the last *Print files* width fix |
| 1280×900 (desktop) | whole two-window flow in window B; Installer assignment buttons | not checked manually |

Manual two-window claim flows (expiry, another installer taking over, failed
and passed verification, completion) were also run. They found the stale
claim messages and the false expiry notice that the automated check now
covers. Their window sizes were not recorded.

Gap: at 768 px the automated check measures only the *Print files* dialog.
The dashboard and the other dialogs at tablet width were checked manually
before the last *Print files* width fix and have not been re-checked manually
since. The fix itself is covered at 768 px by the automated *Print files*
check.

### 4. Manual Cloud Check

Performed on the Vercel production deployment. The results, including what
was not checked, are in [docs/deployment.md](deployment.md#cloud-check-results).

### 5. Configuration-Only Verification

- `vercel.json` was validated against the official schema
  (`https://openapi.vercel.sh/vercel.json`) and is valid, including the daemon
  definition. Seven copies with deliberate errors were rejected.
- The Vercel WAF rule was configured, published and shown as active. An
  actual `429` was not triggered (see [docs/deployment.md](deployment.md#waf)).

## Local Demo Walkthrough

A short demo of the main flows (dev server, two browser windows). Before
starting: `npm.cmd run db:up`, then `npm.cmd run dev` and, in a second
terminal, `npm.cmd run worker:claims`. Open http://localhost:3000 in **two
windows** side by side. In the Docker run the address is
http://127.0.0.1:3080 and the worker is already running.

1. **Order and status:** in window 1 click *New order* and create one; it
   appears in window 2 immediately. *Vendor*, pick a vendor, *Save vendor*.
   *Change status*: *Submit order*, *Mark vendor accepted*, *Start
   production*, *Mark ready for install*. (Without a vendor, *Mark vendor
   accepted* is disabled, and the API answers `400 VENDOR_REQUIRED`.)
2. **Conflict between two installers:** set *Acting as installer* to
   different people in the two windows. Open *Installer assignment* on the
   order in both windows, then click *Claim as …* in both quickly. One window
   shows "Claimed as …" with a countdown, the other "Another installer
   claimed this job first." A status change on a stale version shows the
   "changed by someone else" message and refreshes.
3. **Verification:** in the claiming window use *Simulate: verification
   passed* (or *failed*, which releases the job at once). The other window
   shows "Installer: … · verified".
4. **Expiry:** claim another ready order and do nothing. The countdown runs
   from 3:00; at 0:00 both windows show the job as open again, and the
   claiming window shows "Your previous claim on … expired before
   verification" (also when the worker released the claim first). The worker
   then resets the stored claim. Now claim and verify it in the other window:
   the first window drops its "Claimed as …" message and shows the new
   assignment.
5. **Upload:** *Print files*, *Use a 1.5 GB demo print file*, *Start upload*
   (about 16 s, simulated). The other window shows the file as uploaded. Tick
   *Simulate a network failure* or press *Cancel upload* to see the failed
   and cancelled states and *Try again*.

The same flows run automatically with `npm.cmd run test:ui`.

## Versions and Dependencies

| Tool | Version |
| --- | --- |
| Next.js (App Router) | 16.4.6 |
| React / React DOM | 19.3.1 |
| TypeScript (strict) | 5.9.3 |
| Tailwind CSS | 4.3.5 |
| shadcn/ui components | generated with the shadcn CLI 4.23.0 (not a dependency) |
| ESLint | 9.39.x |
| Prisma / @prisma/client | 6.19.3 |
| MongoDB Node.js driver (`mongodb`) | 7.8.0 |
| MongoDB (Docker image) | 8.0.38 |
| Zod | 4.6.7 |
| Vitest / Vite | 5.1.0 / 8.3.8 |

Notes on version choices:

- **Prisma 6.19.3, not 7 or 8:** Prisma ORM 7 has no MongoDB connector, and
  the official upgrade guide says to stay on Prisma ORM 6 for MongoDB.
  Prisma 8 supports MongoDB but is still a release candidate. 6.19.3 is the
  newest stable release with MongoDB support. `prisma` and `@prisma/client`
  are pinned to the same exact version.
- **MongoDB 8.0.38:** the latest patch of the 8.0 line. Prisma 6 supports
  MongoDB 4.2+ (replica set required). The claim logic uses `$dateAdd`
  (MongoDB 5.0+).
- **TypeScript 5.9.3, not 7.x:** `typescript-eslint` (used by
  `eslint-config-next`) supports `typescript >=4.8.4 <6.1.0`. Next.js 16 and
  Prisma 6 require TypeScript 5.1+.
- **ESLint 9, not 10:** `eslint-plugin-react`, `eslint-plugin-import` and
  `eslint-plugin-jsx-a11y` (used by `eslint-config-next`) declare peer
  support up to ESLint 9. The official Next.js 16.4.6 template also uses
  ESLint 9.
- **`mongodb` 7.8.0:** the official Node.js driver, used only for Change
  Streams (Prisma 6 does not expose them). Next.js treats it as a
  server-external package (not bundled). Prisma keeps doing all reads and
  writes.
- **Zod 4.6.7:** the version already present in the lockfile (transitive
  dependency), now declared directly.
- **Vitest 5.1.0:** needs `vite` as a peer dependency, pinned to 8.3.8.
- Tailwind CSS v4 is wired through `@tailwindcss/turbopack` (as generated by
  `create-next-app`), so there is no `tailwind.config` or PostCSS config.
- **shadcn/ui:** the components in `src/components/ui` are source files; at
  run time they need only `radix-ui`, `cn`, `class-variance-authority`,
  `lucide-react` and `tw-animate-css`. The one file they used from the
  `shadcn` CLI package (its Tailwind variants, MIT) is vendored as
  `src/app/shadcn-tailwind.css`, so the CLI and its large dependency tree are
  not installed. To add components later, run
  `npx.cmd shadcn@4.23.0 add <name>`.
- `next.config.ts`: `cacheComponents` (the Next.js 16 default; API routes
  call `connection()`, and the page is a static shell) and
  `partialPrefetching` (Next 16.4 warns without it next to `cacheComponents`;
  it only affects `<Link>`, which this single page does not use), plus the
  Tailwind Turbopack loader.
- `tsconfig.json` enables `allowImportingTsExtensions` (allowed because of
  `noEmit`). Modules that the worker loads directly with Node
  (`src/lib/claims/store.mts`, `constants.mts`) are `.mts` files imported
  with their extension.

### `npm audit`

Last checked: 10 findings (3 high, 7 moderate; the `shadcn` CLI and its 5
findings were removed). None is in code that the running web app or worker
loads:

| Finding | Pulled in by | Kind | Status |
| --- | --- | --- | --- |
| `deepmerge-ts` < 8 (high, GHSA-ggr8-5vv4-36mx) via `@prisma/config` and `prisma` | the `prisma` 6.19.3 CLI (`generate`, `db push`) | CLI. Listed under `--omit=dev` too, because `@prisma/client` declares `prisma` as an optional peer, but the client runtime does not load `@prisma/config` | the only fix is Prisma 7, which has no MongoDB connector, so it is accepted; the CLI only merges this project's own config |
| `minimatch` 10.x (moderate, GHSA-g3hv-75wg-m249) via `typescript-eslint` packages | `eslint-config-next` | dev (lint) | the fixed `minimatch` 11 is outside `typescript-eslint`'s `^10` range; `npm audit fix --dry-run` changes nothing; no override without proof of compatibility |

Runtime dependencies (`next`, `react`, `@prisma/client`, `mongodb`, `zod`,
`radix-ui`, `lucide-react`, `cn`, `class-variance-authority`,
`tw-animate-css`, `server-only`) have no reported findings.

In the Docker images: the `app` and `worker` images contain neither the
Prisma CLI nor the lint toolchain, so none of the findings above is present
there. The one-shot `schema` image contains the full dependency tree (it
needs the Prisma CLI). `npm ci` in the image build prints a deprecation
notice for ESLint 9; it is a dev tool and not in the runtime images.

## Project Structure

```
src/
  app/
    page.tsx                 dashboard page (static shell)
    api/orders/              list/create, status, vendor, claim, verification,
                             uploads (authorize/complete/abort), events (SSE)
    shadcn-tailwind.css      vendored Tailwind variants from shadcn (MIT)
  components/
    orders/                  dashboard, dialogs (create, status, vendor, installer
                             assignment), claim summary, live-data hooks
    uploads/                 print files dialog, upload summary, upload manager hook
    ui/                      shadcn/ui components
  lib/
    orders/                  status rules, schemas, service, merge, API client
    claims/                  claim model, demo installers, schemas, service,
                             store.mts (conditional writes + worker loop), constants.mts
    uploads/                 limits, schemas, signing (server), service (server),
                             simulated storage adapter (browser)
    realtime/                change-stream order feed, SSE response
    vendors/                 demo vendors and vendor rules
    api/http.ts              JSON and error response helpers
    demo-limits.mts          demo data limits (orders, upload attempts per order)
    prisma.ts                shared Prisma client (server-only)
prisma/                      Prisma schema
scripts/                     expiry worker, test-DB push, DB smoke/persistence checks
tests/
  integration/               API, vendors, claims, uploads, demo limits and SSE tests (test database only)
  ui/                        two-window UI check (npm run test:ui)
  support/                   test-database guard
docs/                        documentation (architecture, development and testing, deployment)
docker/mongodb/              replica set init / healthcheck script
Dockerfile                   multi-stage images: app, worker, schema
docker-compose.yml           full Docker run (MongoDB, schema, app, worker)
compose.dev.yaml             MongoDB for local Windows development
.dockerignore                keeps secrets and build output out of the build context
.vercelignore                keeps env files, keys, docs and test output out of Vercel uploads
vercel.json                  Vercel: function region and the claim-expiry worker daemon
```
