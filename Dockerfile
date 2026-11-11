# The image FAF's cluster runs (gitops-stack, apps/faf-webclient).
#
# The website is built here from web/, so the image always matches the source,
# whatever state the committed public/ folder is in. The committed public/ is
# only for running straight from a git clone (docker-compose.yml).

FROM node:24-alpine AS site
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
# Type-checks, then writes the site into /build/public (vite.config.ts).
RUN npm run build

# The server has zero runtime dependencies, so no npm install here.
FROM node:24-alpine
WORKDIR /srv/app
COPY package.json server.js ./
COPY lib ./lib
COPY --from=site /build/public ./public

ENV PORT=8098 \
    NODE_ENV=production
USER node
EXPOSE 8098
CMD ["node", "server.js"]
