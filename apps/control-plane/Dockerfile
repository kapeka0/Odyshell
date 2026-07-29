FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
RUN pnpm install --no-frozen-lockfile
COPY packages/protocol packages/protocol
COPY apps/control-plane apps/control-plane
RUN pnpm --filter @odyshell/control-plane build

FROM node:24-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/apps/control-plane/package.json apps/control-plane/package.json
COPY --from=build /app/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/control-plane/node_modules apps/control-plane/node_modules
COPY --from=build /app/apps/control-plane/dist apps/control-plane/dist
USER node
EXPOSE 4100
CMD ["node", "apps/control-plane/dist/index.js"]
