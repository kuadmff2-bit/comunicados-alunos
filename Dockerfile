FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=America/Manaus \
    CHROME_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
      tzdata \
      findutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /app/tokens

# O volume persistente pode guardar locks do Chromium de um container antigo.
# Removemos apenas os arquivos Singleton* antes de subir o robô; os tokens do WhatsApp permanecem intactos.
CMD ["sh", "-c", "TOKEN_DIR=${WPP_TOKEN_DIR:-/app/tokens}; mkdir -p \"$TOKEN_DIR\"; find \"$TOKEN_DIR\" -type f \\( -name 'SingletonLock' -o -name 'SingletonCookie' -o -name 'SingletonSocket' \\) -delete 2>/dev/null || true; find \"$TOKEN_DIR\" -type l \\( -name 'SingletonLock' -o -name 'SingletonCookie' -o -name 'SingletonSocket' \\) -delete 2>/dev/null || true; npm start"]
