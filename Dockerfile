# Every dependency here is pure JavaScript (mongodb, bcryptjs, express, marked,
# multer), so alpine needs no build toolchain and the image stays small.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci installs the exact locked tree; --ignore-scripts blocks any dependency
# lifecycle script from running during the build.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:20-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=4000

WORKDIR /app
RUN addgroup -g 1001 bench && adduser -D -u 1001 -G bench bench

COPY --from=deps /app/node_modules ./node_modules
COPY package.json build.js ./
COPY server ./server
COPY src ./src
COPY public ./public

# Generate public/index.html from the single-file source at build time, so the
# served page can never drift from src/site.html.
RUN node build.js

RUN mkdir -p /data/uploads && chown -R bench:bench /data /app
USER bench

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/projects').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
