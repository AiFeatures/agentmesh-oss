FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json biome.json ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @agentmesh/hub build

RUN addgroup -S agentmesh && adduser -S agentmesh -G agentmesh -h /home/agentmesh
RUN mkdir -p /home/agentmesh/.agentmesh /app/packages/hub/data
RUN chown -R agentmesh:agentmesh /home/agentmesh /app

ENV HOME=/home/agentmesh
USER agentmesh

EXPOSE 3777
CMD ["pnpm", "--filter", "@agentmesh/hub", "start"]
