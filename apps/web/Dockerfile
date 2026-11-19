# Build from the repo root: docker build -f apps/web/Dockerfile .
FROM node:22-slim AS deps
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY examples/service-agent/package.json examples/service-agent/package.json
COPY e2e/package.json e2e/package.json
RUN pnpm install --frozen-lockfile --filter "@teamkit/web..."

FROM node:22-slim AS run
ENV COREPACK_HOME=/opt/corepack NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate \
  && chmod -R a+rX /opt/corepack \
  && mkdir /app && chown node:node /app
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=deps --chown=node:node /app/packages/client/node_modules ./packages/client/node_modules
COPY --from=deps --chown=node:node /app/apps/web/node_modules ./apps/web/node_modules
COPY --chown=node:node package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY --chown=node:node packages/protocol ./packages/protocol
COPY --chown=node:node packages/client ./packages/client
COPY --chown=node:node apps/web ./apps/web
USER node
# next build runs with NODE_ENV=production; devDependencies (typescript, @types/*) are installed by the deps stage.
RUN pnpm --filter @teamkit/web build
ENV TEAMKIT_SERVER_URL=http://server:8787
EXPOSE 3000
CMD ["pnpm", "--filter", "@teamkit/web", "start"]
