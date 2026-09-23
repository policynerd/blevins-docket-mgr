# The rebuild: Next.js and the Fastify API in one image, one Fly app.
#
# One app rather than two because the browser must see a single origin. The
# session cookie is httpOnly and SameSite=Lax and the web app reaches the API
# through a same-origin `/api` rewrite; split across two public hostnames, the
# cookie stops being sent and the whole auth design needs reworking.

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fontconfig \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/akn/package.json packages/akn/
COPY packages/db/package.json packages/db/
COPY packages/pdf/package.json packages/pdf/
# package.json pins Next 15.5.26; the committed lockfile still names ^15.1.3.
# Resolve against the registry at build time until a refreshed lockfile is committed.
RUN pnpm install --no-frozen-lockfile

COPY . .
RUN pnpm --filter @blevins/web build

ENV NODE_ENV=production
ENV PORT=3100 \
    API_PORT=3200
EXPOSE 3100

RUN chown -R node:node /app
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/start.sh"]
