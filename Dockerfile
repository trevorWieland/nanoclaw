# NanoClaw Host Process
# Orchestrator that spawns sibling agent containers via Docker socket.
# Uses Docker-out-of-Docker: needs /var/run/docker.sock mounted at runtime.

FROM node:22-slim AS build

# better-sqlite3 requires native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pin pnpm to the version declared in package.json for reproducible builds
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

# Install dependencies (layer cached separately from source)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build TypeScript
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm run build

# Prune dev dependencies so node_modules is production-ready.
# This keeps the already-compiled better-sqlite3 native module
# without needing build tools in the production stage.
RUN pnpm prune --prod

# --- Production stage ---
FROM node:22-slim

# Docker CLI for Docker-out-of-Docker (just the CLI, not the daemon)
RUN apt-get update \
    && apt-get install -y ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
       | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
       https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy pruned node_modules from build stage (includes compiled native modules)
COPY --from=build /app/node_modules ./node_modules

# Copy built output, package manifest, and runtime assets
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY container/ container/
COPY CLAUDE.md ./
COPY docs/ docs/

# Three-root model: APP_DIR is baked into the image,
# CONFIG_DIR and DATA_DIR are mounted at runtime.
ENV NANOCLAW_APP_DIR=/app

VOLUME ["/data", "/config"]
EXPOSE 3001

CMD ["node", "dist/index.js"]
