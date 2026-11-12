FROM node:22-alpine

# Install ffmpeg for server-side remuxing and audio processing
RUN apk add --no-cache ffmpeg python3 bash

WORKDIR /app

# Install production dependencies first for optimal layer caching
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && \
    mkdir -p public/vendor data/anime-clips data/uploads data/exports data/presets/meadows && \
    cp node_modules/mp4-muxer/build/mp4-muxer.js public/vendor/mp4-muxer.js

# Copy application source
COPY server.js ./
COPY src ./src
COPY public ./public
COPY data/presets ./data/presets
COPY data/anime-library.json* ./data/

ENV NODE_ENV=production
ENV PORT=3450

EXPOSE 3450

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3450/api/session > /dev/null || exit 1

CMD ["node", "server.js"]
