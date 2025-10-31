# Build stage
FROM node:22-alpine AS builder

# Install utilities (wget for health checks, etc.)
RUN apk add --no-cache wget

# Enable pnpm via corepack
RUN corepack enable

# Set workspace root
WORKDIR /app

# Copy workspace manifests first for better caching
COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml ./

# Copy web app manifest for dependency resolution
COPY apps/web/package.json ./apps/web/package.json

# Install dependencies (cached unless manifests change)
RUN pnpm install --frozen-lockfile

# Copy web source code
COPY apps/web ./apps/web

# Build the web app (TanStack Start + Nitro outputs to .output)
# Pass API base URL at build time to embed it into the client/SSR bundle
RUN pnpm run build:web

# Production stage
FROM node:22-alpine AS production

# Install wget for health checks
RUN apk add --no-cache wget

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Work from the web app directory to match runtime paths
WORKDIR /app/apps/web

# Copy built output from builder
COPY --from=builder --chown=nodejs:nodejs /app/apps/web/.output ./.output

# Copy public assets (fonts, icons). Some assets are not bundled into .output/public.
COPY --from=builder --chown=nodejs:nodejs /app/apps/web/public ./public

# Copy manifests and node_modules for any SSR/runtime deps that Nitro might reference
COPY --from=builder --chown=nodejs:nodejs /app/package.json /app/package.json
COPY --from=builder --chown=nodejs:nodejs /app/apps/web/package.json ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/node_modules /app/node_modules
COPY --from=builder --chown=nodejs:nodejs /app/apps/web/node_modules ./node_modules

# Environment
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# Keep a sensible default for API base URL; can be overridden at runtime
ENV VITE_API_BASE_URL=http://localhost:4000

# Expose the Nitro node server port
EXPOSE 3000

# Health check (basic root check; adjust if you add /health)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start the server
USER nodejs
CMD ["node", ".output/server/index.mjs"]