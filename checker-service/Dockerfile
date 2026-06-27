FROM node:22-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
