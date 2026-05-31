# syntax=docker/dockerfile:1.6
# ===========================================================================
# Evolution API — slim production image
# ---------------------------------------------------------------------------
# Optimized for low-RAM hosts (Dokploy / small VPS):
#   - Skips `tsc --noEmit` typecheck in the image (do that in CI, not on the
#     deploy host). Typecheck alone holds ~1.5GB of heap on this codebase.
#   - tsup is configured (see tsup.config.ts) to emit CJS only, no minify,
#     no sourcemap — that cuts build memory roughly in half.
#   - Final stage installs prod-only deps (no dev toolchain in the image).
# ===========================================================================

ARG NODE_IMAGE=node:24-alpine

# ------------------------------- builder ------------------------------------
FROM ${NODE_IMAGE} AS builder

# Build-time tools only. No `apk update` — `--no-cache` already refreshes.
RUN apk add --no-cache git bash openssl

WORKDIR /evolution

# Install deps first so this layer caches across source-only changes.
COPY package*.json ./
COPY patches ./patches
RUN npm ci --no-audit --no-fund --prefer-offline --silent \
 && npx patch-package

# Source + config needed to build.
COPY tsconfig.json tsup.config.ts runWithProvider.js ./
COPY src ./src
COPY public ./public
COPY prisma ./prisma
COPY manager ./manager
COPY Docker ./Docker
COPY .env.example ./.env

# Normalize shell scripts (Windows line endings would break them).
RUN apk add --no-cache dos2unix \
 && chmod +x ./Docker/scripts/* \
 && dos2unix ./Docker/scripts/* \
 && apk del dos2unix

# Prisma client generation (uses DATABASE_PROVIDER from .env).
RUN ./Docker/scripts/generate_database.sh

# Bundle. 1024MB heap cap is plenty without minify/ESM/sourcemap and keeps
# us safely under typical 2GB Dokploy VPS limits.
RUN NODE_OPTIONS="--max-old-space-size=1024" npx tsup

# Drop dev dependencies from the tree we'll ship.
RUN npm prune --omit=dev --silent

# -------------------------------- runtime -----------------------------------
FROM ${NODE_IMAGE} AS final

# Runtime needs: ffmpeg (audio/video), bash (entrypoint script),
# openssl (Prisma), tzdata (timezone).
RUN apk add --no-cache tzdata ffmpeg bash openssl

ENV TZ=America/Sao_Paulo \
    DOCKER_ENV=true \
    NODE_ENV=production

WORKDIR /evolution

COPY --from=builder /evolution/package.json       ./package.json
COPY --from=builder /evolution/package-lock.json  ./package-lock.json
COPY --from=builder /evolution/node_modules       ./node_modules
COPY --from=builder /evolution/dist               ./dist
COPY --from=builder /evolution/prisma             ./prisma
COPY --from=builder /evolution/manager            ./manager
COPY --from=builder /evolution/public             ./public
COPY --from=builder /evolution/.env               ./.env
COPY --from=builder /evolution/Docker             ./Docker
COPY --from=builder /evolution/runWithProvider.js ./runWithProvider.js

EXPOSE 8080

ENTRYPOINT ["/bin/bash", "-c", ". ./Docker/scripts/deploy_database.sh && npm run start:prod"]
