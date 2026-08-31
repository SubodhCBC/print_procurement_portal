# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Production image for the Ticket-IT API.
#   docker build -f docker/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t ticketit-api .
# ---------------------------------------------------------------------------
ARG NODE_VERSION=22.13.0

# --- base -------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
# OpenSSL is required by the Prisma query engine on slim images.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- dependencies -----------------------------------------------------------
# Copied separately from the sources so a code change does not invalidate this
# layer. `npm ci` installs exactly what the lockfile pins.
FROM base AS deps
COPY package.json package-lock.json prisma.config.ts ./
# The schema has to be present here: `npm ci` runs the postinstall hook,
# which generates the Prisma client.
COPY src/database/prisma ./src/database/prisma
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm ci

# --- build ------------------------------------------------------------------
FROM deps AS build
COPY . .
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
RUN npm run build

# --- production dependencies ------------------------------------------------
# Resolved in a clean stage so no devDependency (Nest CLI, TypeScript, Vitest)
# can leak into the runtime image.
FROM base AS prod-deps
COPY package.json package-lock.json ./
# --ignore-scripts also skips the postinstall hook, so no schema is needed
# here; the generated client is copied from the build stage below.
RUN --mount=type=cache,id=npm,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# --- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=prod-deps --chown=node:node /app/node_modules /app/node_modules
# The generated Prisma client only exists in the build stage; `prisma generate`
# cannot run here because the CLI is a devDependency.
COPY --from=build --chown=node:node /app/node_modules/.prisma        /app/node_modules/.prisma
COPY --from=build --chown=node:node /app/node_modules/@prisma/client /app/node_modules/@prisma/client
COPY --from=build --chown=node:node /app/dist                        /app/dist
COPY --from=build --chown=node:node /app/package.json                /app/package.json
COPY --from=build --chown=node:node /app/nest-cli.json               /app/nest-cli.json
COPY --from=build --chown=node:node /app/prisma.config.ts            /app/prisma.config.ts
# Migrations and the committed per-environment defaults ship with the image.
COPY --from=build --chown=node:node /app/src/database/prisma         /app/src/database/prisma
COPY --from=build --chown=node:node /app/src/database/migrations     /app/src/database/migrations
COPY --from=build --chown=node:node /app/src/config/env              /app/src/config/env

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# dumb-init reaps zombies and forwards SIGTERM, which is what triggers Nest's
# graceful shutdown hooks. Without it, `docker stop` kills in-flight requests.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
