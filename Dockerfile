FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build

# Persisted session + downloads + error screenshots.
RUN mkdir -p /app/storage
ENV STORAGE_DIR=/app/storage
ENV CONFIG_PATH=/app/config/peoplestrong.yml
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
