FROM node:22-alpine

WORKDIR /app

# The browser that prints the documents.
#
# The board letter, the minutes and the per-item report are set as HTML and
# printed by Chromium over the DevTools protocol (src/render.js). It is
# installed here rather than added to package.json deliberately: this
# application has one runtime dependency, and a browser is an image concern in
# the same way SQLite is — Node 22's built-in WebSocket is the whole client.
#
# The fonts are not optional. Alpine ships none, and Chromium renders a
# document in a font it cannot find as empty boxes — a packet of blank
# rectangles, produced without any error. Liberation covers the metric-
# compatible faces the stylesheet names first; Noto covers the rest, which for
# these documents means accented names, section marks and the em dashes the
# minutes are full of.
RUN apk add --no-cache chromium font-noto ttf-liberation

# Install dependencies before copying source so the layer is cached on source-only changes.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the application source (see .dockerignore for exclusions).
COPY . .

# The SQLite database lives on a mounted volume so writes survive restarts.
ENV NODE_ENV=production \
    PORT=3000 \
    DOCKET_DB=/data/docket.db \
    CHROMIUM_PATH=/usr/bin/chromium-browser

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# The app auto-seeds demo data on first boot when the database is empty.
CMD ["node", "--experimental-sqlite", "--no-warnings", "server.js"]
