FROM node:22-alpine AS base
WORKDIR /app

# --- Build client ---
FROM base AS client-build
COPY tsconfig.json ./tsconfig.json
COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm install
COPY client/ ./client/
RUN cd client && npm run build

# --- Build server ---
FROM base AS server-build
COPY tsconfig.json ./tsconfig.json
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install
COPY server/ ./server/
RUN cd server && npm run build

# --- Production ---
FROM node:22-alpine AS production
RUN apk add --no-cache curl chromium nss freetype harfbuzz ca-certificates ttf-freefont tzdata \
    xvfb fluxbox novnc websockify x11vnc \
  && addgroup -S app \
  && adduser -S -G app -h /home/app app
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV HOME=/home/app
WORKDIR /app

COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

# Create image proxy cache directory
RUN mkdir -p /tmp/img-cache /home/app/.cache
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=server-build /app/server/src/db/migrations ./server/dist/db/migrations
COPY --from=client-build /app/client/dist ./server/public
COPY scripts/ ./scripts/
RUN mkdir -p /app/runtime/reuters-cookie \
  && chown -R app:app /app /tmp/img-cache /home/app \
  && chmod 700 /tmp/img-cache /app/runtime/reuters-cookie

WORKDIR /app/server

EXPOSE 3000

USER app

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
