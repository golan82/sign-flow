# syntax=docker/dockerfile:1
#
# Multi-stage image for SignFlow. Targets:
#   app     Next.js standalone server (port 3000)
#   worker  claim-expiry worker (plain Node, .mts via type stripping)
#   schema  one-shot `prisma db push` (indexes) before app/worker start
# The build needs neither a database nor UPLOAD_SIGNING_SECRET; secrets are
# injected at run time (see docker-compose.yml). No .env file is copied
# (.dockerignore).

# Same Node.js version as local development; Debian (glibc) for the Prisma engines.
ARG NODE_IMAGE=node:24.14.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
# openssl: Prisma detects it to choose its engine; tini: PID 1 that forwards
# SIGTERM/SIGINT to Node and reaps zombies.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app

# ---- dependencies (incl. dev tools needed for the build and prisma CLI) ----
FROM base AS deps
COPY package.json package-lock.json ./
# postinstall runs `prisma generate`, which needs the schema.
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# ---- build ----
FROM deps AS builder
COPY . .
ENV BUILD_STANDALONE=1 \
    NODE_ENV=production
RUN npm run build

# ---- one-shot schema push (indexes) ----
FROM base AS schema
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node prisma ./prisma
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "node_modules/prisma/build/index.js", "db", "push", "--skip-generate"]

# ---- web app ----
FROM base AS app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

# ---- claim-expiry worker ----
# Only what the worker loads: the script, the two shared .mts modules it
# imports relatively, and the generated Prisma client (no other runtime deps).
FROM base AS worker
ENV NODE_ENV=production
COPY --from=deps --chown=node:node /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=deps --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=node:node scripts/claim-expiry-worker.mts ./scripts/
COPY --chown=node:node src/lib/claims/store.mts src/lib/claims/constants.mts ./src/lib/claims/
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "scripts/claim-expiry-worker.mts"]
