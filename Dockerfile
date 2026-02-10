# ── Stage 1: Build ──────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /build

# Copy dependency manifests first (layer caching)
COPY package.json package-lock.json ./

# Install ALL dependencies (including devDependencies for tsc)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

# ── Stage 2: Runtime ────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# dumb-init: proper PID 1 signal forwarding (SIGTERM, zombie reaping)
RUN apk add --no-cache dumb-init

# Non-root user with well-known UID for consistent volume permissions
RUN addgroup -g 1001 -S mcpproxy && adduser -u 1001 -S mcpproxy -G mcpproxy

WORKDIR /app

# Install production-only dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from build stage
COPY --from=build /build/dist/ ./dist/

# Config directory — volume-mounted at runtime from host
RUN mkdir -p /config && chown mcpproxy:mcpproxy /config

# Point config loading at the mount point
ENV MCP_CONFIG_DIR=/config

# Switch to non-root user
USER mcpproxy

# Default port for the remote server
EXPOSE 9999

# Health check using the built-in /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:9999/health || exit 1

# Use dumb-init as PID 1 for proper signal forwarding
ENTRYPOINT ["dumb-init", "--"]

# Start the remote server
CMD ["node", "dist/remote-server.js"]
