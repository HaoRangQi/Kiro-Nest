# syntax=docker/dockerfile:1

# Build the standalone gateway bundle.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsdown.config.ts ./
COPY src ./src
RUN npm run build

# Runtime image: the gateway bundle only uses Node built-ins.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    KIRO_NEST_DATA_DIR=/data
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/lib/gateway ./lib/gateway
COPY --from=build --chown=node:node /app/web ./web
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.KIRO_NEST_PORT || 8787) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "lib/gateway/main.js"]
