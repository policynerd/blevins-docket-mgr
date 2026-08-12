# The rebuild: Next.js and the Fastify API in one image, one Fly app.
#
# One app rather than two because the browser must see a single origin. The
# session cookie is httpOnly and SameSite=Lax and the web app reaches the API
# through a same-origin `/api` rewrite; split across two public hostnames, the
# cookie stops being sent and the whole auth design needs reworking. Keeping
# both processes behind one hostname is what makes that free.

FROM node:22-bookworm-slim

# Chromium, because the PDF renderer drives a real browser — that is the whole
# point of the rendering approach and not something that can be stubbed out in
# production.
#
# fonts-liberation matters more than it looks. Liberation Serif and Liberation
# Sans are metric-compatible with Times New Roman and Arial, which is exactly
# why the stylesheets name them as fallbacks. Without them Chromium substitutes
# something arbitrary and every exported instrument silently changes shape.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fontconfig \
    ca-certificates \
    tini \
  && rm -rf /var/lib/apt/lists/*

# An explicit path wins over the revision-matching scan in findChromium(), so
# the image's Chromium is used rather than one Playwright would try to fetch.
ENV CHROMIUM_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
RUN corepack enable

# Manifests first, so a source-only change does not reinstall the world.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/akn/package.json packages/akn/
COPY packages/db/package.json packages/db/
COPY packages/pdf/package.json packages/pdf/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @blevins/web build

# Set after the build, not before: with NODE_ENV=production pnpm skips
# devDependencies, and the Next build needs TypeScript and the type packages.
ENV NODE_ENV=production

# Only the web port is published. The API listens on loopback and is reached
# solely through the Next rewrite, so it is not exposed to the internet at all.
ENV PORT=3100 \
    API_PORT=3200
EXPOSE 3100

# tini reaps the two children and forwards signals; without an init, a killed
# Chromium leaves zombies behind in a long-lived machine.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/start.sh"]
