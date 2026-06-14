FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/sfu/package.json apps/sfu/package.json
RUN pnpm install --filter @chatlive/sfu... --frozen-lockfile

FROM deps AS build
COPY apps/sfu apps/sfu
RUN pnpm --filter @chatlive/sfu build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/sfu/node_modules ./apps/sfu/node_modules
COPY --from=deps /app/apps/sfu/package.json ./apps/sfu/package.json
COPY --from=build /app/apps/sfu/dist ./apps/sfu/dist
EXPOSE 4000 40000-40100/udp 40000-40100/tcp
CMD ["node", "apps/sfu/dist/server.js"]
