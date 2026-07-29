FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/server/package.json apps/server/package.json
RUN pnpm install --no-frozen-lockfile
COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN pnpm --filter @odyshell/server build

FROM node:24-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/server/node_modules apps/server/node_modules
COPY --from=build /app/apps/server/dist apps/server/dist
USER node
EXPOSE 4100
CMD ["node", "apps/server/dist/index.js"]
