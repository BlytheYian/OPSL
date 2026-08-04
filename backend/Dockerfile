FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.json ./
COPY src src
COPY init.sql ./init.sql

ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm install
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/init.sql ./init.sql

EXPOSE 3000
CMD ["node", "dist/server.js"]
