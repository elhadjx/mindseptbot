# Stage 1 - build the admin panel.
FROM node:20-bookworm-slim AS admin-build
WORKDIR /app/admin
COPY admin/package*.json ./
RUN npm install
COPY admin/ ./
RUN npm run build

# Stage 2 - runtime.
FROM node:20-bookworm-slim

# whatsapp-web.js drives a real browser through Puppeteer, so the image needs a
# Chromium plus its font and shared-library dependencies. Installing Debian's
# chromium is smaller and better patched than letting Puppeteer download its own.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libnspr4 \
      libnss3 \
      libx11-6 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY --from=admin-build /app/admin/dist ./admin/dist

# Chromium refuses to run as root without --no-sandbox; we pass that flag anyway,
# but dropping privileges is still worth doing. RemoteAuth needs a writable
# scratch dir it can zip the session from before uploading to Mongo.
RUN useradd --create-home --shell /bin/bash app \
    && mkdir -p /tmp/.wwebjs_auth \
    && chown -R app:app /app /tmp/.wwebjs_auth
USER app

EXPOSE 3000
CMD ["node", "src/index.js"]
