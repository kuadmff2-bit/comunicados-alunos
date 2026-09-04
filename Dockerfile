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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /app/tokens
CMD ["npm", "start"]
