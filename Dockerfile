FROM node:22-alpine

WORKDIR /app

# Install dependencies before copying source so the layer is cached on source-only changes.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the application source (see .dockerignore for exclusions).
COPY . .

# The SQLite database lives on a mounted volume so writes survive restarts.
ENV NODE_ENV=production \
    PORT=3000 \
    DOCKET_DB=/data/docket.db

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# The app auto-seeds demo data on first boot when the database is empty.
CMD ["node", "--experimental-sqlite", "--no-warnings", "server.js"]
