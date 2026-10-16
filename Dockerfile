# Node 22 LTS, pinned by tag and digest. To bump: docker pull node:22-bookworm-slim, then copy the
# new digest from `docker inspect --format '{{index .RepoDigests 0}}'`.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# --- base: Node + pnpm (version taken from "packageManager" in package.json) ---
FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
COPY package.json ./
RUN corepack enable && corepack install

# --- build: all dependencies, then the app bundle and the migration runner ---
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
# No env vars are needed to build; they are validated when the server starts.
RUN pnpm build && pnpm build:migrate

# --- prod-deps: production dependencies only (adapter-node leaves "dependencies" external) ---
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# --- runtime ---
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# The base image lags behind Debian security updates, so apply them (Trivy fails the build on fixable
# HIGH/CRITICAL findings). Also drop npm, corepack and yarn: the app is started with plain `node`, and
# the packages bundled inside npm only add scanner findings and attack surface.
RUN apt-get update \
    && apt-get -y --no-install-recommends upgrade \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-* \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/build-migrate/migrate.js ./migrate.js
COPY --from=build /app/drizzle ./drizzle
COPY package.json ./
# Built-in unprivileged user of the node image (UID/GID 1000). The app writes nothing to disk.
USER 1000:1000
EXPOSE 3000
# Exec form so node is PID 1 and receives SIGTERM directly (adapter-node drains, then exits 0).
CMD ["node", "build"]
