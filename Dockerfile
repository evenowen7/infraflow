FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/adapters/package.json packages/adapters/package.json
RUN npm ci
COPY . .
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN npm run build
FROM build AS server
ENV API_HOST=0.0.0.0
EXPOSE 3001
USER node
CMD ["node", "dist/apps/api/src/index.js"]
FROM nginx:stable-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
