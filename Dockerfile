FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
RUN apk upgrade --no-cache
ENV NODE_ENV=production PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./
RUN mkdir -p /data/photos && chown node:node /data/photos
ENV PHOTO_DIR=/data/photos
VOLUME /data/photos
EXPOSE 8080
USER node
CMD ["node", "dist/server.js"]
