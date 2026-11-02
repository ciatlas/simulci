# The simulci image: the web app and the server that serves it, one container (apps/server). With no GitHub App
# configured it serves the app alone, as the Vercel deployment does, with the same header table (apps/web/headers.ts).
# Configuration is by environment (PORT, PUBLIC_URL, GITHUB_URL, GITHUB_API_URL); /healthz answers ok.
#
#   docker build -t simulci . && docker run --rm --read-only -p 8080:8080 simulci

# Build: the web app (apps/web/dist) and the server's one-file bundle (apps/server/dist/server.mjs).
FROM node:24-trixie@sha256:8c761eca2bf7eec965f946cf47b8090143cb41f45f2f8699af0cc0298d2d2d19 AS build
WORKDIR /repo
# corepack installs the pnpm package.json names, without asking.
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# The packages first, from the lockfile alone, so a change to the sources reuses them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @simulci/web... --filter @simulci/server...
RUN pnpm --filter @simulci/web build && pnpm --filter @simulci/server build

# Run: Node on distroless, as nonroot, on a read-only root filesystem if the host likes. No HEALTHCHECK: an
# orchestrator asks /healthz.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba
LABEL org.opencontainers.image.title="simulci" \
      org.opencontainers.image.description="Simulate GitHub Actions workflows in the browser: the simulci web app and its server." \
      org.opencontainers.image.source="https://github.com/ciatlas/simulci" \
      org.opencontainers.image.licenses="FSL-1.1-MIT AND MIT"
WORKDIR /app
COPY --from=build /repo/apps/server/dist/server.mjs server.mjs
COPY --from=build /repo/apps/web/dist public
ENV NODE_ENV=production
EXPOSE 8080
CMD ["/app/server.mjs"]
