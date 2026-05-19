# Encyclopedia of AI Hallucinations
# Multi-stage build for Bun + TypeScript app.
# Target: arm64 (Raspberry Pi 3). oven/bun:1 supports arm64.

# --- Stage 1: dependencies ---
FROM oven/bun:1 AS deps
WORKDIR /app

# Copy manifest(s). bun.lock is optional during early development;
# the wildcard tolerates its absence without failing the build.
COPY package.json ./
COPY bun.loc[k] ./

# Install with frozen lockfile when present; otherwise plain install.
RUN if [ -f bun.lock ]; then \
      bun install --frozen-lockfile; \
    else \
      bun install; \
    fi

# --- Stage 2: runtime ---
FROM oven/bun:1 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8090

# Pull installed deps from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Application source and config.
COPY package.json ./
COPY tsconfig.json ./
COPY bunfig.toml ./
COPY src ./src
COPY scripts ./scripts

EXPOSE 8090

# Healthcheck: use Bun itself to hit /health. Avoids assuming curl/wget
# are present in the oven/bun:1 image (slim Debian base, no curl by default).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:8090/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Drop privileges. oven/bun:1 ships a non-root 'bun' user.
USER bun

CMD ["bun", "src/server.ts"]
