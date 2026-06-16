FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Install ALL deps (incl. devDeps like typescript) so the build can run. Do NOT set
# NODE_ENV=production before this, or npm ci would omit devDependencies and tsc would
# be missing.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build

# Persisted Playwright session lives here.
RUN mkdir -p /app/storage
ENV NODE_ENV=production
ENV STORAGE_DIR=/app/storage
ENV CONFIG_PATH=/app/config/peoplestrong.yml
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
