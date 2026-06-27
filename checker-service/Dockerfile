FROM node:22-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium
RUN apt-get update \
  && apt-get install -y --no-install-recommends xvfb \
  && rm -rf /var/lib/apt/lists/*

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV HEADLESS=false
ENV CHALLENGE_WAIT_MS=60000

EXPOSE 3000

CMD ["xvfb-run", "-a", "node", "src/server.js"]
