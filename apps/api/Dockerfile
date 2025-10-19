# Use Node.js Alpine as the base image
FROM node:22-alpine AS base

# Install wget and other required packages
RUN apk add --no-cache wget

# Enable pnpm
RUN corepack enable

# Set working directory
WORKDIR /app

# Copy workspace configuration files first for better layer caching
COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml ./

# Copy package.json files for all workspace packages to leverage Docker layer caching
COPY packages/shared/constants/package.json ./packages/shared/constants/
COPY packages/shared/lol-types/package.json ./packages/shared/lol-types/
COPY packages/queues/package.json ./packages/queues/
COPY apps/api/package.json ./apps/api/

# Install dependencies (this layer will be cached if package.json files don't change)
RUN pnpm install --frozen-lockfile

# Copy source code for shared packages
COPY packages/ ./packages/

# Copy API source code
COPY apps/api/src/ ./apps/api/src/
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/rolldown.config.ts ./apps/api/

RUN pnpm compile

# Build the application
RUN cd apps/api && pnpm run build

# Production stage
FROM node:22-alpine AS production

# Install wget in production image
RUN apk add --no-cache wget

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

# Copy built application from build stage
COPY --from=base --chown=nodejs:nodejs /app/apps/api/dist/ ./dist/

# Copy package.json for runtime dependencies info
COPY --from=base --chown=nodejs:nodejs /app/apps/api/package.json ./

# Switch to non-root user
USER nodejs

# Expose port (adjust if your app uses a different port)
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

# Start the application
CMD ["node", "--enable-source-maps", "dist/index.js"]