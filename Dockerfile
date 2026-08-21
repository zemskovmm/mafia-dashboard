FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/game-domain/package.json packages/game-domain/package.json
RUN npm ci

COPY tsconfig.base.json eslint.config.js .prettierrc.json ./
COPY apps apps
COPY packages packages
ARG VITE_YOUTUBE_PLAYLIST_ID=""
ENV VITE_YOUTUBE_PLAYLIST_ID=${VITE_YOUTUBE_PLAYLIST_ID}
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATIC_DIR=/app/apps/web/dist

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/game-domain/package.json ./packages/game-domain/package.json
COPY --from=build --chown=node:node /app/packages/game-domain/dist ./packages/game-domain/dist

USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]
