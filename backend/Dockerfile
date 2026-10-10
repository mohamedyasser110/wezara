# PROD: backend image — root-context build (compose: context . + dockerfile ./backend/Dockerfile)
# so contracts/openapi.json ships inside the image for GET /api/v1/openapi.json.
FROM node:22-alpine AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/scripts ./scripts
COPY backend/assets ./assets
COPY contracts ./contracts
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
# DB_DRIVER=sqlite by default (zero-config file DB); set DB_DRIVER=mysql +
# MYSQL_HOST/USER/PASSWORD/DATABASE to use a shared server (see docs/MYSQL_MIGRATION.md).
ENV NODE_ENV=production \
    DB_DRIVER=sqlite \
    MYSQL_HOST= \
    MYSQL_PORT=3306 \
    MYSQL_USER= \
    MYSQL_PASSWORD= \
    MYSQL_DATABASE= \
    MYSQL_POOL_SIZE=10
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/contracts ./contracts
COPY --from=build /app/scripts ./scripts
# شعار الوزارة المضمّن في بريد المنصة الرسمي (cid:platform-logo)
COPY --from=build /app/assets ./assets
EXPOSE 4000
# SEED_ON_BOOT=0 by default in prod (config.ts) — enable manually first boot if empty DB
CMD ["node", "dist/index.js"]
