# syntax=docker/dockerfile:1
#
# Perch Network Controller: the AdonisJS API plus the built dashboard it serves.
#   docker build -t perch-controller .
# The compose file in this directory wires it to MariaDB and the collector.

FROM node:22-bookworm-slim AS build
# Native modules (better-sqlite3) fall back to a source build when no prebuilt
# binary matches the platform; keep the toolchain in the build stage only.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN npm --prefix dashboard ci --no-audit --no-fund
COPY . .
RUN npm run build:dashboard && npm run build:api
RUN cd build && npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
# openssh-client: optional AP control and router hostname enrichment over SSH.
# tini: reaps the ssh children. ca-certificates: HTTPS to APs / ASN lookups.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3333 \
    TZ=UTC \
    LOG_LEVEL=info \
    APP_URL=http://localhost:3333 \
    SESSION_DRIVER=cookie \
    LOCK_STORE=memory \
    SCHEDULER_HTTP_SERVER=true \
    DB_HOST=db \
    DB_PORT=3306 \
    DB_USER=metricslite \
    DB_DATABASE=metricslite \
    PERCH_DATA_DIR=/data
WORKDIR /app
COPY --from=build /src/build ./
COPY docker/entrypoint.sh /usr/local/bin/perch-entrypoint
RUN chmod +x /usr/local/bin/perch-entrypoint && mkdir -p /data
VOLUME ["/data"]
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3333) + '/api/v1/setup/status').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["tini", "--", "perch-entrypoint"]
CMD ["node", "bin/server.js"]
