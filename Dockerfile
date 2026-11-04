# ---- build ----
FROM node:24-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
# A full Debian image on purpose: the agent builds and tests the applications it writes
# (node, python, make, compilers), and sandboxes its shell with bubblewrap.
FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq python3 python3-venv python3-pip build-essential bubblewrap socat ripgrep \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/apps/web/dist \
    PORT=8080
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps/server/package.json ./apps/server/
COPY --from=build /src/apps/server/dist ./apps/server/dist
COPY --from=build /src/apps/server/templates ./apps/server/templates
COPY --from=build /src/apps/web/dist ./apps/web/dist
RUN useradd -m -u 10001 blackbox && mkdir -p /data && chown blackbox /data
USER blackbox
VOLUME /data
EXPOSE 8080
WORKDIR /app/apps/server
CMD ["node", "dist/index.js"]
