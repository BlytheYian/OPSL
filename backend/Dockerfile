FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY tsconfig.json ./
COPY src src
COPY init.sql ./init.sql

RUN npm install
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/init.sql ./init.sql

EXPOSE 3000
CMD ["node", "dist/server.js"]
