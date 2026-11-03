# Baut App (dist/) und Server (dist-server/) und startet den Node-Server auf Port 8080.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG GIT_SHA=lokal
ENV GIT_SHA=$GIT_SHA
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 STATIC_DIR=/app/dist
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/dist-server ./dist-server
COPY package.json ./
USER node
EXPOSE 8080
CMD ["node", "dist-server/server.mjs"]
