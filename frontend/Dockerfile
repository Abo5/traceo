# Traceo frontend — FR-081 (on-premise deployment).
#
# Three stages: install deps, build the standalone bundle, then ship only that
# bundle. Requires `output: "standalone"` in next.config.mjs.

FROM node:22-alpine AS deps
WORKDIR /app
# Lockfile-only layer so npm ci is cached until dependencies actually change.
COPY package.json package-lock.json* ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, so the
# API URL cannot be changed by an env var at run time — it must be passed here.
# Default matches a compose deployment where the browser reaches the backend on
# the host's port 8000.
ARG NEXT_PUBLIC_API="http://localhost:8000/v1"
ENV NEXT_PUBLIC_API=$NEXT_PUBLIC_API
RUN npm run build

FROM node:22-alpine
RUN addgroup -g 10001 nodejs && adduser -D -u 10001 -G nodejs nextjs
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0

COPY --from=build /app/public ./public
# The standalone output already contains a minimal node_modules and server.js.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
