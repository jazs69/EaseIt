# syntax=docker/dockerfile:1.7
#
# EaseIt production images (CI-14). One Dockerfile, one target per image:
#
#   api            the NestJS API; the same image runs the worker
#                  (`node dist/worker.js`)
#   ops            migrations, reference data, the app database role and
#                  property provisioning (`deploy/ops.sh`)
#   web-admin      staff dashboard        (Next.js standalone server)
#   web-booking    public booking engine  (Next.js standalone server)
#   web-marketing  marketing site         (Next.js standalone server)
#
# The NEXT_PUBLIC_* values are compiled into the browser bundles by Next, so
# they are build arguments, not runtime settings: an image is built for one
# deployment's public URLs. The API and ops images do not use them.
#
#   docker build --target api -t easeit-api \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com .

ARG NODE_VERSION=24.14.1

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.14.4 --activate
WORKDIR /repo

# ---------------------------------------------------------------------------
# Install once from the lockfile, build every package and app.
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --offline

ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_ADMIN_URL
ARG NEXT_PUBLIC_MARKETING_URL
ARG NEXT_PUBLIC_AUTH_COOKIE_NAME=easeit_session
# A web image built without its API address would silently call
# http://localhost:4000 from every guest's browser; refuse instead.
RUN test -n "$NEXT_PUBLIC_API_URL" || (echo "build arg NEXT_PUBLIC_API_URL is required" >&2; exit 1)
ENV NEXT_OUTPUT=standalone \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_ADMIN_URL=${NEXT_PUBLIC_ADMIN_URL} \
    NEXT_PUBLIC_MARKETING_URL=${NEXT_PUBLIC_MARKETING_URL} \
    NEXT_PUBLIC_AUTH_COOKIE_NAME=${NEXT_PUBLIC_AUTH_COOKIE_NAME}
RUN pnpm turbo run build

# Self-contained trees: production dependencies only for the API, the
# database package with its CLI tooling for ops.
RUN pnpm --filter @repo/api --prod deploy /out/api \
 && pnpm --filter @repo/database deploy /out/ops/packages/database \
 && mkdir -p /out/ops/scripts /out/ops/deploy \
 && cp scripts/db-app-role.mjs /out/ops/scripts/ \
 && cp deploy/ops.sh /out/ops/deploy/

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS api
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS ops
ENV NODE_ENV=production
# The Prisma migration engine needs OpenSSL; the slim base has none. The API
# image does not: it reaches PostgreSQL through the pg driver adapter.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /ops
COPY --from=build --chown=node:node /out/ops ./
RUN chmod +x deploy/ops.sh
USER node
ENTRYPOINT ["/ops/deploy/ops.sh"]
CMD ["migrate"]

# ---------------------------------------------------------------------------
# The three Next.js apps share one runtime shape: the standalone server, its
# static assets beside it, and the app's public directory.
FROM node:${NODE_VERSION}-bookworm-slim AS next-runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
USER node
EXPOSE 3000

FROM next-runtime AS web-admin
COPY --from=build --chown=node:node /repo/apps/web-admin/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web-admin/.next/static ./apps/web-admin/.next/static
COPY --from=build --chown=node:node /repo/apps/web-admin/public ./apps/web-admin/public
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "apps/web-admin/server.js"]

FROM next-runtime AS web-booking
COPY --from=build --chown=node:node /repo/apps/web-booking/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web-booking/.next/static ./apps/web-booking/.next/static
COPY --from=build --chown=node:node /repo/apps/web-booking/public ./apps/web-booking/public
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "apps/web-booking/server.js"]

FROM next-runtime AS web-marketing
COPY --from=build --chown=node:node /repo/apps/web-marketing/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web-marketing/.next/static ./apps/web-marketing/.next/static
COPY --from=build --chown=node:node /repo/apps/web-marketing/public ./apps/web-marketing/public
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "apps/web-marketing/server.js"]
