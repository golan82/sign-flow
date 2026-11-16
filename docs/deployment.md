# Deployment and Shutdown

This document describes the public demo deployment, reviewer access, access
protection and quotas, the cloud check results and the shutdown procedure.
Plan details were checked against the Vercel and Atlas documentation in
November 2026; check the linked pages at the end again before relying on
them.

## Current State

| Component | State |
| --- | --- |
| URL | **https://sign-flow-flame.vercel.app** (production) |
| Hosting | Vercel Hobby, built from the `main` branch of a private GitHub repository. Every push to `main` triggers an automatic production deployment |
| Functions | region `iad1` (Washington, D.C.) |
| Claim-expiry worker | Vercel Daemon (beta) named `worker`, one instance in `iad1`, 1 GiB |
| Database | MongoDB Atlas Free cluster, database `signflow`, dedicated user `signflow_app` with `readWrite` on `signflow` only |
| GitHub connection | the Vercel GitHub app has access to the `sign-flow` repository only (verified manually) |
| Access protection | Vercel Authentication, including the production domain. The reviewer signs in through a shareable link provided separately |
| WAF | an active Rate Limit rule on writes to `/api/orders` (see [WAF](#waf)) |

## Reviewer Access

**The access link is provided to the reviewer separately and is not stored
in the repository or the documentation.**

1. Open the access link you received, preferably in a private window, so
   that another Vercel account in the browser does not interfere. After the
   link is opened, the browser has access to the site, including the page's
   API and SSE requests.
2. For two-window checks, open another window in the same browser and the
   same mode. If the second window redirects to the Vercel sign-in page, open
   the access link in it as well.
3. Pick a different installer in each window under **Acting as installer**.
   A suggested walkthrough is in
   [docs/development-and-testing.md](development-and-testing.md#local-demo-walkthrough).
4. The data is shared by everyone who has the link, and the demo identities
   are not permissions. The [demo limitations](../README.md#demo-limitations)
   apply: at most 200 orders, at most 20 upload attempts per order, and `429`
   for more than 30 writes per minute from one IP address.
5. Please do not pass the link on. After the review, access will be closed
   following the [shutdown procedure](#shutdown-procedure).

Without access, the page, `/api/orders` and `/api/orders/events` redirect to
the Vercel sign-in page.

## Vercel Configuration

### `vercel.json`

- `regions: ["iad1"]`: the app's functions run in Washington, D.C. (Hobby
  allows one region); the Atlas region should be close to it.
- `daemons.worker`: the claim-expiry worker, built from `Dockerfile#worker`
  (the `worker` stage, which is also the last one) with the repository root
  as build context, **one instance in `iad1`, 1 GiB**. The image's own
  `ENTRYPOINT`/`CMD` start it (`tini`, then
  `node scripts/claim-expiry-worker.mts`). On a redeploy Vercel sends
  `SIGTERM` and waits 30 s, and the worker stops after its current sweep. The
  `#stage` syntax comes from the `vercel.json` schema; the daemon docs only
  show a plain `Dockerfile`. Daemons are in beta, run only in production, and
  the project's root directory must be the repository root.
- Vercel passes the deployment's environment variables to the image build as
  build arguments. The `Dockerfile` declares none of them, so they never end
  up in the image (checked with dummy values: not in the image config,
  history or files).
- The Next.js app is built by Vercel's regular Next.js builder; the
  `Dockerfile` is used only for the daemon. The build needs no database and
  no secrets (checked with an unreachable `DATABASE_URL` and an empty
  `UPLOAD_SIGNING_SECRET`).
- `vercel.json` was validated against the official schema and is valid.

### Production Environment Variables

In Vercel: Settings, Environment Variables. Environment **Production** only,
type *Secret* (write-only after saving and redacted in build logs). New
values, never the local ones:

| Variable | Value | Used by |
| --- | --- | --- |
| `DATABASE_URL` | the Atlas connection string of `signflow_app`, **including `/signflow`** as the database name | app and worker |
| `UPLOAD_SIGNING_SECRET` | a new random value, at least 32 characters | app only |
| `CLAIM_SWEEP_INTERVAL_MS` | optional, default `5000` | worker only |

Not needed in production: `TEST_DATABASE_URL`, `APP_PORT`,
`MONGO_REPLICA_HOST`, `BUILD_STANDALONE`. Production-only variables keep
preview deployments away from the database.

### `.vercelignore`

The Vercel CLI does not read `.gitignore`, so `.vercelignore` excludes
environment files (`.env`, `.env.*`, except `.env.example`), keys (`*.pem`,
`*.key`), `docs/` (including the original task specification), test output,
build output and `node_modules`. The deployment itself is built from Git,
and the Git repository contains no private environment files.

## MongoDB Atlas

- A dedicated database user for this app only: the built-in role
  `readWrite` on the database **`signflow`** only, restricted to this
  cluster, with a long random password. Not `readWriteAnyDatabase` (the role
  of the user that the Vercel and Atlas integration creates, which is
  therefore not used).
- Network access: `0.0.0.0/0` is required, because Vercel functions have no
  fixed IP addresses. The password and TLS are then the only barrier, which
  is why the user is limited to `signflow`.
- MFA on the Atlas account: recommended, but **not verified yet**.
  `TEST_DATABASE_URL` never points at Atlas.
- The indexes were created once with `prisma db push`, with `DATABASE_URL`
  set only for that command (from `.env.atlas.local`, never written to
  `.env`).
- Free tier limits: 512 MB, 500 connections, 100 operations per second, and
  10 GB in and 10 GB out per 7 days (beyond that Atlas throttles). The
  cluster is paused after 30 days without connections.

## SSE and the Worker on the Free Plan

- Every SSE response ends after 280 s (the route's `maxDuration` is 300 s,
  the Hobby maximum), and the client reconnects at once with a full
  snapshot.
- Each open dashboard tab keeps a function instance alive, which counts
  against Provisioned Memory (360 GB-hours a month on Hobby). A tab left open
  for days can use up the month's quota.
- Each function instance opens its own change stream and MongoDB connection
  pool (Atlas Free: 500 connections).
- The daemon uses about 24 GB-hours a day at 1 GiB, so the 420 GB-hour quota
  lasts about 17 days; Vercel then stops it until the 1st of the next month
  (UTC). Claim expiry is still enforced by the API; only the reset of the
  stored fields and its live update wait.

## Access Protection

- *Standard Protection* does **not** protect the production domain. It
  protects preview deployments and the production deployment's generated
  URL.
- *All Deployments* protection (Vercel Authentication) is included on Hobby
  and also covers the production domain. Who can then open it: members of the
  Vercel account, one outside Vercel user per account whose access request is
  approved, or anyone with the account's **single shareable link**. Password
  Protection is not available on Hobby.
- In the cloud check, access through the shareable link also allowed the
  page's API and SSE requests (see [Cloud Check Results](#cloud-check-results)).
- The Vercel GitHub app's access is limited to the `sign-flow` repository
  only, verified manually. Deployments are built from Git. If you deploy with
  the CLI, do so only together with `.vercelignore` (the CLI uploads files
  that `.gitignore` excludes, including `.env`).

## WAF

**The active rule:**

| Field | Value |
| --- | --- |
| Action | Rate Limit, response `429` |
| Paths | starting with `/api/orders` |
| Methods | `POST`, `PATCH` |
| Threshold | 30 requests per 60 seconds |
| Key | IP address |

**What the rule does not do:**

- It **does not limit `GET` requests or SSE connections**
  (`/api/orders/events`).
- It **does not guarantee that the Vercel and Atlas quotas cannot be
  exhausted**. See the quotas below.
- Counters are per region, so the threshold can be exceeded across regions.
  No rule stops a distributed flood from many addresses.
- A custom rule with *Deny*, *Challenge* or *Log* is a filter, **not** a rate
  limit: it does not count requests.

**WAF limits on Hobby:** up to **3 custom rules** per project, of which **at
most 1** may use the *Rate Limit* action. Keys: IP or JA4 digest. Fixed
window of 10 s to 10 min. 1,000,000 allowed requests are included; what
happens beyond that on Hobby is not documented. *Attack Mode* is available
on all plans for an incident (it switches off after 1, 6 or 24 hours).

**Check status:** the rule was configured, published and shown as active in
the Vercel dashboard. This is a configuration check only. **An actual `429`,
by exceeding the threshold, was not tested.**

## Hobby Quotas for Production

Monthly quotas. When one is used up, the feature is unavailable until 30 days
have passed.

| Resource | Included |
| --- | --- |
| Function invocations | 1,000,000 |
| Active CPU | 4 hours |
| Provisioned Memory | 360 GB-hours (each open tab keeps an instance alive) |
| Fast Data Transfer / Fast Origin Transfer | 100 GB / 10 GB |
| CDN requests | 1,000,000 |
| Function duration | 300 s per request (SSE reconnects) |
| Runtime logs | kept for 1 hour |
| Daemons (beta, per account) | 5 Active CPU-hours and 420 GB-hours; a 1 GiB worker running all the time uses about 720 GB-hours a month, so it stops after about 17 days (expiry is still enforced by the API) |

Hobby is for personal, non-commercial use, and its terms allow Vercel to use
the content for AI training. During the review window, watch *Usage* in
Vercel and *Metrics* in Atlas.

## Cloud Check Results

The check was performed **manually**, in a browser, against the production
deployment. It is separate from the automated tests and the local Docker
checks described in
[docs/development-and-testing.md](development-and-testing.md#test-results).

**Performed and passed:**

1. **Without access**, the page, `/api/orders` and `/api/orders/events`
   redirected to the Vercel sign-in page.
2. **Through the shareable link**, in a private window, the site opened, an
   order was created, and a vendor assignment appeared in another window
   without a reload.
3. **Creation, vendor assignment and the whole status cycle** up to
   `COMPLETED` passed in two windows.
4. **Claim:** Jordan claimed an order, and the state appeared in the second
   window.
5. **Expiry:** the claim expired after 3 minutes. The daemon log showed
   `released 1 expired claim(s)`, and the instance was Alive in `iad1`.
6. **Claim after expiry:** Sam claimed after the expiry, passed verification,
   and the order was completed in both windows.
7. **Upload:** the 1.5 GB demo upload completed, and the file appeared in the
   second window.

**Not checked manually in the cloud:**

- **Simultaneous claims:** two claim requests were not sent manually at the
  same time. Concurrency was tested only by the local automated tests
  (integration and UI check).
- **Absence of tokens, `storageKey` and signatures in raw responses.** This
  is covered locally by the integration tests
  (`tests/integration/uploads.test.ts`, `tests/integration/claims.test.ts`,
  `tests/integration/orders-events.test.ts`).
- **An actual `429`** by exceeding the WAF threshold.
- **SSE renewal after 280 s:** no cloud check was recorded. The renewal was
  tested by local one-off automated checks.

**Configuration only:** the WAF rule (30 `POST`/`PATCH` requests per 60
seconds per IP) was configured, published and shown as active.

**Additional check while writing the documentation:** HTTP requests without
access to `/` and `/api/orders` received `302` to the Vercel sign-in page.

## Redeploying and Acceptance Check

A push to `main` triggers an automatic production deployment. In the
deployment, check that the Next.js build and the daemon image build succeed,
and that the daemon `worker` shows one running instance whose log starts
with `[claim-expiry] … started, sweeping every 5000 ms`.

The initial setup was done as follows:

1. Import the repository in Vercel (*Add New Project*). Framework: Next.js
   (detected). Root directory: the repository root. Install and build
   commands: the defaults (`npm install` runs `prisma generate`, then
   `next build`).
2. Add the production environment variables **before** the first production
   deployment, because the daemon reads them only from a production
   deployment.
3. Configure access protection and the WAF rule.
4. Deploy to production.

**Acceptance check after deploying**, in two windows (one at phone width):

1. Both show **Live**. An order created in one appears in the other.
2. Assign a vendor and move the order to *Ready for install*; the other window
   follows.
3. Claim it as two installers at once: one wins, the other sees the conflict.
   *Simulate: verification passed*, and the other window shows
   *Installer: … · verified*.
4. Claim another ready order and wait 3 minutes: both windows show it as open
   again, and within seconds the daemon log shows
   `released 1 expired claim(s)`.
5. *Print files*, *Use a 1.5 GB demo print file*, *Start upload*; the other
   window shows it as uploaded.
6. A window left open for more than 5 minutes stays **Live** (the stream is
   renewed after 280 s without *Reconnecting…*).
7. `GET /api/orders` returns no `claimTokenHash`, `storageKey` or signed URL.
   Function and daemon logs show no errors; Atlas *Metrics* shows the
   connections.
8. Delete the acceptance orders (Atlas Data Explorer, by id, with their
   uploads) before sending the link to a reviewer.

Which of these steps were actually performed is listed in
[Cloud Check Results](#cloud-check-results).

## Shutdown Procedure

To be carried out after the review. **Not performed yet.**

1. **Stop access:** revoke the shareable link. To take the site down
   completely, delete the Vercel project.
2. **Stop the daemon:** set its instances to 0, or remove `daemons` from
   `vercel.json` and redeploy (deleting the project also removes it).
3. **Revoke database access:** delete the dedicated Atlas database user, then
   remove the `0.0.0.0/0` network access entry. Pause or terminate the free
   cluster if it is no longer needed.
4. **Remove the secrets:** delete `DATABASE_URL` and `UPLOAD_SIGNING_SECRET`
   from the Vercel project; they were created for this deployment only.
5. **GitHub:** remove the Vercel app's access to the repository if it is no
   longer needed.
6. **Check:** the URL no longer serves the app, and Atlas shows no
   connections.

## Sources

[Vercel Hobby](https://vercel.com/docs/plans/hobby),
[Functions limits](https://vercel.com/docs/functions/limitations),
[Deployment Protection](https://vercel.com/docs/deployment-protection),
[Shareable Links](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/sharable-links),
[WAF](https://vercel.com/docs/vercel-firewall/vercel-waf),
[WAF Rate Limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting),
[Secret environment variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables),
[.vercelignore](https://vercel.com/docs/deployments/vercel-ignore),
[Daemons limits](https://vercel.com/docs/daemons/limits),
[Daemons config reference](https://vercel.com/docs/daemons/config-reference),
[Function regions](https://vercel.com/docs/functions/configuring-functions/region),
[Function duration](https://vercel.com/docs/functions/configuring-functions/duration),
[Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/),
[Atlas and Vercel integration](https://www.mongodb.com/docs/atlas/reference/partner-integrations/vercel/).
