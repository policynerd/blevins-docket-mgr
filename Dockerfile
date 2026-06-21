# Legislative Docket Manager — zero-dependency Node app.
# node:sqlite is built into Node core, so there is nothing to npm install.
FROM node:22-alpine

WORKDIR /app

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
