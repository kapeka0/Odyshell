FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY packages/protocol packages/protocol
COPY apps/web apps/web
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    BETTER_AUTH_SECRET=build-only-identity-secret-000000000 \
    BETTER_AUTH_URL=http://localhost:3000 \
    NEXT_PUBLIC_ODYSHELL_SERVER_URL=http://localhost:4100 \
    pnpm --filter @odyshell/web build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
COPY --from=build /app/apps/web/public apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
