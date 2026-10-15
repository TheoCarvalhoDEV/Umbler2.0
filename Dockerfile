# syntax=docker/dockerfile:1

# --- build: instala tudo, compila só o web (o server roda com tsx), remove dependências de desenvolvimento ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build -w web && npm prune --omit=dev

# --- runtime ---
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    MEDIA_DIR=/data/media \
    WEB_DIST_DIR=/app/web/dist
WORKDIR /app
# ponytail: copies the whole pruned workspace (server runs from source via tsx). Trim web/src etc. if image size ever matters.
COPY --from=build /app /app
# /data também do node: o importador grava /data/import-report.json ao lado de /data/media.
RUN mkdir -p /data/media && chown node:node /data /data/media
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "server/src/index.ts"]
