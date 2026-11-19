# Build from the repo root: docker build -f apps/server/Dockerfile .
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
RUN pnpm install --frozen-lockfile --filter "@teamkit/server..."

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/packages/protocol/node_modules ./packages/protocol/node_modules
COPY --from=deps --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --chown=node:node package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY --chown=node:node packages/protocol ./packages/protocol
COPY --chown=node:node apps/server ./apps/server
WORKDIR /app/apps/server
EXPOSE 8787
USER node
CMD ["node", "--import", "tsx", "src/main.ts"]
